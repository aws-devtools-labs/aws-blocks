//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import os

private let logger = Logger(subsystem: "com.aws.blocks.swift", category: "BlocksClient")

/// A JSON-RPC 2.0 client that communicates over HTTP.
///
/// Returns raw JSON `Data` from `execute()` — the generated code handles
/// deserialization and transferable hydration.
///
/// Generated APIs run on the one the generated `Blocks` owns:
/// ```swift
/// let blocks = Blocks()
/// let todos = try await blocks.api.listTodos(sortBy: nil)
/// ```
public final class BlocksClient: Sendable {

    /// Base host for localhost rewriting in transferable descriptors (e.g., WebSocket URLs).
    /// Only needed for a dev server started with `BLOCKS_DEV_HOST`: set it to the host the app reaches that server at.
    /// Default: "localhost" (no rewriting — works in Simulator).
    public static var baseHost: String {
        get { baseHostLock.withLock { $0 } }
        set { baseHostLock.withLock { $0 = newValue } }
    }

    // Not a stored static var: Swift 6 app code cannot reference one.
    private static let baseHostLock = OSAllocatedUnfairLock(initialState: "localhost")

    /// Base URL the client was constructed with — exposed for transferable
    /// hydration (e.g. `OIDCClient<Provider>.fromJSON(descriptor, baseUrl: client.baseUrl, ...)`).
    public var baseUrl: String { url }

    /// Token store used to hydrate `OIDCClient` transferables returned by this client.
    /// Defaults to in-memory storage; pass a Keychain-backed implementation, e.g.
    /// `Blocks(tokenStore: store)`, for session persistence across app restarts.
    public let tokenStore: TokenStore

    private let url: String
    /// The only path to the session; read by tests.
    let gate: SessionGate
    /// The one move of tokens saved under older keys per exchange path, shared by every OIDCClient on this client.
    private let legacyTokenAdoption = OSAllocatedUnfairLock<[String: Task<Void, Never>]>(initialState: [:])

    /// Stored cookies persisted in the Keychain so auth sessions survive app restarts.
    /// Shared across all BlocksClient instances.
    private static let cookieStore = KeychainCookieStore()

    /// Applies cookie attributes over `cookieStore`.
    private static let cookieJar = CookieJar(items: cookieStore)

    /// A `session` you pass stays yours; without one the client creates a session and invalidates it on close or release.
    public convenience init(
        url: String,
        session: URLSession? = nil,
        tokenStore: TokenStore = InMemoryTokenStore()
    ) {
        self.init(url: url, session: session ?? BlocksClient.makeSession(), ownsSession: session == nil, tokenStore: tokenStore)
    }

    /// Tests pass `ownsSession: true` to observe an owned session being invalidated.
    init(url: String, session: URLSession, ownsSession: Bool, tokenStore: TokenStore) {
        self.url = url
        self.gate = SessionGate(session: session, ownsSession: ownsSession)
        self.tokenStore = tokenStore
    }

    public convenience init(
        server: BlocksServer,
        session: URLSession? = nil,
        tokenStore: TokenStore = InMemoryTokenStore()
    ) {
        self.init(url: server.url, session: session, tokenStore: tokenStore)
    }

    /// Later requests throw `ClientClosedError`; in-flight ones finish, then the session this client created is invalidated.
    public func close() {
        gate.close()
    }

    /// Runs only the first caller's `move` for `exchangePath`; every later caller waits for that run instead.
    func adoptLegacyTokensOnce(for exchangePath: String, _ move: @escaping @Sendable () async -> Void) async {
        let adoption = legacyTokenAdoption.withLock { state in
            if let existing = state[exchangePath] { return existing }
            let started = Task { await move() }
            state[exchangePath] = started
            return started
        }
        await adoption.value
    }

    /// Clears all stored cookies (e.g. on sign-out).
    /// Since cookies are persisted in the Keychain, this ensures
    /// the user is fully logged out across app restarts.
    public static func clearCookies() {
        cookieStore.removeAll()
    }

