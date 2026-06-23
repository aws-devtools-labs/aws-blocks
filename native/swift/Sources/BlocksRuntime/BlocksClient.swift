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
/// Usage (from generated code):
/// ```swift
/// let client = BlocksClient(url: "http://localhost:3001/api")
/// let request = BlocksRequest(method: "api.createTodo", params: [title, priority], id: BlocksRequest.nextId())
/// let result = try await client.execute(request)
/// return Cursor.fromJson(result)
/// ```
public final class BlocksClient {

    /// Base host for localhost rewriting in transferable descriptors (e.g., WebSocket URLs).
    /// Set to your Mac's LAN IP for physical device testing.
    /// Default: "localhost" (no rewriting — works in Simulator).
    public static var baseHost: String = "localhost"

    /// Base URL the client was constructed with — exposed for transferable
    /// hydration (e.g. `OIDCClient.fromJSON(descriptor, baseUrl: client.baseUrl, ...)`).
    public var baseUrl: String { url }

    /// Token store used to hydrate `OIDCClient` transferables returned by this client.
    /// Defaults to in-memory storage; pass a Keychain-backed implementation for
    /// session persistence across app restarts.
    public let tokenStore: TokenStore

    private let url: String
    private let session: URLSession

    /// Stored cookies persisted in the Keychain so auth sessions survive app restarts.
    /// Shared across all BlocksClient instances.
    private static let cookieStore = KeychainCookieStore()

    public init(
        url: String,
        session: URLSession? = nil,
        tokenStore: TokenStore = InMemoryTokenStore()
    ) {
        self.url = url
        self.session = session ?? BlocksClient.makeSession()
        self.tokenStore = tokenStore
    }

    public convenience init(
        server: BlocksServer,
        session: URLSession? = nil,
        tokenStore: TokenStore = InMemoryTokenStore()
    ) {
        self.init(url: server.url, session: session, tokenStore: tokenStore)
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
        return URLSession(configuration: config)
    }

    /// Executes a JSON-RPC request and returns the raw JSON `Data` of the `result` field.
    /// The generated code is responsible for decoding this into typed models.
    ///
    /// Returns `nil` if the result is JSON `null`.
    public func execute(_ request: BlocksRequest) async throws -> Data? {
        guard let requestURL = URL(string: url) else {
            throw RPCError(message: "Invalid URL: \(url)")
        }

        var urlRequest = URLRequest(url: requestURL)
        urlRequest.httpMethod = "POST"
        urlRequest.httpShouldHandleCookies = false
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")

        // Attach stored cookies (filtered by host)
        let allCookies = BlocksClient.cookieStore.loadAll()
        let hostPrefix = "\(host)|"
        let cookies = allCookies
            .filter { $0.key.hasPrefix(hostPrefix) }
            .map { (String($0.key.dropFirst(hostPrefix.count)), $0.value) }

        if !cookies.isEmpty {
            let cookieHeader = cookies.map { "\($0.0)=\($0.1)" }.joined(separator: "; ")
            urlRequest.setValue(cookieHeader, forHTTPHeaderField: "Cookie")
        }

        // Encode request body
        urlRequest.httpBody = try JSONEncoder().encode(request)

        logger.debug("→ \(request.method) id=\(request.id)")

        let (data, response) = try await session.data(for: urlRequest)

        // Process Set-Cookie headers
        if let httpResponse = response as? HTTPURLResponse {
            processCookies(from: httpResponse)
        }

        // Parse response to check for errors (minimal parsing)
        guard let responseJson = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RPCError(message: "Invalid JSON response")
        }

        // Check for JSON-RPC "error" field
        if let errorObj = responseJson["error"] as? [String: Any] {
            let message = errorObj["message"] as? String ?? "Unknown error"
            let code = errorObj["code"] as? Int ?? -1
            throw RPCError(message: "Error occured with code: \(code) message: \(message)")
        }

        // Check HTTP status
        if let httpResponse = response as? HTTPURLResponse, !(200 ..< 300).contains(httpResponse.statusCode) {
            throw RPCError(message: "HTTP Error: \(httpResponse.statusCode)")
        }

        // Check for null result
        if responseJson["result"] is NSNull {
            return nil
        }

        // Re-serialize just the "result" value to Data for the caller to decode
        guard let result = responseJson["result"] else {
            throw RPCError(message: "Missing result field in JSON-RPC response")
        }

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

    private var host: String {
        URL(string: url)?.host ?? "unknown"
    }

