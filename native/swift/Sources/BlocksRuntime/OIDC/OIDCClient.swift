//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import CryptoKit

/// A provider an `OIDCClient` signs in with: the enum generated from the spec's provider names, or
/// `String` when the spec doesn't name them.
public protocol OIDCProviderName: Sendable {
    /// The name the server knows the provider by.
    var providerName: String { get }
}

public extension OIDCProviderName where Self: RawRepresentable, RawValue == String {
    var providerName: String { rawValue }
}

extension String: OIDCProviderName {
    public var providerName: String { self }
}

/// Server-relay OIDC client. Delegates networking to `BlocksClient` so
/// cookies are shared automatically. Implements the relay sign-in flow:
/// fetches signed authorize params from the server, opens the IdP in a
/// browser, and exchanges the authorization code for tokens.
///
/// `Provider` is the type `signIn` takes: the generated provider enum, so a
/// client only accepts its own providers, or `String` for an untyped spec.
///
/// All mutable state is protected by actor isolation.
public actor OIDCClient<Provider: OIDCProviderName>: AuthProvider {

    public nonisolated let exchangePath: String
    public nonisolated let refreshPath: String
    public nonisolated let signOutPath: String
    public nonisolated let providers: [String]
    public nonisolated let providerConfigs: [String: OIDCProviderConfig]
    public nonisolated let baseUrl: String

    nonisolated let client: BlocksClient
    private var tokenStore: TokenStore { client.tokenStore }

    /// The routes' base, the directory of `callbackPath`, for a client built with `forAuth`.
    /// `nil` for a client built with `init` or `fromJSON`, which derives its routes from `exchangePath`.
    nonisolated let routeBase: String?
    /// The IdP `redirect_uri` path, for a client built with `forAuth`.
    nonisolated let callbackPath: String?
    /// The `relayTo` that `signIn(provider:launcher:)` uses.
    nonisolated let relayTo: String?

    /// The descriptor this client was hydrated from, as the server sent it. `nil` for a client built with `init`.
    /// `encode(to:)` writes it back unchanged.
    nonisolated let wireDescriptor: [String: JSONValue]?

    private var inflightRefresh: Task<Void, Error>?
    private var subscribers: [UUID: AsyncStream<OIDCAuthState>.Continuation] = [:]

    public init(
        exchangePath: String,
        refreshPath: String,
        signOutPath: String,
        providers: [String],
        providerConfigs: [String: OIDCProviderConfig],
        baseUrl: String,
        client: BlocksClient
    ) {
        self.init(
            exchangePath: exchangePath,
            refreshPath: refreshPath,
            signOutPath: signOutPath,
            providers: providers,
            providerConfigs: providerConfigs,
            baseUrl: baseUrl,
            client: client,
            wireDescriptor: nil
        )
    }

    init(
        exchangePath: String,
        refreshPath: String,
        signOutPath: String,
        providers: [String],
        providerConfigs: [String: OIDCProviderConfig],
        baseUrl: String,
        client: BlocksClient,
        wireDescriptor: [String: JSONValue]?,
        routeBase: String? = nil,
        callbackPath: String? = nil,
        relayTo: String? = nil
    ) {
        self.exchangePath = exchangePath
        self.refreshPath = refreshPath
        self.signOutPath = signOutPath
        self.providers = providers
        self.providerConfigs = providerConfigs
        self.baseUrl = baseUrl
        self.client = client
        self.wireDescriptor = wireDescriptor
        self.routeBase = routeBase
        self.callbackPath = callbackPath
        self.relayTo = relayTo
    }

    /// Why `forAuth` refuses these paths, or `nil` when they are valid.
    static func authPathsProblem(callbackPath: String, signOutPath: String) -> String? {
        let prefix = "/aws-blocks/auth/"
        for (name, path) in [("callbackPath", callbackPath), ("signOutPath", signOutPath)] where !path.hasPrefix(prefix) {
            return "OIDCClient.forAuth: \(name) must start with '\(prefix)', got '\(path)'"
        }
        let rest = callbackPath.dropFirst(prefix.count)
        if rest.isEmpty || rest.hasSuffix("/") {
            return "OIDCClient.forAuth: callbackPath needs a segment after '\(prefix)' and no trailing '/', got '\(callbackPath)'"
        }
        return nil
    }

    /// Returns a fresh stream of auth-state transitions. Every active
    /// subscriber receives every emitted state. Emits on sign-in and sign-out.
    /// The client doesn't emit `.loading`: it is the state an app shows until
    /// `restore()` returns.
    ///
    /// The async signature ensures the subscriber is registered with the
    /// actor *before* the call returns — callers can safely kick off an
    /// auth action immediately after `let stream = await client.authStateChanges()`
    /// without missing the resulting state event.
    public func authStateChanges() -> AsyncStream<OIDCAuthState> {
        let id = UUID()
        let stream = AsyncStream<OIDCAuthState> { continuation in
            self.subscribers[id] = continuation
            continuation.onTermination = { [weak self] _ in
                guard let self else { return }
                Task { await self.removeSubscriber(id: id) }
            }
        }
        return stream
    }

    private func removeSubscriber(id: UUID) {
        subscribers.removeValue(forKey: id)
    }

    private func emit(_ state: OIDCAuthState) {
        for continuation in subscribers.values {
            continuation.yield(state)
        }
    }

    // MARK: - PKCE

    public static func generateVerifier() -> String {
        var bytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        // Fail closed: never return the zero-filled buffer when the system RNG call fails.
        // Traps like the standard library's SystemRandomNumberGenerator, keeping this API non-throwing.
        guard status == errSecSuccess else {
            fatalError("SecRandomCopyBytes failed with OSStatus \(status)")
        }
        return base64URLEncode(Data(bytes))
    }

    public static func generateNonce() -> String {
        generateVerifier()
    }

    public static func generateChallenge(_ verifier: String) -> String {
        let digest = SHA256.hash(data: Data(verifier.utf8))
        return base64URLEncode(Data(digest))
    }

    private static func base64URLEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    // MARK: - Sign In

    /// Sign in through the server relay, back to the `relayTo` this client was built with
    /// (`forAuth(client:providers:relayTo:)`).
    ///
    /// - Throws: `OIDCError.unknownProvider` for a provider the client wasn't built with, and
    ///   `OIDCConfigurationError` when the client has no `relayTo`, both before any request.
    public func signIn(provider: Provider, launcher: BrowserLauncher) async throws -> OIDCUser {
        guard providers.contains(provider.providerName) else {
            throw OIDCError.unknownProvider(provider.providerName)
        }
        guard let relayTo, !relayTo.isEmpty else {
            throw OIDCConfigurationError(
                message: "OIDCClient has no relayTo: pass relayTo to forAuth (a custom scheme listed in the "
                    + "backend's redirects.allowedRelayOrigins), or call signIn(provider:relayTo:launcher:)"
            )
        }
        return try await signIn(provider: provider, relayTo: relayTo, launcher: launcher)
    }

    /// Sign in using the server-relay flow.
    /// The server signs the state envelope and the IdP redirects to the
    /// server's callback, which then 302s to the app's `relayTo` scheme.
    public func signIn(
        provider: Provider,
        relayTo: String,
        launcher: BrowserLauncher
    ) async throws -> OIDCUser {
        let provider = provider.providerName
        guard providers.contains(provider) else {
            throw OIDCError.unknownProvider(provider)
        }

        let csrf = Self.generateVerifier()
        let verifier = Self.generateVerifier()
        let challenge = Self.generateChallenge(verifier)

        // Step 1: Fetch signed authorize params from server
        // Raw routes are mounted at the gateway root, not under the RPC prefix.
        let authorizeParamsPath = if let routeBase {
            "\(routeBase)/authorize-params/\(Self.encodeURIComponent(provider))"
        } else {
            exchangePath.replacingOccurrences(of: "/exchange", with: "/authorize-params/\(provider)")
        }
        let paramsBody: [String: Any] = ["csrf": csrf, "relayTo": relayTo]
        let paramsJSON = try await client.postRawRoute(path: authorizeParamsPath, body: paramsBody)

        guard let authorizeUrl = paramsJSON["authorizeUrl"] as? String,
              let clientId = paramsJSON["clientId"] as? String,
              let scopes = paramsJSON["scopes"] as? [String],
              let signedState = paramsJSON["state"] as? String else {
            throw OIDCError.callbackError("authorize-params response: \(paramsJSON)")
        }
        let nonce = paramsJSON["nonce"] as? String

        // Step 2: Build full authorize URL with server's callback as redirect_uri
        let callbackPath = callbackPath ?? exchangePath.replacingOccurrences(of: "/exchange", with: "/callback")
        let serverCallbackUrl = client.rawRouteBase + callbackPath

        guard var components = URLComponents(string: authorizeUrl) else {
            throw OIDCError.invalidAuthorizeURL(authorizeUrl)
        }
        var queryItems = components.queryItems ?? []
        queryItems.append(contentsOf: [
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: serverCallbackUrl),
            URLQueryItem(name: "scope", value: scopes.joined(separator: " ")),
            URLQueryItem(name: "state", value: signedState),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256")
        ])
        if let nonce { queryItems.append(URLQueryItem(name: "nonce", value: nonce)) }
        components.queryItems = queryItems

        guard let fullAuthorizeURL = components.url else {
            throw OIDCError.invalidAuthorizeURL(authorizeUrl)
        }

        // Step 3: Open browser — server relays back to relayTo scheme
        let relayScheme = URLComponents(string: relayTo)?.scheme ?? ""
        let resultURL = try await launcher.launch(
            authorizeURL: fullAuthorizeURL,
            callbackScheme: relayScheme
        )

        // Step 4: Parse callback
        let resultComponents = URLComponents(url: resultURL, resolvingAgainstBaseURL: false)
        let resultParams = Dictionary(
            uniqueKeysWithValues: (resultComponents?.queryItems ?? []).compactMap { item in
                item.value.map { (item.name, $0) }
            }
        )

        // The state comes first: only a relay carrying the state this sign-in was given can report
        // an IdP error, so another page can't end the sign-in with a message of its choosing.
        guard let returnedState = resultParams["state"], returnedState == signedState else {
            throw OIDCError.stateMismatch
        }

        // Then the CSRF inside the state envelope, also before the error. Fail closed: a state whose
        // payload can't be decoded, or that carries no csrf, is refused like a mismatched one.
        guard let dotIndex = signedState.firstIndex(of: "."),
              let payloadData = Data(base64URLDecoded: String(signedState[signedState.startIndex ..< dotIndex])),
              let payload = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
              let returnedCsrf = payload["csrf"] as? String,
              returnedCsrf == csrf
        else {
            throw OIDCError.stateMismatch
        }

        if let error = resultParams["error"] {
            let desc = resultParams["error_description"] ?? ""
            throw OIDCError.callbackError("\(error): \(desc)")
        }

        guard let code = resultParams["code"] else {
            throw OIDCError.missingAuthorizationCode
        }

        // Step 6: Exchange code for tokens
        let iss = resultParams["iss"]
        return try await exchange(
            code: code,
            verifier: verifier,
            callbackURL: serverCallbackUrl,
            provider: provider,
            state: signedState,
            nonce: nonce ?? "",
            iss: iss
        )
    }

    // MARK: - Token exchange

    public func exchange(
        code: String,
        verifier: String,
        callbackURL: String,
        provider: String,
        state: String,
        nonce: String,
        iss: String? = nil
    ) async throws -> OIDCUser {
        guard providers.contains(provider) else {
            throw OIDCError.unknownProvider(provider)
        }
        var body: [String: Any] = [
            "code": code,
            "verifier": verifier,
            "callbackUrl": callbackURL,
            "provider": provider,
            "state": state,
            "nonce": nonce,
            // Cookie session only: the server mints no bearer tokens for this client.
            "tokens": false
        ]
        if let iss { body["iss"] = iss }

        let json = try await client.postRawRoute(path: exchangePath, body: body)

        guard let userJSON = json["user"] as? [String: Any] else {
            throw OIDCError.malformedExchangeResponse
        }

        if let accessToken = json["accessToken"] as? String {
            await storeToken("access_token", accessToken)
            if let refreshToken = json["refreshToken"] as? String {
                await storeToken("refresh_token", refreshToken)
            }
            await storeToken("expires_at", Self.expiresAt(json))
            await storeToken("provider", provider)
        }

        let user = try OIDCUser.fromJSON(userJSON)
        emit(.signedIn(user))
        return user
    }

    // MARK: - Token refresh

    public func refresh() async throws {
        // Dedupe concurrent refresh requests — only one network call in flight.
        if let existing = inflightRefresh {
            try await existing.value
            return
        }
        let task = Task<Void, Error> { try await self.performRefresh() }
        inflightRefresh = task
        defer { inflightRefresh = nil }
        try await task.value
    }

    private func performRefresh() async throws {
        guard let refreshToken = await storedToken("refresh_token") else {
            emit(.signedOut)
            return
        }

        let json: [String: Any]
        do {
            var body: [String: Any] = ["refreshToken": refreshToken]
            // Required by a backend with two or more providers.
            if let provider = await storedToken("provider") { body["provider"] = provider }
            json = try await client.postRawRoute(path: refreshPath, body: body)
        } catch let error as ClientClosedError {
            // A closed client says nothing about the session, so the tokens stay.
            throw error
        } catch {
            await clearTokens()
            emit(.signedOut)
            return
        }

        guard let accessToken = json["accessToken"] as? String else {
            await clearTokens()
            emit(.signedOut)
            return
        }

        await storeToken("access_token", accessToken)
        await storeToken("expires_at", Self.expiresAt(json))
        if let newRefresh = json["refreshToken"] as? String {
            await storeToken("refresh_token", newRefresh)
        }
    }

    // MARK: - Sign out

    /// Signs out on the server, which clears the session cookie, then clears the stored tokens.
    ///
    /// POSTs `<signOutPath>?format=json` with an empty JSON body. The server ends the session from its
    /// cookie; it doesn't revoke bearer tokens, so the stored ones are only cleared locally.
    ///
    /// - Returns: The identity provider's logout URL, or `nil` when it has none, after emitting
    ///   `.signedOut`. The client doesn't open it: open it with your launcher to end the provider's
    ///   own session, so the next sign-in asks which account to use.
    /// - Throws: A `RawRouteError` named `SignOutIncompleteException` (HTTP 503) when the server
    ///   cleared the cookie but could not remove its session; the client is signed out locally
    ///   first. Any other failure is thrown after clearing the stored tokens, with the state left
    ///   as it was. `ClientClosedError` leaves the tokens too: the request was never sent.
    @discardableResult
    public func signOut() async throws -> URL? {
        // The server ends the session from its cookie and reads no body, so no token is sent.
        let body: [String: Any] = [:]
        let json: [String: Any]
        do {
            // A custom block's route may ignore `format=json` and answer an empty 204.
            json = try await client.postRawRoute(path: signOutPath + "?format=json", body: body, emptyBodyIsEmptyObject: true)
        } catch let error as ClientClosedError {
            throw error
        } catch let error as RawRouteError where error.statusCode == 503 && error.errorName == "SignOutIncompleteException" {
            await clearTokens()
            emit(.signedOut)
            throw error
        } catch {
            await clearTokens()
            throw error
        }
        await clearTokens()
        emit(.signedOut)
        return (json["logoutUrl"] as? String).flatMap { URL(string: $0) }
    }

    // MARK: - Restore session

    /// The session route, `<base>/session`, where `<base>` is the directory of the callback path.
    nonisolated var sessionPath: String {
        let base = routeBase ?? String(exchangePath[..<(exchangePath.lastIndex(of: "/") ?? exchangePath.endIndex)])
        return "\(base)/session"
    }

    /// Restores the signed-in user from the server's session, e.g. on launch.
    ///
    /// Reads `GET <base>/session` with the stored session cookie (and the stored access token, if
    /// any and not expired). The user is the server's, never one decoded from a token.
    ///
    /// - Returns: The signed-in user, after emitting `.signedIn`. `nil` when the server has no
    ///   session for this client (401), after clearing stored tokens and emitting `.signedOut`.
    /// - Throws: `RawRouteError` with `statusCode` 404 when the backend serves no session route: an
    ///   `Auth` block without federated providers, or a custom block that doesn't serve
    ///   `<base>/session`. Any other failure, including a transport error or `ClientClosedError`, is
    ///   thrown and leaves the state and stored tokens as they were.
    @discardableResult
    public func restore() async throws -> OIDCUser? {
        var headers: [String: String] = [:]
        // An expired token would only get a 401 that clears the refresh token with it. It isn't
        // refreshed here either: a failed refresh signs out, and a failed restore changes nothing.
        if let token = await storedToken("access_token"), !(await isExpired()) {
            headers["Authorization"] = "Bearer \(token)"
        }
        let json: [String: Any]
        do {
            json = try await client.getRawRoute(path: sessionPath, headers: headers)
        } catch let error as RawRouteError where error.statusCode == 401 {
            await clearTokens()
            emit(.signedOut)
            return nil
        } catch let error as RawRouteError where error.statusCode == 404 {
            throw RawRouteError(
                message: "\(sessionPath) answered HTTP 404: the backend serves no session route at that path. "
                    + "An Auth block serves one only when it has federated providers; "
                    + "a custom block must serve GET \(sessionPath).",
                statusCode: 404,
                errorName: error.errorName
            )
        }
        guard let userJSON = json["user"] as? [String: Any] else {
            throw OIDCError.invalidResponse
        }
        let user = try OIDCUser.fromJSON(userJSON)
        emit(.signedIn(user))
        return user
    }

    // MARK: - AuthProvider

    public func getAccessToken() async -> String? {
        guard let token = await storedToken("access_token") else { return nil }
        if await isExpired() {
            do {
                try await refresh()
            } catch {
                // Only a closed client throws here, and its expired token is no use.
                return nil
            }
            return await storedToken("access_token")
        }
        return token
    }

    public func onAuthFailure() async {
        do {
            try await refresh()
        } catch is ClientClosedError {
            return
        } catch {
            await clearTokens()
            emit(.signedOut)
        }
    }

    // MARK: - Factory

    /// `encodeURIComponent`, as the server applies it to a provider id in a route path.
    private static func encodeURIComponent(_ value: String) -> String {
        let unreserved = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }

    /// Hydrates an `OIDCClient` from a server-supplied transferable descriptor.
    ///
    /// Expected shape:
    /// ```json
    /// {
    ///   "providers": ["google", "github"],
    ///   "providerConfigs": { "google": { "authorizeUrl": "...", "clientId": "...", "scopes": [...], "kind": "..." } },
    ///   "exchangePath": "/aws-blocks/auth/exchange",
    ///   "refreshPath": "/aws-blocks/auth/exchange/refresh",
    ///   "signOutPath": "/aws-blocks/auth/signout"
    /// }
    /// ```
    public static func fromJSON(
        _ descriptor: [String: Any],
        baseUrl: String,
        client: BlocksClient
    ) throws -> OIDCClient {
        guard let exchangePath = descriptor["exchangePath"] as? String else {
            throw OIDCError.malformedDescriptor("exchangePath")
        }
        guard let signOutPath = descriptor["signOutPath"] as? String else {
            throw OIDCError.malformedDescriptor("signOutPath")
        }
        let refreshPath = (descriptor["refreshPath"] as? String) ?? "\(exchangePath)/refresh"
        let providers = (descriptor["providers"] as? [String]) ?? []
        let configsJSON = (descriptor["providerConfigs"] as? [String: [String: Any]]) ?? [:]
        let providerConfigs = try configsJSON.mapValues { try OIDCProviderConfig.fromJSON($0) }

        return OIDCClient(
            exchangePath: exchangePath,
            refreshPath: refreshPath,
            signOutPath: signOutPath,
            providers: providers,
            providerConfigs: providerConfigs,
            baseUrl: baseUrl,
            client: client,
            wireDescriptor: JSONValue(serialized: descriptor).flatMap { value in
                if case .dictionary(let entries) = value { return entries }
                return nil
            }
        )
    }

    // MARK: - Private helpers

    private func isExpired() async -> Bool {
        guard let raw = await storedToken("expires_at"),
              let expiry = Int64(raw)
        else { return true }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        return nowMs >= expiry
    }

    private func clearTokens() async {
        for name in Self.tokenNames {
            await tokenStore.delete(tokenKey(name))
        }
    }

    // Computed: a generic type can't store a static property.
    private static var tokenNames: [String] { ["access_token", "refresh_token", "expires_at", "provider"] }

    /// Scoped by exchange path, so OIDC blocks sharing one `TokenStore` keep separate sessions.
    private func tokenKey(_ name: String) -> String {
        "\(exchangePath)#\(name)"
    }

    private func storedToken(_ name: String) async -> String? {
        await adoptLegacyTokens()
        return await tokenStore.get(tokenKey(name))
    }

    private func storeToken(_ name: String, _ value: String) async {
        await adoptLegacyTokens()
        await tokenStore.set(tokenKey(name), value: value)
    }

    /// Once per BlocksClient, the first of its OIDCClients to use the store takes the unscoped tokens, unless it has its own.
    private func adoptLegacyTokens() async {
        await client.adoptLegacyTokensOnce { await self.moveLegacyTokens() }
    }

    private func moveLegacyTokens() async {
        for name in Self.tokenNames where await tokenStore.get(tokenKey(name)) != nil {
            return
        }
        for name in Self.tokenNames {
            guard let value = await tokenStore.get(name) else { continue }
            await tokenStore.set(tokenKey(name), value: value)
            await tokenStore.delete(name)
        }
    }

    /// The expiry to store, in epoch milliseconds: now plus the response's `expiresIn` seconds, or its
    /// `expiresAt` (epoch milliseconds) when it has no `expiresIn`. `"0"` (already expired) for neither.
    private static func expiresAt(_ json: [String: Any]) -> String {
        if let seconds = json["expiresIn"] as? NSNumber {
            let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
            return String(nowMs + Int64(seconds.doubleValue * 1_000))
        }
        if let number = json["expiresAt"] as? NSNumber { return number.stringValue }
        if let str = json["expiresAt"] as? String { return str }
        return "0"
    }
}

