//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import CryptoKit

/// Server-relay OIDC client. Delegates networking to `BlocksClient` so
/// cookies are shared automatically. Implements the relay sign-in flow:
/// fetches signed authorize params from the server, opens the IdP in a
/// browser, and exchanges the authorization code for tokens.
///
/// All mutable state is protected by actor isolation.
public actor OIDCClient: AuthProvider {

    public nonisolated let exchangePath: String
    public nonisolated let refreshPath: String
    public nonisolated let signOutPath: String
    public nonisolated let providers: [String]
    public nonisolated let providerConfigs: [String: OIDCProviderConfig]
    public nonisolated let baseUrl: String

    nonisolated let client: BlocksClient
    private var tokenStore: TokenStore { client.tokenStore }

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
        self.exchangePath = exchangePath
        self.refreshPath = refreshPath
        self.signOutPath = signOutPath
        self.providers = providers
        self.providerConfigs = providerConfigs
        self.baseUrl = baseUrl
        self.client = client
    }

    /// Returns a fresh stream of auth-state transitions. Every active
    /// subscriber receives every emitted state. Emits on sign-in, sign-out,
    /// and loading transitions.
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
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
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

    /// Sign in using the server-relay flow.
    /// The server signs the state envelope and the IdP redirects to the
    /// server's callback, which then 302s to the app's `relayTo` scheme.
    public func signIn(
        provider: String,
        relayTo: String,
        launcher: BrowserLauncher
    ) async throws -> OIDCUser {
        guard providers.contains(provider) else {
            throw OIDCError.unknownProvider(provider)
        }

        let csrf = Self.generateVerifier()
        let verifier = Self.generateVerifier()
        let challenge = Self.generateChallenge(verifier)

        // Step 1: Fetch signed authorize params from server
        // Raw routes are mounted at the gateway root, not under the RPC prefix.
        let authorizeParamsPath = exchangePath.replacingOccurrences(of: "/exchange", with: "/authorize-params/\(provider)")
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
        let callbackPath = exchangePath.replacingOccurrences(of: "/exchange", with: "/callback")
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
            URLQueryItem(name: "code_challenge_method", value: "S256"),
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

        if let error = resultParams["error"] {
            let desc = resultParams["error_description"] ?? ""
            throw OIDCError.callbackError("\(error): \(desc)")
        }

        guard let code = resultParams["code"] else {
            throw OIDCError.missingAuthorizationCode
        }
        guard let returnedState = resultParams["state"] else {
            throw OIDCError.stateMismatch
        }

        if returnedState != signedState {
            throw OIDCError.stateMismatch
        }

        // Step 5: Verify CSRF inside state envelope
        if let dotIndex = signedState.firstIndex(of: ".") {
            let payloadB64 = String(signedState[signedState.startIndex ..< dotIndex])
            if let payloadData = Data(base64URLDecoded: payloadB64),
               let payload = try? JSONSerialization.jsonObject(with: payloadData) as? [String: Any],
               let returnedCsrf = payload["csrf"] as? String {
                if returnedCsrf != csrf {
                    throw OIDCError.stateMismatch
                }
            }
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
        var body: [String: Any] = [
            "code": code,
            "verifier": verifier,
            "callbackUrl": callbackURL,
            "provider": provider,
            "state": state,
            "nonce": nonce,
        ]
        if let iss { body["iss"] = iss }

        let json = try await client.postRawRoute(path: exchangePath, body: body)

        guard let userJSON = json["user"] as? [String: Any] else {
            throw OIDCError.malformedExchangeResponse
        }

        if let accessToken = json["accessToken"] as? String {
            await tokenStore.set("access_token", value: accessToken)
            if let refreshToken = json["refreshToken"] as? String {
                await tokenStore.set("refresh_token", value: refreshToken)
            }
            await tokenStore.set("expires_at", value: Self.stringifyExpiry(json["expiresIn"]))
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
        guard let refreshToken = await tokenStore.get("refresh_token") else {
            emit(.signedOut)
            return
        }

        let json: [String: Any]
        do {
            json = try await client.postRawRoute(path: refreshPath, body: ["refreshToken": refreshToken])
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

        await tokenStore.set("access_token", value: accessToken)
        await tokenStore.set("expires_at", value: Self.stringifyExpiry(json["expiresAt"]))
        if let newRefresh = json["refreshToken"] as? String {
            await tokenStore.set("refresh_token", value: newRefresh)
        }
    }

    // MARK: - Sign out

    public func signOut() async {
        let refreshToken = await tokenStore.get("refresh_token")
        _ = try? await client.postRawRoute(path: signOutPath, body: ["refreshToken": refreshToken ?? ""])
        await clearTokens()
        emit(.signedOut)
    }

    // MARK: - Restore session

    public func restore() async {
        emit(.loading)

        let accessToken = await tokenStore.get("access_token")
        let refreshToken = await tokenStore.get("refresh_token")

        guard accessToken != nil, refreshToken != nil else {
            emit(.signedOut)
            return
        }

        if await isExpired() {
            do {
                try await refresh()
            } catch {
                await clearTokens()
                emit(.signedOut)
                return
            }
        }

        guard let token = await tokenStore.get("access_token") else {
            emit(.signedOut)
            return
        }

        let parts = token.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 3,
              let payload = Self.decodeJWTPayload(String(parts[1]))
        else {
            emit(.signedOut)
            return
        }

        let user = OIDCUser(
            userId: payload["sub"] as? String ?? "",
            username: payload["username"] as? String ?? "",
            groups: (payload["groups"] as? [String]) ?? []
        )
        emit(.signedIn(user))
    }

    // MARK: - AuthProvider

    public func getAccessToken() async -> String? {
        guard let token = await tokenStore.get("access_token") else { return nil }
        if await isExpired() {
            try? await refresh()
            return await tokenStore.get("access_token")
        }
        return token
    }

    public func onAuthFailure() async {
        do {
            try await refresh()
        } catch {
            await clearTokens()
            emit(.signedOut)
        }
    }

    // MARK: - Factory

    /// Hydrates an `OIDCClient` from a server-supplied transferable descriptor.
    ///
    /// Expected shape:
    /// ```json
    /// {
    ///   "providers": ["google", "github"],
    ///   "providerConfigs": { "google": { "authorizeUrl": "...", "clientId": "...", "scopes": [...], "kind": "..." } },
    ///   "exchangePath": "/auth/exchange",
    ///   "refreshPath": "/auth/exchange/refresh",
    ///   "signOutPath": "/auth/signout"
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
            client: client
        )
    }

    // MARK: - Private helpers

    private func isExpired() async -> Bool {
        guard let raw = await tokenStore.get("expires_at"),
              let expiry = Int64(raw)
        else { return true }
        let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
        return nowMs >= expiry
    }

    private func clearTokens() async {
        await tokenStore.delete("access_token")
        await tokenStore.delete("refresh_token")
        await tokenStore.delete("expires_at")
    }

    private static func stringifyExpiry(_ value: Any?) -> String {
        if let n = value as? NSNumber { return n.stringValue }
        if let s = value as? String { return s }
        return "0"
    }

    private static func decodeJWTPayload(_ segment: String) -> [String: Any]? {
        var s = segment.replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        let padding = s.count % 4
        if padding > 0 { s += String(repeating: "=", count: 4 - padding) }
        guard let data = Data(base64Encoded: s),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return json
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