    /// Creates a URLSession that never touches the system cookie store.
    private static func makeSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieAcceptPolicy = .never
        config.httpShouldSetCookies = false
        config.httpCookieStorage = nil
        // The CDK Blocks server reads x-blocks-user-agent.
        config.httpAdditionalHeaders = ["x-blocks-user-agent": blocksUserAgentToken]
        return URLSession(configuration: config)
    }

    /// Executes a JSON-RPC request and returns the raw JSON `Data` of the `result` field.
    /// The generated code is responsible for decoding this into typed models.
    ///
    /// The request is POSTed to `{url}/{namespace}` (e.g. `…/cdk-blocks/api/reports` for
    /// `reports.build`), so a namespace that runs on its own compute is served by it.
    ///
    /// Returns `nil` if the result is JSON `null`.
    public func execute(_ request: BlocksRequest) async throws -> Data? {
        // Validate the base first: appending the namespace can turn an invalid base (e.g. "")
        // into a relative URL that only fails later, as a transport error.
        guard URL(string: url) != nil,
              let requestURL = URL(string: BlocksClient.rpcURL(base: url, method: request.method))
        else {
            throw TransportError(message: "Invalid URL: \(url)")
        }

        var urlRequest = URLRequest(url: requestURL)
        urlRequest.httpMethod = "POST"
        urlRequest.httpShouldHandleCookies = false
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // Attach stored cookies (filtered by host, path, `Secure` and expiry)
        if let cookieHeader = BlocksClient.cookieJar.cookieHeader(for: requestURL) {
            urlRequest.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }

        // Encode request body (dates as ISO 8601 strings, see `makeEncoder()`)
        urlRequest.httpBody = try makeEncoder().encode(request)

        logger.debug("→ \(request.method) id=\(request.id)")

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await gate.send(urlRequest)
        } catch let error as ClientClosedError {
            throw error
        } catch let error as CancellationError {
            throw error
        } catch {
            throw TransportError(
                message: error.localizedDescription,
                statusCode: nil,
                underlyingError: error
            )
        }

        // Process Set-Cookie headers
        let httpResponse = response as? HTTPURLResponse
        if let httpResponse {
            processCookies(from: httpResponse, requestURL: requestURL)
        }
        let status = httpResponse?.statusCode

        // `nil` when the body is not a JSON object (not JSON at all, or a bare array or scalar).
        let responseJson = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]

        // A JSON-RPC error is decoded the same way whatever the HTTP status: a namespace
        // created with `httpErrorStatus: true` answers a 4xx with the same envelope as the
        // 200 it sends otherwise.
        if let errorObj = responseJson?["error"] as? [String: Any] {
            let errorData = errorObj["data"] as? [String: Any]
            let code = errorObj["code"] as? Int ?? -1
            // True only for the JSON boolean `true`. A plain `as? Bool` cast would also accept the
            // number 1 (and 0), because JSONSerialization hands back NSNumber for both.
            let retriable = errorData?["retriable"].flatMap(JSONValue.init(serialized:)) == .bool(true)
            throw ApiError(
                message: errorObj["message"] as? String ?? "Unknown error",
                status: code > 0 ? code : 500,
                name: errorData?["name"] as? String ?? reservedRpcErrorName(code),
                retriable: retriable
            )
        }

        if let status, !(200 ..< 300).contains(status) {
            // Not a JSON-RPC error (a gateway or route error such as `{ "error": "Not Found" }`,
            // or no JSON at all): a transport failure. API Gateway's own errors put their text
            // under `message` (a 504 `{ "message": "Endpoint request timed out" }`), so that is
            // read first, as the TypeScript client does; an empty string falls through.
            let message = [responseJson?["message"], responseJson?["error"]]
                .compactMap { $0 as? String }
                .first { !$0.isEmpty }
                ?? "HTTP \(status)"
            throw TransportError(message: message, statusCode: status)
        }

        // Only a JSON object that declares `jsonrpc: "2.0"` is an envelope.
        guard let json = responseJson, json["jsonrpc"] as? String == "2.0" else {
            throw TransportError(message: "Response was not a JSON-RPC envelope", statusCode: status)
        }

        // An explicit `null` result, or none at all: a void handler answers
        // `{"jsonrpc":"2.0","id":1}` because `JSON.stringify` drops `result: undefined`. Both are
        // `nil`; a method that returns a value fails on that through the generated null guard.
        guard let result = json["result"], !(result is NSNull) else {
            return nil
        }

        // Re-serialize just the "result" value to Data for the caller to decode

        // JSONSerialization only accepts arrays/objects as top-level values.
        // For primitives (String, Number, Bool), wrap in a JSON fragment manually.
        if JSONSerialization.isValidJSONObject(result) {
            return try JSONSerialization.data(withJSONObject: result)
        } else {
            // Primitive value — encode it as a JSON fragment via a single-element array,
            // then strip the surrounding brackets.
            let wrapped = try JSONSerialization.data(withJSONObject: [result])
            // "[\"hello\"]" → "\"hello\""
            // Strip first '[' and last ']'
            return wrapped.dropFirst().dropLast()
        }
    }

    /// The URL a call to `method` is POSTed to: `{base}/{namespace}`, where the namespace is the
    /// part of `method` before the first `.` — the path the TypeScript client uses, so the backend's
    /// gateway can route each namespace to the compute that hosts it. The body still carries the
    /// full `namespace.method`, which is what the server dispatches on. A `method` without a
    /// namespace goes to `base` unchanged.
    static func rpcURL(base: String, method: String) -> String {
        guard let dot = method.firstIndex(of: "."), dot != method.startIndex else { return base }
        let namespace = String(method[..<dot])
        let segment = namespace.addingPercentEncoding(withAllowedCharacters: pathSegmentAllowed) ?? namespace
        var trimmed = Substring(base)
        while trimmed.hasSuffix("/") {
            trimmed = trimmed.dropLast()
        }
        return "\(trimmed)/\(segment)"
    }

    /// Characters allowed in a single path segment: a path's characters, without its `/` separator.
    private static let pathSegmentAllowed = CharacterSet.urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))

    /// Base URL for raw routes — strips the RPC path suffix but keeps the stage prefix.
    /// Base URL for raw routes. Raw routes share the same origin and stage
    /// prefix as the RPC endpoint but sit outside the RPC path (`/cdk-blocks/api`).
    /// Derived by stripping the RPC path segments from the end of the URL.
    /// e.g. `https://host/prod/cdk-blocks/api` → `https://host/prod`
    ///      `http://localhost:3001/cdk-blocks/api` → `http://localhost:3001`
    /// The cut is at the first `cdk-blocks` (or legacy `aws-blocks`) segment, so a doubled `/cdk-blocks/api/cdk-blocks/api`
    /// gives the origin. A URL with no such segment is used as it is, without a trailing `/`.
    var rawRouteBase: String {
        // `URLComponents` keeps an IPv6 host's brackets and the path's percent-encoding as they were.
        guard var components = URLComponents(string: url), components.host != nil else { return url }
        let segments = components.percentEncodedPath.split(separator: "/")
        if let idx = segments.firstIndex(where: { $0 == "cdk-blocks" || $0 == "aws-blocks" }) {
            let kept = segments[..<idx]
            components.percentEncodedPath = kept.isEmpty ? "" : "/" + kept.joined(separator: "/")
            components.query = nil
            components.fragment = nil
            return components.string ?? url
        }
        var trimmed = Substring(url)
        while trimmed.hasSuffix("/") {
            trimmed = trimmed.dropLast()
        }
        return String(trimmed)
    }

    /// POST to a raw route (not JSON-RPC). Handles cookies automatically.
    /// With `emptyBodyIsEmptyObject`, an empty 2xx body reads as `{}` instead of failing to parse.
    func postRawRoute(path: String, body: [String: Any], emptyBodyIsEmptyObject: Bool = false) async throws -> [String: Any] {
        try await sendRawRoute(method: "POST", path: path, body: body, headers: [:], emptyBodyIsEmptyObject: emptyBodyIsEmptyObject).json
    }

    /// POST to a raw route, and also return the names of the cookies its response set.
    func postRawRouteRecordingCookies(path: String, body: [String: Any]) async throws -> (json: [String: Any], cookieNames: [String]) {
        try await sendRawRoute(method: "POST", path: path, body: body, headers: [:])
    }

    /// Removes the stored cookies named `names` that a request to the raw route `path` would send.
    func removeCookies(named names: [String], sentTo path: String) {
        guard !names.isEmpty, let url = URL(string: rawRouteBase + path) else { return }
        BlocksClient.cookieJar.remove(named: Set(names), sentTo: url)
    }

    /// GET a raw route (not JSON-RPC). Handles cookies automatically.
    func getRawRoute(path: String, headers: [String: String] = [:]) async throws -> [String: Any] {
        try await sendRawRoute(method: "GET", path: path, body: nil, headers: headers).json
    }

    private func sendRawRoute(
        method: String,
        path: String,
        body: [String: Any]?,
        headers: [String: String],
        emptyBodyIsEmptyObject: Bool = false
    ) async throws -> (json: [String: Any], cookieNames: [String]) {
        guard let requestURL = URL(string: rawRouteBase + path) else {
            throw TransportError(message: "Invalid URL: \(rawRouteBase + path)")
        }

        var urlRequest = URLRequest(url: requestURL)
        urlRequest.httpMethod = method
        urlRequest.httpShouldHandleCookies = false
        if let body {
            urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
            // Sorted keys, as `makeEncoder()` writes them: the same body is the same bytes every time.
            urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys])
        }
        for (name, value) in headers {
            urlRequest.setValue(value, forHTTPHeaderField: name)
        }

        // Attach stored cookies
        if let cookieHeader = BlocksClient.cookieJar.cookieHeader(for: requestURL) {
            urlRequest.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await gate.send(urlRequest)
        } catch let error as ClientClosedError {
            throw error
        } catch let error as CancellationError {
            throw error
        } catch {
            throw TransportError(
                message: error.localizedDescription,
                statusCode: nil,
                underlyingError: error
            )
        }

        // Store Set-Cookie headers
        var cookieNames: [String] = []
        if let httpResponse = response as? HTTPURLResponse {
            cookieNames = processCookies(from: httpResponse, requestURL: requestURL)
            // An error response is the server refusing the request, not a malformed success:
            // surface its status and error name instead of handing the error body to the caller.
            if !(200 ..< 300).contains(httpResponse.statusCode) {
                // CDK Blocks routes answer `{ error: <message>, name }`; a plain OAuth body is
                // `{ error: <code>, error_description }`.
                // A CDK Blocks body without a `name` (`{ error: 'Missing required fields' }`) holds a
                // message, so `error` is a name only beside `error_description` or when it reads
                // like a code (no spaces). Known approximation: a nameless one-word message
                // (`{ error: 'Unauthorized' }`) reads as a code and becomes the error name.
                //
                // A body that is not a JSON object (a gateway's HTML 502, say) is a transport
                // failure, as on the RPC path; only a JSON object is the server's own answer.
                guard let errorBody = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
                    throw TransportError(
                        message: "HTTP \(httpResponse.statusCode)",
                        statusCode: httpResponse.statusCode
                    )
                }
                let blocksName = errorBody["name"] as? String
                let error = errorBody["error"] as? String
                let description = errorBody["error_description"] as? String
                let errorIsCode = blocksName == nil
                    && error.map { description != nil || !$0.contains(" ") } == true
                let name = blocksName ?? (errorIsCode ? error : nil)
                // The server's own text, unchanged: its `error`, else its `error_description`.
                throw ApiError(
                    message: error ?? description ?? "HTTP \(httpResponse.statusCode)",
                    status: httpResponse.statusCode,
                    name: name
                )
            }
        }

        if emptyBodyIsEmptyObject, data.isEmpty {
            return ([:], cookieNames)
        }
        guard let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            throw TransportError(
                message: "Response from \(path) was not a JSON object",
                statusCode: (response as? HTTPURLResponse)?.statusCode
            )
        }
        return (json, cookieNames)
    }

    // MARK: - Cookie Handling

    /// Stores the response's cookies and returns the names of those it set to a value.
    @discardableResult
    private func processCookies(from response: HTTPURLResponse, requestURL: URL) -> [String] {
        var names: [String] = []
        for (key, value) in response.allHeaderFields {
            guard "\(key)".caseInsensitiveCompare("Set-Cookie") == .orderedSame else { continue }

            let rawCookies = splitSetCookieHeader("\(value)")

            // After a followed redirect, `response.url` is the URL the cookies came from.
            let responseURL = response.url ?? requestURL
            for rawCookie in rawCookies {
                BlocksClient.cookieJar.save(setCookie: rawCookie, requestURL: responseURL)
                if let cookie = StoredCookie(setCookie: rawCookie, requestURL: responseURL), !cookie.value.isEmpty {
                    names.append(cookie.name)
                }
            }
        }
        return names
    }

    private func splitSetCookieHeader(_ header: String) -> [String] {
        let segments = header.components(separatedBy: ", ")
        var cookies: [String] = []

        for segment in segments {
            let eqIndex = segment.firstIndex(of: "=")
            let semiIndex = segment.firstIndex(of: ";")

            let isNewCookie: Bool
            if let equals = eqIndex {
                isNewCookie = (semiIndex == nil || equals < semiIndex!)
            } else {
                isNewCookie = false
            }

            if cookies.isEmpty || isNewCookie {
                cookies.append(segment)
            } else {
                cookies[cookies.count - 1] += ", " + segment
            }
        }

        return cookies
    }

}

// MARK: - (BlocksError moved to BlocksError.swift)

/// Thrown by a request made after `BlocksClient.close()` or the generated `Blocks.close()`.
public struct ClientClosedError: BlocksError {
    public let message = "This BlocksClient is closed; create a new Blocks to make requests."

    public init() {}
}