    /// Base URL for raw routes — strips the RPC path suffix but keeps the stage prefix.
    /// Base URL for raw routes. Raw routes share the same origin and stage
    /// prefix as the RPC endpoint but sit outside the RPC path (`/aws-blocks/api`).
    /// Derived by stripping the RPC path segments from the end of the URL.
    /// e.g. `https://host/prod/aws-blocks/api` → `https://host/prod`
    ///      `http://localhost:3001/aws-blocks/api` → `http://localhost:3001`
    var rawRouteBase: String {
        guard let parsed = URL(string: url) else { return url }
        let pathComponents = parsed.pathComponents.filter { $0 != "/" }
        // Find where "aws-blocks" starts in the path and drop from there
        if let idx = pathComponents.firstIndex(of: "aws-blocks") {
            let keepComponents = pathComponents[..<idx]
            let scheme = parsed.scheme ?? "https"
            let host = parsed.host ?? "localhost"
            let port = parsed.port.map { ":\($0)" } ?? ""
            let basePath = keepComponents.isEmpty ? "" : "/" + keepComponents.joined(separator: "/")
            return "\(scheme)://\(host)\(port)\(basePath)"
        }
        return url
    }

    /// POST to a raw route (not JSON-RPC). Handles cookies automatically.
    func postRawRoute(path: String, body: [String: Any]) async throws -> [String: Any] {
        guard let requestURL = URL(string: rawRouteBase + path) else {
            throw RawRouteError(message: "Invalid URL: \(rawRouteBase + path)")
        }

        var urlRequest = URLRequest(url: requestURL)
        urlRequest.httpMethod = "POST"
        urlRequest.httpShouldHandleCookies = false
        urlRequest.setValue("application/json", forHTTPHeaderField: "Content-Type")
        urlRequest.httpBody = try JSONSerialization.data(withJSONObject: body)

        // Attach stored cookies
        let reqHost = requestURL.host ?? ""
        let allCookies = BlocksClient.cookieStore.loadAll()
        let hostPrefix = "\(reqHost)|"
        let cookies = allCookies
            .filter { $0.key.hasPrefix(hostPrefix) }
            .map { "\(String($0.key.dropFirst(hostPrefix.count)))=\($0.value)" }
        if !cookies.isEmpty {
            urlRequest.setValue(cookies.joined(separator: "; "), forHTTPHeaderField: "Cookie")
        }

        let (data, response) = try await session.data(for: urlRequest)

        // Store Set-Cookie headers
        if let httpResponse = response as? HTTPURLResponse {
            processCookies(from: httpResponse)
        }

        guard let json = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw RawRouteError(message: "Invalid JSON response from \(path)")
        }
        return json
    }

    // MARK: - Cookie Handling

    private func processCookies(from response: HTTPURLResponse) {
        for (key, value) in response.allHeaderFields {
            guard "\(key)".caseInsensitiveCompare("Set-Cookie") == .orderedSame else { continue }

            let rawCookies = splitSetCookieHeader("\(value)")

            for rawCookie in rawCookies {
                let segments = rawCookie.split(separator: ";", maxSplits: 1)
                guard let nameValuePart = segments.first else { continue }
                guard let eqIdx = nameValuePart.firstIndex(of: "=") else { continue }

                let name = String(nameValuePart[nameValuePart.startIndex ..< eqIdx])
                    .trimmingCharacters(in: .whitespaces)
                let val_ = String(nameValuePart[nameValuePart.index(after: eqIdx)...])
                    .trimmingCharacters(in: .whitespaces)

                let cookieKey = "\(host)|\(name)"
                let attrs = segments.count > 1 ? String(segments[1]).lowercased() : ""
                if val_.isEmpty || attrs.contains("max-age=0") {
                    BlocksClient.cookieStore.remove(name: cookieKey)
                } else {
                    BlocksClient.cookieStore.set(name: cookieKey, value: val_)
                }
            }
        }
    }

    private func splitSetCookieHeader(_ header: String) -> [String] {
        let segments = header.components(separatedBy: ", ")
        var cookies: [String] = []

        for segment in segments {
            let eqIndex = segment.firstIndex(of: "=")
            let semiIndex = segment.firstIndex(of: ";")

            let isNewCookie: Bool
            if let eq = eqIndex {
                isNewCookie = (semiIndex == nil || eq < semiIndex!)
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

/// Error thrown when the server returns a JSON-RPC error or HTTP failure.
public struct RPCError: BlocksError {
    public let message: String
    public let underlyingError: Error?

    public init(message: String, underlyingError: Error? = nil) {
        self.message = message
        self.underlyingError = underlyingError
    }
}

/// Error thrown by raw route (non-RPC) requests.
public struct RawRouteError: BlocksError {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}
