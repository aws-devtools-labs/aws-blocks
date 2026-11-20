//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation
import CryptoKit
import os

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
/// Hold one client per `Auth` block for the app's lifetime: fetch it once with the block's
/// `getClient()` and keep it. `authState`, `authStateChanges()` and the guard against a stale
/// `restore()` are per client, so a second client for the same block doesn't see the first one's
/// sign-in, and its subscribers miss the first one's transitions.
///
/// All mutable state is protected by actor isolation.
public actor OIDCClient<Provider: OIDCProviderName>: AuthProvider {

    public nonisolated let exchangePath: String
    public nonisolated let refreshPath: String
    public nonisolated let signOutPath: String
    public nonisolated let providers: [String]
    public nonisolated let providerConfigs: [String: OIDCProviderConfig]
    public nonisolated let baseUrl: String
    /// The IdP `redirect_uri` path: the descriptor's `callbackPath` (or `init`'s), or `exchangePath` with
    /// `/exchange` replaced by `/callback` when neither names one.
    public nonisolated let callbackPath: String
    /// The directory the authorize-params routes sit in (`<base>/authorize-params`): the descriptor's
    /// `authorizeParamsBasePath` (or `init`'s), or one derived from `exchangePath` when neither names one.
    public nonisolated let authorizeParamsBasePath: String
    /// The session route `restore()` reads: the descriptor's `sessionPath`, or `<base>/session` when
    /// the descriptor has none, where `<base>` is the directory of `callbackPath`.
    public nonisolated let sessionPath: String
    /// The name of this block's session cookie, from the descriptor's `sessionCookieName`, or `nil` from a
    /// backend that doesn't send it. A failed sign-out removes this cookie, and only this one.
    nonisolated let sessionCookieName: String?

    nonisolated let client: BlocksClient
    private var tokenStore: TokenStore { client.tokenStore }

    private var inflightRefresh: Task<Void, Error>?
    /// Counts the sign-ins and sign-outs this client has applied. `restore()` reads it before it suspends
    /// and applies its result only if it is unchanged, so a late result can't overwrite a sign-in or
    /// sign-out that finished meanwhile.
    private var sessionGeneration = 0
    /// Whether a sign-in, sign-out, restore or refresh is writing the session (tokens, cookie names and the
    /// emitted state). The actor is reentrant at every token-store call, so these writes take turns through
    /// ``withSessionWrites(_:)``: one that checked `sessionGeneration` can't be overtaken while it writes.
    private var sessionWriting = false
    private var sessionWriteWaiters: [CheckedContinuation<Void, Never>] = []
    private var subscribers: [UUID: AsyncStream<OIDCAuthState>.Continuation] = [:]

    /// The current auth state: the state most recently emitted to `authStateChanges()` subscribers, or `.loading`
    /// before the first one. Reading it needs no subscription, so an app can check the state once, such as on
    /// launch after `restore()`: `if case .signedIn(let user) = await client.authState { ... }`.
    public private(set) var authState: OIDCAuthState = .loading

    /// - Parameters:
    ///   - authorizeParamsBasePath: Defaults to `exchangePath` with its `/exchange` segment replaced by
    ///     `/authorize-params`, the `Auth` block's layout.
    ///   - callbackPath: Defaults to `exchangePath` with `/exchange` replaced by `/callback`. Pass the backend's
    ///     `redirects.callbackPath` when it doesn't end in `/callback`.
    public init(
        exchangePath: String,
        refreshPath: String,
        signOutPath: String,
        providers: [String],
        providerConfigs: [String: OIDCProviderConfig],
        baseUrl: String,
        client: BlocksClient,
        authorizeParamsBasePath: String? = nil,
        callbackPath: String? = nil
    ) {
        self.init(
            exchangePath: exchangePath,
            refreshPath: refreshPath,
            signOutPath: signOutPath,
            providers: providers,
            providerConfigs: providerConfigs,
            baseUrl: baseUrl,
            client: client,
            callbackPath: callbackPath,
            authorizeParamsBasePath: authorizeParamsBasePath,
            sessionPath: nil,
            sessionCookieName: nil
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
        callbackPath: String?,
        authorizeParamsBasePath: String?,
        sessionPath: String?,
        sessionCookieName: String?
    ) {
        self.exchangePath = exchangePath
        self.refreshPath = refreshPath
        self.signOutPath = signOutPath
        self.providers = providers
        self.providerConfigs = providerConfigs
        self.baseUrl = baseUrl
        self.client = client
        // A descriptor without these fields predates them, and `init` may omit them: derive them from
        // `exchangePath`, as before.
        self.callbackPath = callbackPath ?? exchangePath.replacingOccurrences(of: "/exchange", with: "/callback")
        self.authorizeParamsBasePath = authorizeParamsBasePath
            ?? exchangePath.replacingOccurrences(of: "/exchange", with: "/authorize-params")
        let callback = self.callbackPath
        self.sessionPath = sessionPath ?? "\(callback[..<(callback.lastIndex(of: "/") ?? callback.endIndex)])/session"
        self.sessionCookieName = sessionCookieName
    }

    /// Returns a fresh stream of auth states. It yields the current ``authState`` first, then every state
    /// the client emits after it, as Kotlin's `StateFlow` does, so a subscriber never misses the state it
    /// starts in. Every active subscriber receives every emitted state. The client emits on sign-in and
    /// sign-out; it doesn't emit `.loading`, the state before the first sign-in or `restore()`.
    ///
    /// The async signature ensures the subscriber is registered with the
    /// actor *before* the call returns — callers can safely kick off an
    /// auth action immediately after `let stream = await client.authStateChanges()`
    /// without missing the resulting state event.
    public func authStateChanges() -> AsyncStream<OIDCAuthState> {
        let id = UUID()
        let current = authState
        let stream = AsyncStream<OIDCAuthState> { continuation in
            continuation.yield(current)
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
        authState = state
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

    /// Sign in using the server-relay flow.
    /// The server signs the state envelope and the IdP redirects to the
    /// server's callback, which then 302s to the app's `relayTo` scheme.
    ///
    /// `launcher` opens the IdP and returns that redirect. On iOS and macOS,
    /// ``WebAuthenticationSessionLauncher`` opens it in `ASWebAuthenticationSession`, and
    /// ``signIn(provider:relayTo:)`` signs in with one at its defaults.
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
        let authorizeParamsPath = "\(authorizeParamsBasePath)/\(Self.encodeURIComponent(provider))"
        let paramsBody: [String: Any] = ["csrf": csrf, "relayTo": relayTo]
        let paramsJSON: [String: Any]
        do {
            paramsJSON = try await client.postRawRoute(path: authorizeParamsPath, body: paramsBody)
        } catch let error as ClientClosedError {
            throw error
        } catch let error as CancellationError {
            throw error
        } catch let error as OIDCError {
            throw error
        } catch {
            throw OIDCError.callbackError(
                "Failed to fetch authorize params: \((error as? BlocksError)?.message ?? error.localizedDescription)",
                error
            )
        }

        // A missing field is named, never the response itself: it carries the signed state and the nonce.
        guard let authorizeUrl = paramsJSON["authorizeUrl"] as? String else {
            throw OIDCError.callbackError("authorize-params response has no authorizeUrl", nil)
        }
        guard let clientId = paramsJSON["clientId"] as? String else {
            throw OIDCError.callbackError("authorize-params response has no clientId", nil)
        }
        guard let scopes = paramsJSON["scopes"] as? [String] else {
            throw OIDCError.callbackError("authorize-params response has no scopes", nil)
        }
        guard let signedState = paramsJSON["state"] as? String else {
            throw OIDCError.callbackError("authorize-params response has no state", nil)
        }
        let nonce = paramsJSON["nonce"] as? String

        // Step 2: Build full authorize URL with server's callback as redirect_uri
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
            throw OIDCError.callbackError("\(error): \(desc)", nil)
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

        let json: [String: Any]
        let cookieNames: [String]
        do {
            (json, cookieNames) = try await client.postRawRouteRecordingCookies(path: exchangePath, body: body)
        } catch let error as ClientClosedError {
            throw error
        } catch let error as CancellationError {
            throw error
        } catch let error as OIDCError {
            throw error
        } catch {
            throw OIDCError.exchangeFailed((error as? BlocksError)?.message ?? error.localizedDescription, error)
        }

        guard let userJSON = json["user"] as? [String: Any] else {
            throw OIDCError.malformedExchangeResponse
        }

        return try await withSessionWrites {
            sessionGeneration += 1
            // The cookies this block's exchange set: a failed sign-out removes only these when the
            // descriptor names no `sessionCookieName`.
            if !cookieNames.isEmpty {
                await storeToken(Self.sessionCookiesKey, cookieNames.joined(separator: ","))
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
    }

    // MARK: - Token refresh

    /// Refreshes the bearer tokens. With no refresh token stored, as after a cookie-session sign-in, it sends no
    /// request and leaves the state alone: the cookie session is ``restore()``'s to read. Concurrent callers
    /// share one in-flight refresh. A caller whose task is
    /// cancelled throws `CancellationError` at once and leaves the shared refresh running, so other callers
    /// still get its result and whatever it stores is kept.
    public func refresh() async throws {
        // Dedupe concurrent refresh requests: only one network call in flight.
        let task: Task<Void, Error>
        if let existing = inflightRefresh {
            task = existing
        } else {
            // Isolated to this actor, so it can't start before `inflightRefresh` is set, and it clears
            // `inflightRefresh` itself: a cancelled caller that started it doesn't end it.
            task = Task<Void, Error> {
                defer { self.inflightRefresh = nil }
                try await self.performRefresh()
            }
            inflightRefresh = task
        }
        try await Self.result(of: task)
    }

    /// Waits for `task`, but throws `CancellationError` as soon as the calling task is cancelled, without
    /// cancelling `task`.
    private static func result(of task: Task<Void, Error>) async throws {
        let waiter = CancellableWaiter()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                waiter.start(continuation)
                Task { waiter.finish(await task.result) }
            }
        } onCancel: {
            waiter.finish(.failure(CancellationError()))
        }
    }

    /// Refreshes the bearer tokens. With no refresh token stored, as for a cookie session, it sends no request
    /// and changes nothing. Only a refusal from the refresh route (an `ApiError` with status 400 or 401)
    /// ends the session: it clears the stored tokens and emits `.signedOut`. Any other failure (a
    /// `TransportError` when offline or for a response without an access token, another `ApiError`, a
    /// `CancellationError`, a `ClientClosedError`) is thrown and leaves the tokens and the state as they were.
    /// A result that a sign-in or sign-out on this client overtook while it was in flight is ignored.
    private func performRefresh() async throws {
        let generation = sessionGeneration
        // A cookie session stores no refresh token (the exchange asks for none): nothing to refresh, and
        // the cookie may still be valid, so the state stays as it is. `restore()` reads the cookie session.
        guard let refreshToken = await storedToken("refresh_token") else { return }

        let json: [String: Any]
        do {
            var body: [String: Any] = ["refreshToken": refreshToken]
            // Required by a backend with two or more providers.
            if let provider = await storedToken("provider") { body["provider"] = provider }
            json = try await client.postRawRoute(path: refreshPath, body: body)
        } catch let error as ApiError where error.status == 400 || error.status == 401 {
            await withSessionWrites {
                guard generation == sessionGeneration else { return }
                await clearTokens()
                emit(.signedOut)
            }
            return
        }
        guard generation == sessionGeneration else { return }

        guard let accessToken = json["accessToken"] as? String else {
            // No usable result, as for a 2xx body that isn't a JSON object.
            throw TransportError(message: "Response from \(refreshPath) has no accessToken", statusCode: 200)
        }

        await withSessionWrites {
            guard generation == sessionGeneration else { return }
            await storeToken("access_token", accessToken)
            await storeToken("expires_at", Self.expiresAt(json))
            if let newRefresh = json["refreshToken"] as? String {
                await storeToken("refresh_token", newRefresh)
            }
        }
    }

    // MARK: - Sign out

    /// Signs out on the server, which clears the session cookie, then clears the stored tokens.
    ///
    /// POSTs `<signOutPath>?format=json` with an empty JSON body. The server ends the session from its
    /// cookie; it doesn't revoke bearer tokens, so the stored ones are only cleared locally.
    ///
    /// - Returns: The identity provider's logout URL, or `nil` when it has none, after emitting
    ///   `.signedOut`. The client doesn't open it: open it in the browser, such as with
    ///   `UIApplication.shared.open`, to end the provider's own session, so the next sign-in asks which
    ///   account to use. Not in a sign-in sheet: the provider's logout redirects to the backend's
    ///   post-sign-out page, never to `relayTo`, so a `WebAuthenticationSessionLauncher` sheet would stay
    ///   open until the user closes it and end in `OIDCError.cancelled`.
    /// - Throws: Any failure, after signing out locally: the stored tokens are cleared and `.signedOut`
    ///   is emitted first. That covers an `ApiError` named `SignOutIncompleteException` (HTTP 503),
    ///   when the server cleared the cookie but could not remove its session, and every other failure
    ///   (a `TransportError`, a `CancellationError`, an `ApiError` with another status or name), for
    ///   which the client also removes this block's session cookie, and only this block's. The client
    ///   knows that cookie by the descriptor's `sessionCookieName`. From a backend that doesn't send it,
    ///   the client falls back to the names this block's sign-in response set, kept in the token store
    ///   with the tokens, so after a relaunch with an in-memory token store it can't remove the cookie.
    ///   `ClientClosedError` changes nothing: the request was never sent.
    @discardableResult
    public func signOut() async throws -> URL? {
        // The server ends the session from its cookie and reads no body, so no token is sent.
        let body: [String: Any] = [:]
        let json: [String: Any]
        do {
            // A custom block's route may ignore `format=json` and answer an empty 204.
            json = try await client.postRawRoute(path: signOutPath + "?format=json", body: body, emptyBodyIsEmptyObject: true)
        } catch let error as ClientClosedError {
            // The request was never sent, so the session is untouched.
            throw error
        } catch {
            // The server didn't end the session (or, for `SignOutIncompleteException`, only cleared the
            // cookie), so sign out locally: this block's tokens and session cookie go, then the error.
            await withSessionWrites {
                sessionGeneration += 1
                if !Self.isSignOutIncomplete(error) {
                    await removeSessionCookies()
                }
                await clearTokens()
                emit(.signedOut)
            }
            throw error
        }
        await withSessionWrites {
            sessionGeneration += 1
            await clearTokens()
            emit(.signedOut)
        }
        return (json["logoutUrl"] as? String).flatMap { URL(string: $0) }
    }

    /// Removes this block's session cookie, and no other block's: the descriptor's `sessionCookieName`, or,
    /// from a backend that doesn't send it, the cookies this block's exchange set.
    private func removeSessionCookies() async {
        if let sessionCookieName {
            client.removeCookies(named: [sessionCookieName], sentTo: signOutPath)
            return
        }
        guard let names = await storedToken(Self.sessionCookiesKey) else { return }
        client.removeCookies(named: names.split(separator: ",").map(String.init), sentTo: signOutPath)
    }

    /// Whether `error` is the server's `SignOutIncompleteException` (HTTP 503): the session cookie was cleared
    /// but the server-side session was not removed.
    private static func isSignOutIncomplete(_ error: Error) -> Bool {
        guard let error = error as? ApiError else { return false }
        return error.status == 503 && error.name == "SignOutIncompleteException"
    }

    // MARK: - Restore session

    /// Restores the signed-in user from the server's session, e.g. on launch.
    ///
    /// Reads `GET <sessionPath>` with the stored session cookie (and the stored access token, if
    /// any and not expired). The user is the server's, never one decoded from a token.
    ///
    /// - Returns: The signed-in user, after emitting `.signedIn`. `nil` when the server has no
    ///   session for this client (401), after clearing stored tokens and emitting `.signedOut`. If a
    ///   sign-in or sign-out on this client finished while the request was in flight, the response is
    ///   out of date: it is ignored, nothing is emitted or cleared, and the current ``authState``'s user
    ///   (or `nil`) is returned.
    /// - Throws: `ApiError` with `status` 404 when the backend serves no session route: an `Auth` block
    ///   without federated providers, or a custom block that doesn't serve `sessionPath`.
    ///   `TransportError` with `statusCode` 200 when the response has no `user`, or one without a
    ///   `userId` or `username`. Any other failure, including a `TransportError` or `ClientClosedError`,
    ///   is thrown and leaves the state and stored tokens as they were.
    @discardableResult
    public func restore() async throws -> OIDCUser? {
        let generation = sessionGeneration
        var headers: [String: String] = [:]
        // An expired token would only get a 401 that clears the refresh token with it. It isn't
        // refreshed here either: a failed refresh signs out, and a failed restore changes nothing.
        if let token = await storedToken("access_token"), !(await isExpired()) {
            headers["Authorization"] = "Bearer \(token)"
        }
        let json: [String: Any]
        do {
            json = try await client.getRawRoute(path: sessionPath, headers: headers)
        } catch let error as ApiError where error.status == 401 {
            return await withSessionWrites {
                guard generation == sessionGeneration else { return currentUser }
                await clearTokens()
                emit(.signedOut)
                return nil
            }
        } catch let error as ApiError where error.status == 404 {
            throw ApiError(
                message: "\(sessionPath) answered HTTP 404: the backend serves no session route at that path. "
                    + "An Auth block serves one only when it has federated providers; "
                    + "a custom block must serve GET \(sessionPath).",
                status: 404,
                name: error.name
            )
        }
        // No usable result, as for a refresh without an access token.
        guard let userJSON = json["user"] as? [String: Any], let user = try? OIDCUser.fromJSON(userJSON) else {
            throw TransportError(message: "Response from \(sessionPath) has no usable user", statusCode: 200)
        }
        guard generation == sessionGeneration else { return currentUser }
        emit(.signedIn(user))
        return user
    }

    /// The user `authState` is signed in as, or `nil`.
    private var currentUser: OIDCUser? {
        if case .signedIn(let user) = authState { return user }
        return nil
    }

    /// Runs `body` once no other session write is running, then lets the next one in, in arrival order.
    /// Every write that bumps or checks `sessionGeneration` and then awaits the token store goes through
    /// here, so its check still holds when it emits.
    private func withSessionWrites<T>(_ body: () async throws -> T) async rethrows -> T {
        if sessionWriting {
            // Handed the turn by the writer before it: `sessionWriting` stays true.
            await withCheckedContinuation { sessionWriteWaiters.append($0) }
        } else {
            sessionWriting = true
        }
        defer {
            if sessionWriteWaiters.isEmpty {
                sessionWriting = false
            } else {
                sessionWriteWaiters.removeFirst().resume()
            }
        }
        return try await body()
    }

    // MARK: - AuthProvider

    public func getAccessToken() async -> String? {
        guard let token = await storedToken("access_token") else { return nil }
        if await isExpired() {
            do {
                try await refresh()
            } catch {
                // The refresh failed without ending the session (offline, a server error, a closed
                // client): the expired token is no use, but the refresh token stays for a retry.
                return nil
            }
            return await storedToken("access_token")
        }
        return token
    }

    public func onAuthFailure() async {
        // A refused refresh signs out inside `refresh()`; any other failure keeps the tokens for a retry.
        try? await refresh()
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
    ///   "exchangePath": "/cdk-blocks/auth/exchange",
    ///   "refreshPath": "/cdk-blocks/auth/exchange/refresh",
    ///   "signOutPath": "/cdk-blocks/auth/signout",
    ///   "callbackPath": "/cdk-blocks/auth/callback",
    ///   "authorizeParamsBasePath": "/cdk-blocks/auth/authorize-params"
    /// }
    /// ```
    ///
    /// `callbackPath` and `authorizeParamsBasePath` are the block's own routes, so a block with a custom
    /// `redirects.callbackPath` signs in at its routes. A descriptor without them derives them from
    /// `exchangePath`.
    public static func fromJSON(
        _ descriptor: [String: Any],
        baseUrl: String,
        client: BlocksClient
    ) throws -> OIDCClient {
        guard let exchangePath = descriptor["exchangePath"] as? String else {
            throw TransferableError.invalidDescriptor(blocksType: "oidc", missingField: "exchangePath")
        }
        guard let signOutPath = descriptor["signOutPath"] as? String else {
            throw TransferableError.invalidDescriptor(blocksType: "oidc", missingField: "signOutPath")
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
            callbackPath: descriptor["callbackPath"] as? String,
            authorizeParamsBasePath: descriptor["authorizeParamsBasePath"] as? String,
            sessionPath: descriptor["sessionPath"] as? String,
            sessionCookieName: (descriptor["sessionCookieName"] as? String).flatMap { $0.isEmpty ? nil : $0 }
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
        await tokenStore.delete(tokenKey(Self.sessionCookiesKey))
    }

    /// Where the names of the cookies this block's exchange set are kept.
    private static var sessionCookiesKey: String { "session_cookies" }

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

    /// The exchange path of the `Auth` block's default routes, the block 0.x versions wrote unscoped tokens for.
    private static var defaultExchangePath: String { "/cdk-blocks/auth/exchange" }

    private static var canonicalPrefix: String { "/cdk-blocks/" }
    private static var legacyPrefix: String { "/aws-blocks/" }

    /// The key prefixes earlier versions stored this block's tokens under, newest first: its `/aws-blocks/`
    /// exchange path, used before the routes moved to `/cdk-blocks/`, then, for the default block, none.
    private var legacyKeyPrefixes: [String] {
        var prefixes: [String] = []
        var canonicalExchangePath = exchangePath
        if exchangePath.hasPrefix(Self.canonicalPrefix) {
            prefixes.append("\(Self.legacyPrefix)\(exchangePath.dropFirst(Self.canonicalPrefix.count))#")
        } else if exchangePath.hasPrefix(Self.legacyPrefix) {
            canonicalExchangePath = "\(Self.canonicalPrefix)\(exchangePath.dropFirst(Self.legacyPrefix.count))"
        }
        if canonicalExchangePath == Self.defaultExchangePath { prefixes.append("") }
        return prefixes
    }

    /// Moves the tokens an earlier version stored under older keys into this client's keys, once per
    /// `BlocksClient` and block, unless it has its own: the block's `/aws-blocks/` keys, else the unscoped keys
    /// of a 0.x version. Only a client on the default routes (`/cdk-blocks/auth/exchange`, or its `/aws-blocks/`
    /// twin) takes the unscoped ones: they belong to that block, so a client for another block leaves them.
    private func adoptLegacyTokens() async {
        let prefixes = legacyKeyPrefixes
        guard !prefixes.isEmpty else { return }
        await client.adoptLegacyTokensOnce(for: exchangePath) { await self.moveLegacyTokens(from: prefixes) }
    }

    private func moveLegacyTokens(from prefixes: [String]) async {
        for name in Self.tokenNames where await tokenStore.get(tokenKey(name)) != nil {
            return
        }
        for prefix in prefixes {
            let names = prefix.isEmpty ? Self.tokenNames : Self.tokenNames + [Self.sessionCookiesKey]
            var moved = false
            for name in names {
                guard let value = await tokenStore.get(prefix + name) else { continue }
                await tokenStore.set(tokenKey(name), value: value)
                await tokenStore.delete(prefix + name)
                moved = true
            }
            if moved { return }
        }
    }

    /// The expiry to store, in epoch milliseconds: now plus the response's `expiresIn` seconds, or its
    /// `expiresAt` (epoch milliseconds) when it has no `expiresIn`. `"0"` (already expired) for neither.
    private static func expiresAt(_ json: [String: Any]) -> String {
        if let seconds = json["expiresIn"] as? NSNumber {
            let nowMs = Int64(Date().timeIntervalSince1970 * 1_000)
            // An `expiresIn` too large (or not finite) for epoch milliseconds would trap, so it reads as
            // expired instead.
            guard let lifetimeMs = Int64(exactly: (seconds.doubleValue * 1_000).rounded()) else { return "0" }
            let (expiresAt, overflow) = nowMs.addingReportingOverflow(lifetimeMs)
            return overflow ? "0" : String(expiresAt)
        }
        if let number = json["expiresAt"] as? NSNumber { return number.stringValue }
        if let str = json["expiresAt"] as? String { return str }
        return "0"
    }
}

// MARK: - Codable

extension OIDCClient: Codable {
    private enum DescriptorKeys: String, CodingKey {
        case blocksType = "__blocks"
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
            callbackPath: hydrated.callbackPath,
            authorizeParamsBasePath: hydrated.authorizeParamsBasePath,
            sessionPath: hydrated.sessionPath,
            sessionCookieName: hydrated.sessionCookieName
        )
    }

    /// Always throws `EncodingError.invalidValue`: transferables are read-only. The conformance exists so a
    /// generated `Codable` model that holds a client compiles.
    public nonisolated func encode(to encoder: Encoder) throws {
        throw TransferableDescriptor.readOnly(self, tag: "oidc/client", encoder: encoder)
    }
}

// MARK: - Errors

public enum OIDCError: BlocksError {
    case unknownProvider(String)
    case invalidAuthorizeURL(String)
    case stateMismatch
    case missingAuthorizationCode
    case malformedExchangeResponse
    /// The sign-in callback failed: the IdP reported an error, the authorize parameters could not
    /// be fetched, or the browser launcher could not open or finish the sign-in. When a request failed,
    /// its `ApiError` or `TransportError` is the cause, so the app can tell a retry-later failure from
    /// a misconfigured one. When `ASWebAuthenticationSession` reported an error, that error is the
    /// cause; a launcher's own refusal, such as a relayTo without a custom scheme, has none.
    case callbackError(String, Error?)
    /// The code exchange was rejected. The server's error is the cause.
    case exchangeFailed(String, Error?)
    /// The user dismissed the sign-in flow. A `BrowserLauncher` throws this.
    case cancelled

    public var message: String {
        switch self {
        case .unknownProvider(let name):
            return "Unknown OIDC provider: \(name)"
        case .invalidAuthorizeURL(let url):
            return "Invalid authorize URL: \(url)"
        case .stateMismatch:
            return "OIDC state mismatch — possible CSRF attack"
        case .missingAuthorizationCode:
            return "Missing authorization code in callback URL"
        case .malformedExchangeResponse:
            return "Malformed exchange response — missing accessToken or refreshToken"
        case .callbackError(let detail, _):
            return "OIDC callback error: \(detail)"
        case .exchangeFailed(let detail, _):
            return "OIDC exchange failed: \(detail)"
        case .cancelled:
            return "Sign-in cancelled"
        }
    }

    public var underlyingError: Error? {
        switch self {
        case .callbackError(_, let error), .exchangeFailed(_, let error): return error
        default: return nil
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

/// Resumes one continuation once: with the awaited task's result, or with `CancellationError` when the
/// waiting caller is cancelled first, even before the continuation exists.
private final class CancellableWaiter: Sendable {
    private struct State {
        var continuation: CheckedContinuation<Void, Error>?
        var outcome: Result<Void, Error>?
        var resumed = false
    }

    private let state = OSAllocatedUnfairLock(initialState: State())

    func start(_ continuation: CheckedContinuation<Void, Error>) {
        let outcome: Result<Void, Error>? = state.withLock { state in
            guard !state.resumed else { return nil }
            if let outcome = state.outcome {
                state.resumed = true
                return outcome
            }
            state.continuation = continuation
            return nil
        }
        if let outcome { continuation.resume(with: outcome) }
    }

    func finish(_ outcome: Result<Void, Error>) {
        let continuation: CheckedContinuation<Void, Error>? = state.withLock { state in
            guard !state.resumed, state.outcome == nil else { return nil }
            guard let continuation = state.continuation else {
                state.outcome = outcome
                return nil
            }
            state.resumed = true
            state.continuation = nil
            return continuation
        }
        continuation?.resume(with: outcome)
    }
}