// MARK: - Auth block

public extension OIDCClient where Provider == String {
    /// A client for the `Auth` block's federated sign-in, on the app's own `BlocksClient`, so it shares
    /// the app's `URLSession`, cookies and token store. It makes no request until you call it.
    ///
    /// ```swift
    /// let blocks = Blocks()
    /// let oidc = OIDCClient.forAuth(client: blocks.client, providers: ["google"], relayTo: "myapp://auth")
    /// let user = try await oidc.signIn(provider: "google", launcher: launcher)
    /// ```
    ///
    /// The routes are derived the way the server derives them: the base is `callbackPath` up to its
    /// last `/`, and authorize-params, exchange, session and refresh sit under it. Pass the paths only
    /// when the backend sets `redirects.callbackPath` or `redirects.signOutPath`. The routes are
    /// requested at the client's URL cut before its first `aws-blocks` path segment, so an API Gateway
    /// stage prefix is kept.
    ///
    /// - Parameters:
    ///   - client: The app's client, e.g. `blocks.client`.
    ///   - providers: The block's provider ids. `signIn` refuses any other id before making a request.
    ///   - relayTo: The URL the server relays the sign-in back to, usually the app's custom scheme. It
    ///     must be listed in the backend's `redirects.allowedRelayOrigins`.
    ///   - callbackPath: The backend's `redirects.callbackPath`.
    ///   - signOutPath: The backend's `redirects.signOutPath`.
    /// - Precondition: Both paths start with `/aws-blocks/auth/`, and `callbackPath` has a segment
    ///   after that and no trailing `/`. The paths are constants of the app's backend, so a path that
    ///   breaks this stops the app with `preconditionFailure`, naming the path, instead of throwing.
    ///   This differs from the Kotlin and Dart SDKs, whose `forAuth` throws an argument error: pass
    ///   the backend's own `redirects.callbackPath` and `redirects.signOutPath`, never user input.
    static func forAuth(
        client: BlocksClient,
        providers: [String],
        relayTo: String? = nil,
        callbackPath: String = "/aws-blocks/auth/callback",
        signOutPath: String = "/aws-blocks/auth/signout"
    ) -> OIDCClient<String> {
        if let problem = authPathsProblem(callbackPath: callbackPath, signOutPath: signOutPath) {
            preconditionFailure(problem)
        }
        let base = String(callbackPath[..<callbackPath.lastIndex(of: "/")!])
        return OIDCClient<String>(
            exchangePath: "\(base)/exchange",
            refreshPath: "\(base)/exchange/refresh",
            signOutPath: signOutPath,
            providers: providers,
            providerConfigs: [:],
            baseUrl: client.baseUrl,
            client: client,
            wireDescriptor: nil,
            routeBase: base,
            callbackPath: callbackPath,
            relayTo: relayTo
        )
    }
}

// MARK: - Codable

extension OIDCClient: Codable {
    private enum DescriptorKeys: String, CodingKey {
        case blocksType = "__blocks"
        case exchangePath
        case refreshPath
        case signOutPath
        case providers
        case providerConfigs
    }

    // Spelled `nonisolated`: an app module with MainActor default isolation that names `OIDCClient<Provider>`
    // otherwise rejects the generic actor's `Decodable` conformance (`any Decoder` isn't `Sendable`).
    /// Decodes a client from its `{ "__blocks": "oidc/client", … }` descriptor, like
    /// ``fromJSON(_:baseUrl:client:)``, so a generated model can hold one at any depth.
    ///
    /// The client signs in through the ``BlocksClient`` that fetched the descriptor, so the decoder must carry it
    /// in `userInfo[.blocksClient]`: decode with ``BlocksClient/makeDecoder()``. Generated operations do.
    ///
    /// - Throws: `DecodingError.dataCorrupted` when the decoder carries no client or the descriptor is malformed.
    nonisolated public init(from decoder: any Decoder) throws {
        guard let client = decoder.userInfo[.blocksClient] as? BlocksClient else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Decoding an OIDCClient needs the BlocksClient that fetched it in "
                    + "decoder.userInfo[.blocksClient]. Decode with BlocksClient.makeDecoder()."
            ))
        }
        let container = try decoder.container(keyedBy: DescriptorKeys.self)
        try TransferableDescriptor.check(container, key: .blocksType, expected: "oidc/client")
        let descriptor = try [String: JSONValue](from: decoder)
        let hydrated: OIDCClient
        do {
            let serialized = descriptor.mapValues(\.serialized)
            hydrated = try Self.fromJSON(serialized, baseUrl: client.baseUrl, client: client)
        } catch {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Invalid OIDC client descriptor",
                underlyingError: error
            ))
        }
        self.init(
            exchangePath: hydrated.exchangePath,
            refreshPath: hydrated.refreshPath,
            signOutPath: hydrated.signOutPath,
            providers: hydrated.providers,
            providerConfigs: hydrated.providerConfigs,
            baseUrl: hydrated.baseUrl,
            client: client,
            wireDescriptor: descriptor
        )
    }

    /// Encodes the descriptor this client was hydrated from, unchanged. A client built with `init` encodes
    /// `{ "__blocks": "oidc/client", "exchangePath", "refreshPath", "signOutPath", "providers", "providerConfigs" }`.
    public nonisolated func encode(to encoder: Encoder) throws {
        if let wireDescriptor {
            try wireDescriptor.encode(to: encoder)
            return
        }
        var container = encoder.container(keyedBy: DescriptorKeys.self)
        try container.encode("oidc/client", forKey: .blocksType)
        try container.encode(exchangePath, forKey: .exchangePath)
        try container.encode(refreshPath, forKey: .refreshPath)
        try container.encode(signOutPath, forKey: .signOutPath)
        try container.encode(providers, forKey: .providers)
        try container.encode(providerConfigs, forKey: .providerConfigs)
    }
}

// MARK: - Errors

public enum OIDCError: BlocksError, Equatable {
    case unknownProvider(String)
    case invalidAuthorizeURL(String)
    case invalidURL(String)
    case stateMismatch
    case missingAuthorizationCode
    case missingPKCEState
    case malformedExchangeResponse
    case malformedRefreshResponse
    case malformedDescriptor(String)
    case invalidResponse
    case callbackError(String)

    public var message: String {
        switch self {
        case .unknownProvider(let name):
            return "Unknown OIDC provider: \(name)"
        case .invalidAuthorizeURL(let url):
            return "Invalid authorize URL: \(url)"
        case .invalidURL(let url):
            return "Invalid URL: \(url)"
        case .stateMismatch:
            return "OIDC state mismatch — possible CSRF attack"
        case .missingAuthorizationCode:
            return "Missing authorization code in callback URL"
        case .missingPKCEState:
            return "Missing PKCE state in token store"
        case .malformedExchangeResponse:
            return "Malformed exchange response — missing accessToken or refreshToken"
        case .malformedRefreshResponse:
            return "Malformed refresh response — missing accessToken"
        case .malformedDescriptor(let field):
            return "Malformed OIDC descriptor — missing or invalid field: \(field)"
        case .invalidResponse:
            return "Invalid JSON response"
        case .callbackError(let detail):
            return "OIDC callback error: \(detail)"
        }
    }
}

/// A client that is missing configuration a call needs, such as `relayTo` for `signIn(provider:launcher:)`.
public struct OIDCConfigurationError: BlocksError {
    public let message: String

    public init(message: String) {
        self.message = message
    }
}

// MARK: - Base64URL Decoding

extension Data {
    init?(base64URLDecoded string: String) {
        var base64 = string
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let remainder = base64.count % 4
        if remainder > 0 {
            base64 += String(repeating: "=", count: 4 - remainder)
        }
        self.init(base64Encoded: base64)
    }
}
