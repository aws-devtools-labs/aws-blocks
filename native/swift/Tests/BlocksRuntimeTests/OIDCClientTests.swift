//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

// MARK: - Mock URL protocol

/// Intercepts URLSession requests so tests can stub responses without a network.
final class OIDCMockURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?
    nonisolated(unsafe) static var requests: [URLRequest] = []

    static func reset() {
        handler = nil
        requests = []
    }

    override class func canInit(with request: URLRequest) -> Bool { true } // swiftlint:disable:this static_over_final_class
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request } // swiftlint:disable:this static_over_final_class

    override func startLoading() {
        OIDCMockURLProtocol.requests.append(request)
        guard let handler = OIDCMockURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}
}

func makeMockSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [OIDCMockURLProtocol.self] + (config.protocolClasses ?? [])
    return URLSession(configuration: config)
}

func okResponse(for url: URL) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
}

func errorResponse(for url: URL, status: Int) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
}

/// The JSON body of a request; URLSession hands it to the protocol as a stream.
func requestJSON(_ request: URLRequest) -> [String: Any] {
    var data = request.httpBody ?? Data()
    if let stream = request.httpBodyStream {
        stream.open()
        defer { stream.close() }
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
    }
    return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
}

/// Where an `/auth/exchange` client keeps a token.
func tokenKey(_ name: String, exchangePath: String = "/auth/exchange") -> String {
    "\(exchangePath)#\(name)"
}

/// Holds the first read of `heldKey`, value already taken, until a second arrives or 200 ms pass, so racing moves both read it.
private actor RendezvousTokenStore: TokenStore {
    private var storage: [String: String]
    private let heldKey: String
    private var reads = 0
    private var held: CheckedContinuation<Void, Never>?
    private(set) var writtenKeys: [String] = []

    init(_ storage: [String: String], holding heldKey: String) {
        self.storage = storage
        self.heldKey = heldKey
    }

    func get(_ key: String) async -> String? {
        let value = storage[key]
        if key == heldKey {
            reads += 1
            if reads == 1 {
                await withCheckedContinuation { continuation in
                    held = continuation
                    Task {
                        try? await Task.sleep(for: .milliseconds(200))
                        self.release()
                    }
                }
            } else {
                release()
            }
        }
        return value
    }

    func set(_ key: String, value: String) async {
        storage[key] = value
        writtenKeys.append(key)
    }

    func delete(_ key: String) async {
        storage[key] = nil
    }

    private func release() {
        held?.resume()
        held = nil
    }
}

/// Suspends the first read of an armed key, value already taken, until `release()`, so a test can run
/// another call while the reader is suspended.
actor HoldingTokenStore: TokenStore {
    private var storage: [String: String] = [:]
    private var armedKey: String?
    private var held: CheckedContinuation<Void, Never>?
    private var arrived = false
    private var arrivalWaiter: CheckedContinuation<Void, Never>?

    func arm(_ key: String) {
        armedKey = key
    }

    func waitUntilHeld() async {
        if arrived { return }
        await withCheckedContinuation { arrivalWaiter = $0 }
    }

    func release() {
        held?.resume()
        held = nil
    }

    func get(_ key: String) async -> String? {
        let value = storage[key]
        if key == armedKey {
            armedKey = nil
            arrived = true
            arrivalWaiter?.resume()
            arrivalWaiter = nil
            await withCheckedContinuation { held = $0 }
        }
        return value
    }

    func set(_ key: String, value: String) async {
        storage[key] = value
    }

    func delete(_ key: String) async {
        storage[key] = nil
    }
}

// MARK: - Tests

final class OIDCClientTests: XCTestCase {

    func makeClient(session: URLSession) -> OIDCClient<String> {
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: session)
        return OIDCClient<String>(
            exchangePath: "/auth/exchange",
            refreshPath: "/auth/refresh",
            signOutPath: "/auth/signout",
            providers: ["google"],
            providerConfigs: [
                "google": OIDCProviderConfig(
                    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
                    clientId: "test-client",
                    scopes: ["openid", "email"],
                    kind: "google"
                )
            ],
            baseUrl: "https://api.example.com",
            client: blocksClient
        )
    }

    func makeClient(named namespace: String, on blocksClient: BlocksClient) -> OIDCClient<String> {
        OIDCClient<String>(
            exchangePath: "/\(namespace)/exchange", refreshPath: "/\(namespace)/refresh", signOutPath: "/auth/signout",
            providers: ["google"], providerConfigs: [:], baseUrl: "https://api.example.com", client: blocksClient
        )
    }

    override func setUp() {
        super.setUp()
        OIDCMockURLProtocol.reset()
    }

    // MARK: - PKCE

    func testPKCEGeneration() {
        let verifier = OIDCClient<String>.generateVerifier()
        let challenge = OIDCClient<String>.generateChallenge(verifier)
        XCTAssertFalse(verifier.isEmpty)
        XCTAssertFalse(challenge.isEmpty)
        // base64URL: no '+', '/', or '='
        XCTAssertFalse(verifier.contains("+"))
        XCTAssertFalse(verifier.contains("/"))
        XCTAssertFalse(verifier.contains("="))
        XCTAssertFalse(challenge.contains("="))
        // Same verifier → same challenge (S256 deterministic)
        XCTAssertEqual(challenge, OIDCClient<String>.generateChallenge(verifier))
    }

    func testRandomValuesAreFullLengthNonZeroAndDistinct() throws {
        let values = (0 ..< 8).map { _ in OIDCClient<String>.generateVerifier() } + [OIDCClient<String>.generateNonce()]
        for value in values {
            // 32 bytes → 43 base64url chars (no padding)
            XCTAssertEqual(value.count, 43)
            let bytes = try XCTUnwrap(Data(base64URLDecoded: value))
            XCTAssertEqual(bytes.count, 32)
            XCTAssertFalse(bytes.allSatisfy { $0 == 0 }, "random bytes must not be an all-zero buffer")
        }
        XCTAssertEqual(Set(values).count, values.count)
    }

    // MARK: - Exchange

    func testExchangeStoresTokensAndEmitsSignedIn() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/exchange")
            let body: [String: Any] = [
                "accessToken": "access-1",
                "refreshToken": "refresh-1",
                "expiresIn": 3_600,
                "user": ["userId": "u1", "username": "alice", "groups": ["admins"]]
            ]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (okResponse(for: request.url!), data)
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore

        // Subscribe before kicking off the exchange.
        let stream = await client.authStateChanges().dropFirst()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
                if events.count == 1 { break }
            }
            return events
        }

        let before = Int64(Date().timeIntervalSince1970 * 1_000)
        let user = try await client.exchange(
            code: "code-1",
            verifier: "verifier-1",
            callbackURL: "myapp://callback",
            provider: "google",
            state: "state-1",
            nonce: "nonce-1"
        )

        XCTAssertEqual(user.userId, "u1")
        XCTAssertEqual(user.username, "alice")
        XCTAssertEqual(user.groups, ["admins"])
        let accessToken = await store.get(tokenKey("access_token"))
        let refreshToken = await store.get(tokenKey("refresh_token"))
        let expiresAt = await store.get(tokenKey("expires_at"))
        XCTAssertEqual(accessToken, "access-1")
        XCTAssertEqual(refreshToken, "refresh-1")
        // Now plus `expiresIn` seconds, in epoch milliseconds.
        let expiry = try XCTUnwrap(expiresAt.flatMap { Int64($0) })
        XCTAssertGreaterThanOrEqual(expiry, before + 3_600_000)
        XCTAssertLessThan(expiry, before + 3_660_000)
        let provider = await store.get(tokenKey("provider"))
        XCTAssertEqual(provider, "google")

        let events = await collector.value
        XCTAssertEqual(events, [.signedIn(user)])
    }

    /// An authorize-params response missing a field names that field, and never echoes the response,
    /// which carries the signed state and the nonce.
    func testSignInNamesTheMissingAuthorizeParamsField() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = [
                "authorizeUrl": "https://idp.example.com/authorize", "clientId": "cid", "scopes": ["openid"],
                "nonce": "secret-nonce"
            ]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let client = try Self.authClient(on: blocksClient)

        do {
            _ = try await client.signIn(provider: "google", relayTo: "myapp://auth", launcher: EchoStateRelayLauncher(relay: "myapp://auth"))
            XCTFail("Expected callbackError")
        } catch let error as OIDCError {
            guard case .callbackError(let detail, let cause) = error else { return XCTFail("Expected callbackError, got \(error)") }
            XCTAssertEqual(detail, "authorize-params response has no state")
            XCTAssertNil(cause)
            XCTAssertFalse(error.message.contains("secret-nonce"), error.message)
        }
    }

    func testExchangeAsksForNoBearerTokens() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(requestJSON(request)["tokens"] as? Bool, false)
            let body: [String: Any] = ["user": ["userId": "u1", "username": "alice"]]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())

        _ = try await client.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n")

        XCTAssertEqual(OIDCMockURLProtocol.requests.count, 1)
    }

    func testExchangeThrowsOnMalformedResponse() async {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["nope": "missing tokens"]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (okResponse(for: request.url!), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected malformedExchangeResponse")
        } catch let error as OIDCError {
            guard case .malformedExchangeResponse = error else {
                return XCTFail("Expected malformedExchangeResponse, got \(error)")
            }
        } catch {
            XCTFail("Expected OIDCError, got \(error)")
        }
    }

    func testExchangeSurfacesTheServersErrorOnNon2xx() async {
        // A refused exchange is an HTTP error with the server's error body, not a
        // malformed success: the caller must see the status and the error name.
        OIDCMockURLProtocol.handler = { request in
            // The shape bb-auth's routes answer with (pinned in bb-auth `stub-idp.test.ts`).
            let body: [String: Any] = ["name": "IdpErrorException", "error": "The sign-in provider refused the sign-in."]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (errorResponse(for: request.url!, status: 400), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected ApiError")
        } catch let outer as OIDCError {
            guard let error = outer.underlyingError as? ApiError else {
                return XCTFail("Expected ApiError cause, got \(outer)")
            }
            XCTAssertEqual(error.status, 400)
            XCTAssertEqual(error.name, "IdpErrorException")
            XCTAssertEqual(error.message, "The sign-in provider refused the sign-in.")
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testRawRouteReadsAPlainOAuthErrorBody() async {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["error": "invalid_grant", "error_description": "unknown or expired code"]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (errorResponse(for: request.url!, status: 400), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected ApiError")
        } catch let outer as OIDCError {
            guard let error = outer.underlyingError as? ApiError else {
                return XCTFail("Expected ApiError cause, got \(outer)")
            }
            XCTAssertEqual(error.name, "invalid_grant")
            XCTAssertEqual(error.message, "invalid_grant")
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testRawRouteWrapsAConnectionFailureInATransportError() async {
        OIDCMockURLProtocol.handler = { _ in throw URLError(.cannotConnectToHost) }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected TransportError")
        } catch let outer as OIDCError {
            guard let error = outer.underlyingError as? TransportError else {
                return XCTFail("Expected TransportError cause, got \(outer)")
            }
            XCTAssertNil(error.statusCode)
            XCTAssertNotNil(error.underlyingError)
            XCTAssertEqual((error.underlyingError as? URLError)?.code, .cannotConnectToHost)
        } catch {
            XCTFail("Expected TransportError, got \(error)")
        }
    }

    func testRawRouteKeepsADescriptionWithoutAnErrorCode() async {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["error_description": "unknown or expired code"]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (errorResponse(for: request.url!, status: 400), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected ApiError")
        } catch let outer as OIDCError {
            guard let error = outer.underlyingError as? ApiError else {
                return XCTFail("Expected ApiError cause, got \(outer)")
            }
            XCTAssertNil(error.name)
            XCTAssertEqual(error.message, "unknown or expired code")
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testRawRouteKeepsANamelessMessageOutOfErrorName() async {
        // A CDK Blocks route that answers with a message and no `name`
        // (`{ error: 'Missing required fields' }`): the message is detail, not a name.
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["error": "Missing required fields"]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (errorResponse(for: request.url!, status: 400), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected ApiError")
        } catch let outer as OIDCError {
            guard let error = outer.underlyingError as? ApiError else {
                return XCTFail("Expected ApiError cause, got \(outer)")
            }
            XCTAssertNil(error.name)
            XCTAssertEqual(error.message, "Missing required fields")
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testRawRouteReadsABareErrorCodeAsTheName() async {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["error": "invalid_grant"]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (errorResponse(for: request.url!, status: 400), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected ApiError")
        } catch let outer as OIDCError {
            guard let error = outer.underlyingError as? ApiError else {
                return XCTFail("Expected ApiError cause, got \(outer)")
            }
            XCTAssertEqual(error.name, "invalid_grant")
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testExchangeSurfacesANonJSONErrorBodyAsATransportError() async {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 502), Data("<html>Bad Gateway</html>".utf8))
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected TransportError")
        } catch let outer as OIDCError {
            guard let error = outer.underlyingError as? TransportError else {
                return XCTFail("Expected TransportError cause, got \(outer)")
            }
            XCTAssertEqual(error.statusCode, 502)
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    // MARK: - Refresh

    /// The response the server sends (`federation-routes.ts`): `{ accessToken, refreshToken, expiresIn }`,
    /// `expiresIn` in seconds, with a rotated refresh token.
    func testRefreshStoresTheRotatedTokensAndExpiry() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/refresh")
            XCTAssertEqual(requestJSON(request) as? [String: String], ["refreshToken": "refresh-1", "provider": "github"])
            let body: [String: Any] = ["accessToken": "access-2", "refreshToken": "refresh-2", "expiresIn": 3_600]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "refresh-1")
        await store.set(tokenKey("provider"), value: "github")
        let before = Int64(Date().timeIntervalSince1970 * 1_000)

        try await client.refresh()

        let accessToken = await store.get(tokenKey("access_token"))
        let refreshToken = await store.get(tokenKey("refresh_token"))
        let storedExpiry = await store.get(tokenKey("expires_at"))
        let expiry = try XCTUnwrap(storedExpiry.flatMap { Int64($0) })
        XCTAssertEqual(accessToken, "access-2")
        XCTAssertEqual(refreshToken, "refresh-2")
        XCTAssertGreaterThanOrEqual(expiry, before + 3_600_000)
        let token = await client.getAccessToken()
        XCTAssertEqual(token, "access-2", "a refreshed token reads as not expired")
    }

    func testRefreshFallsBackToExpiresAtAndKeepsAnUnrotatedRefreshToken() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertNil(requestJSON(request)["provider"], "no provider was stored")
            let body: [String: Any] = ["accessToken": "access-2", "expiresAt": 9_999_999_999_000]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "refresh-existing")

        try await client.refresh()

        let refreshToken = await store.get(tokenKey("refresh_token"))
        let expiry = await store.get(tokenKey("expires_at"))
        XCTAssertEqual(refreshToken, "refresh-existing")
        XCTAssertEqual(expiry, "9999999999000")
    }

    func testRefreshFailureClearsTokensAndEmitsSignedOut() async throws {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 401), Data("{}".utf8))
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "expired")
        await store.set(tokenKey("refresh_token"), value: "rt")
        await store.set(tokenKey("expires_at"), value: "0")

        let stream = await client.authStateChanges().dropFirst()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
                if events.count == 1 { break }
            }
            return events
        }

        try await client.refresh()

        let accessToken = await store.get(tokenKey("access_token"))
        let refreshToken = await store.get(tokenKey("refresh_token"))
        let events = await collector.value
        XCTAssertNil(accessToken)
        XCTAssertNil(refreshToken)
        XCTAssertEqual(events, [.signedOut])
    }

    /// Only a refusal from the refresh route ends the session: a server error or no network throws and keeps
    /// the tokens and the state.
    func testRefreshFailureThatIsNotARefusalKeepsTheSession() async throws {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 503), Data("{}".utf8))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "expired")
        await store.set(tokenKey("refresh_token"), value: "rt")
        await store.set(tokenKey("expires_at"), value: "0")

        let events = await states(of: client) {
            do {
                try await client.refresh()
                XCTFail("Expected ApiError")
            } catch let error as ApiError {
                XCTAssertEqual(error.status, 503)
            } catch {
                XCTFail("Expected ApiError, got \(error)")
            }
        }

        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(refresh, "rt")
        XCTAssertEqual(events, [])
        let token = await client.getAccessToken()
        XCTAssertNil(token, "getAccessToken has no fresh token to give")
        let kept = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(kept, "rt", "getAccessToken keeps the refresh token too")
    }

    /// A 2xx refresh response without an access token is no usable result: it throws and keeps the session.
    func testRefreshResponseWithoutAnAccessTokenThrowsAndKeepsTheSession() async throws {
        OIDCMockURLProtocol.handler = { request in
            (okResponse(for: request.url!), Data("{}".utf8))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")

        let events = await states(of: client) {
            do {
                try await client.refresh()
                XCTFail("Expected TransportError")
            } catch let error as TransportError {
                XCTAssertTrue(error.message.contains("accessToken"), error.message)
            } catch {
                XCTFail("Expected TransportError, got \(error)")
            }
        }

        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(refresh, "rt")
        XCTAssertEqual(events, [])
    }

    /// A refresh that a sign-out overtook stores nothing: the signed-out client stays signed out.
    func testARefreshThatFinishesAfterASignOutStoresNothing() async throws {
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            let body: [String: Any] = url.path.hasSuffix("/refresh")
                ? ["accessToken": "at-late", "refreshToken": "rt-late", "expiresIn": 3_600]
                : [:]
            return (okResponse(for: url), try JSONSerialization.data(withJSONObject: body))
        }
        let (client, store) = try await holdingClient()
        let key = { (name: String) in tokenKey(name, exchangePath: "/cdk-blocks/auth/exchange") }
        await store.set(key("refresh_token"), value: "rt")
        await store.arm(key("refresh_token"))

        let refreshing = Task { try await client.refresh() }
        await store.waitUntilHeld()
        _ = try await client.signOut()
        await store.release()
        try await refreshing.value

        let access = await store.get(key("access_token"))
        let refresh = await store.get(key("refresh_token"))
        XCTAssertNil(access)
        XCTAssertNil(refresh)
        let state = await client.authState
        XCTAssertEqual(state, .signedOut)
    }

    /// A cookie session stores no refresh token (the exchange asks for none), so `refresh()` and
    /// `onAuthFailure()` have nothing to refresh: they send no request and leave the signed-in state
    /// alone. The cookie session is `restore()`'s to read.
    func testRefreshWithoutARefreshTokenLeavesACookieSessionSignedIn() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["user": ["userId": "u1", "username": "alice"]]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let user = try await client.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n")

        let events = try await states(of: client) {
            try await client.refresh()
            await client.onAuthFailure()
        }

        XCTAssertEqual(events, [])
        let state = await client.authState
        XCTAssertEqual(state, .signedIn(user))
        XCTAssertEqual(OIDCMockURLProtocol.requests.count, 1, "only the exchange: no refresh request")
    }

    // MARK: - getAccessToken

    func testGetAccessTokenReturnsNilWhenAbsent() async {
        let client = makeClient(session: makeMockSession())
        let token = await client.getAccessToken()
        XCTAssertNil(token)
    }

    func testGetAccessTokenReturnsTokenWhenValid() async {
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "at-1")
        await store.set(tokenKey("expires_at"), value: "9999999999000")
        let token = await client.getAccessToken()
        XCTAssertEqual(token, "at-1")
    }

    // MARK: - authState

    /// A new subscriber receives the current state first, then each transition.
    func testAuthStateChangesYieldsTheCurrentStateFirst() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["user": ["userId": "u1", "username": "alice"]]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let user = OIDCUser(userId: "u1", username: "alice", groups: [])

        var fresh = await client.authStateChanges().makeAsyncIterator()
        let initial = await fresh.next()
        XCTAssertEqual(initial, .loading)

        _ = try await client.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n")
        let transition = await fresh.next()
        XCTAssertEqual(transition, .signedIn(user))

        var late = await client.authStateChanges().makeAsyncIterator()
        let current = await late.next()
        XCTAssertEqual(current, .signedIn(user), "a later subscriber starts at the current state")
    }

    func testAuthStateIsLoadingBeforeAnyStateIsEmitted() async {
        let client = makeClient(session: makeMockSession())
        let state = await client.authState
        XCTAssertEqual(state, .loading)
    }

    func testAuthStateIsTheStateMostRecentlyEmitted() async throws {
        let client = makeClient(session: makeMockSession())
        let user = OIDCUser(userId: "u1", username: "alice", groups: [])

        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = [
                "accessToken": "at", "refreshToken": "rt", "expiresIn": 3_600,
                "user": ["userId": "u1", "username": "alice", "groups": [String]()]
            ]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        var events = try await states(of: client) {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "myapp://callback", provider: "google", state: "s", nonce: "n"
            )
        }
        var state = await client.authState
        XCTAssertEqual(events, [.signedIn(user)])
        XCTAssertEqual(state, events.last)

        // A restore that fails emits nothing and leaves the state as it was.
        OIDCMockURLProtocol.handler = { request in (errorResponse(for: request.url!, status: 500), Data("{}".utf8)) }
        events = await states(of: client) {
            _ = try? await client.restore()
        }
        state = await client.authState
        XCTAssertEqual(events, [])
        XCTAssertEqual(state, .signedIn(user))

        OIDCMockURLProtocol.handler = { request in (okResponse(for: request.url!), Data("{}".utf8)) }
        events = try await states(of: client) {
            _ = try await client.signOut()
        }
        state = await client.authState
        XCTAssertEqual(events, [.signedOut])
        XCTAssertEqual(state, events.last)
    }

    /// A client hydrated from a descriptor sets the state on the relay sign-in and on a restore that
    /// finds no session.
    func testAuthStateFollowsAHydratedClientsSignInAndRestore() async throws {
        stubAuthRoutes()
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let client = try Self.authClient(on: blocksClient)

        let user = try await client.signIn(provider: "google", relayTo: "myapp://auth", launcher: EchoStateRelayLauncher(relay: "myapp://auth?code=c"))
        var state = await client.authState
        XCTAssertEqual(state, .signedIn(user))

        OIDCMockURLProtocol.handler = { request in
            let body = ["error": "Not signed in", "name": "NotAuthenticatedException"]
            return (errorResponse(for: request.url!, status: 401), try JSONSerialization.data(withJSONObject: body))
        }
        let restored = try await client.restore()
        state = await client.authState
        XCTAssertNil(restored)
        XCTAssertEqual(state, .signedOut)
    }

    func testAuthStateIsSignedOutAfterAnIncompleteSignOut() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body = ["error": "The session could not be removed.", "name": "SignOutIncompleteException"]
            return (errorResponse(for: request.url!, status: 503), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        await client.client.tokenStore.set(tokenKey("refresh_token"), value: "rt")

        let events = await states(of: client) {
            _ = try? await client.signOut()
        }

        let state = await client.authState
        XCTAssertEqual(events, [.signedOut])
        XCTAssertEqual(state, .signedOut)
    }

    // MARK: - authStateChanges fan-out

    func testAuthStateChangesFanOutToMultipleSubscribers() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = [
                "accessToken": "access-1",
                "refreshToken": "refresh-1",
                "expiresAt": 9_999_999_999_000,
                "user": ["userId": "u1", "username": "alice", "groups": [String]()]
            ]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }

        let client = makeClient(session: makeMockSession())

        let stream1 = await client.authStateChanges().dropFirst()
        let stream2 = await client.authStateChanges().dropFirst()

        let collector1 = Task<OIDCAuthState?, Never> {
            for await event in stream1 {
                return event
            }
            return nil
        }
        let collector2 = Task<OIDCAuthState?, Never> {
            for await event in stream2 {
                return event
            }
            return nil
        }

        _ = try await client.exchange(
            code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
        )

        let event1 = await collector1.value
        let event2 = await collector2.value
        XCTAssertNotNil(event1)
        XCTAssertEqual(event1, event2)
        if case .signedIn = event1 {} else { XCTFail("Expected signedIn") }
    }

    // MARK: - Shared token store

    func testClientsSharingAStoreKeepSeparateSessions() async throws {
        OIDCMockURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            let namespace = path.split(separator: "/").first.map(String.init) ?? ""
            let body: [String: Any] = if path.hasSuffix("/exchange") {
                ["accessToken": "\(namespace)-access", "refreshToken": "\(namespace)-refresh", "expiresIn": 3_600,
                 "user": ["userId": namespace, "username": namespace, "groups": []]]
            } else if path.hasSuffix("/refresh") {
                // Echoes the refresh token, so the test sees whose session was refreshed.
                ["accessToken": "renewed-with-\(requestJSON(request)["refreshToken"] as? String ?? "")", "expiresAt": 9_999_999_999_000]
            } else {
                [:]
            }
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let shared = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let auth = makeClient(named: "auth", on: shared)
        let admin = makeClient(named: "admin", on: shared)
        for client in [auth, admin] {
            _ = try await client.exchange(code: "c", verifier: "v", callbackURL: "x://cb", provider: "google", state: "s", nonce: "n")
        }

        try await auth.refresh()
        try await admin.signOut()

        let authToken = await auth.getAccessToken()
        let adminToken = await admin.getAccessToken()
        XCTAssertEqual(authToken, "renewed-with-auth-refresh")
        XCTAssertNil(adminToken)
    }

    /// The unscoped tokens a 0.x version stored belong to the `Auth` block's default routes: only the client
    /// on `/cdk-blocks/auth/exchange` takes them, once.
    func testTokensUnderTheUnscopedKeysAreAdoptedOnce() async {
        let shared = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let store = shared.tokenStore
        await store.set("access_token", value: "legacy-access")
        await store.set("refresh_token", value: "legacy-refresh")
        await store.set("expires_at", value: "9999999999000")
        let client = makeClient(named: "cdk-blocks/auth", on: shared)
        let second = makeClient(named: "cdk-blocks/auth", on: shared)

        let token = await client.getAccessToken()
        let secondToken = await second.getAccessToken()
        let scoped = await store.get(tokenKey("refresh_token", exchangePath: "/cdk-blocks/auth/exchange"))
        let legacy = await store.get("refresh_token")
        XCTAssertEqual(token, "legacy-access")
        XCTAssertEqual(secondToken, "legacy-access", "a second client for the same block reads the moved session")
        XCTAssertEqual(scoped, "legacy-refresh")
        XCTAssertNil(legacy)
    }

    /// A client for another block, used first, leaves the unscoped tokens for the default block's client.
    func testAnotherBlocksClientUsedFirstLeavesTheUnscopedTokens() async {
        let shared = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let store = shared.tokenStore
        await store.set("access_token", value: "legacy-access")
        await store.set("refresh_token", value: "legacy-refresh")
        await store.set("expires_at", value: "9999999999000")
        let sso = makeClient(named: "cdk-blocks/auth/sso", on: shared)
        let main = makeClient(named: "cdk-blocks/auth", on: shared)

        let ssoToken = await sso.getAccessToken()
        let stillUnscoped = await store.get("refresh_token")
        let mainToken = await main.getAccessToken()

        XCTAssertNil(ssoToken)
        XCTAssertEqual(stillUnscoped, "legacy-refresh")
        XCTAssertEqual(mainToken, "legacy-access")
        let ssoScoped = await store.get(tokenKey("refresh_token", exchangePath: "/cdk-blocks/auth/sso/exchange"))
        XCTAssertNil(ssoScoped)
    }

    /// Tokens stored under a block's `/aws-blocks/` exchange path, before the routes moved to `/cdk-blocks/`,
    /// move to that block's `/cdk-blocks/` keys, ahead of any unscoped ones.
    func testTokensUnderTheLegacyPrefixedKeysMoveToEachBlock() async {
        let shared = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let store = shared.tokenStore
        await store.set("access_token", value: "unscoped-access")
        await store.set("expires_at", value: "9999999999000")
        for (block, token) in [("auth", "main-access"), ("auth/sso", "sso-access")] {
            await store.set(tokenKey("access_token", exchangePath: "/aws-blocks/\(block)/exchange"), value: token)
            await store.set(tokenKey("expires_at", exchangePath: "/aws-blocks/\(block)/exchange"), value: "9999999999000")
        }
        let main = makeClient(named: "cdk-blocks/auth", on: shared)
        let sso = makeClient(named: "cdk-blocks/auth/sso", on: shared)

        let ssoToken = await sso.getAccessToken()
        let mainToken = await main.getAccessToken()
        let legacyMain = await store.get(tokenKey("access_token", exchangePath: "/aws-blocks/auth/exchange"))
        let unscoped = await store.get("access_token")
        XCTAssertEqual(ssoToken, "sso-access")
        XCTAssertEqual(mainToken, "main-access")
        XCTAssertNil(legacyMain)
        XCTAssertEqual(unscoped, "unscoped-access")
    }

    /// A default block pinned to its `/aws-blocks/` routes still takes the unscoped tokens.
    func testDefaultBlockOnTheLegacyPrefixAdoptsTheUnscopedTokens() async {
        let shared = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let store = shared.tokenStore
        await store.set("access_token", value: "legacy-access")
        await store.set("expires_at", value: "9999999999000")
        let main = makeClient(named: "aws-blocks/auth", on: shared)

        let token = await main.getAccessToken()
        let unscoped = await store.get("access_token")
        XCTAssertEqual(token, "legacy-access")
        XCTAssertNil(unscoped)
    }

    func testClientsFirstUsingTheStoreTogetherAdoptTheUnscopedSessionOnce() async {
        let store = RendezvousTokenStore(
            ["access_token": "legacy-access", "refresh_token": "legacy-refresh", "expires_at": "9999999999000"],
            holding: "access_token"
        )
        let shared = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession(), tokenStore: store)
        let auth = makeClient(named: "cdk-blocks/auth", on: shared)
        let sso = makeClient(named: "cdk-blocks/auth/sso", on: shared)

        async let authToken = auth.getAccessToken()
        async let ssoToken = sso.getAccessToken()
        let tokens = await [authToken, ssoToken]

        let adopters = await Set(store.writtenKeys.map { $0.components(separatedBy: "#")[0] })
        XCTAssertEqual(adopters, ["/cdk-blocks/auth/exchange"], "only the default block's client adopts the old session")
        XCTAssertEqual(tokens, ["legacy-access", nil])
        XCTAssertTrue(OIDCMockURLProtocol.requests.isEmpty)
    }

    // Each getClient() hydrates a new OIDCClient, so one exchange path can have several.
    func testClientsOnOneExchangePathWaitForTheMoveOfTheUnscopedSession() async {
        let store = RendezvousTokenStore(
            ["access_token": "legacy-access", "refresh_token": "legacy-refresh", "expires_at": "9999999999000"],
            holding: "access_token"
        )
        let shared = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession(), tokenStore: store)
        let first = makeClient(named: "cdk-blocks/auth", on: shared)
        let second = makeClient(named: "cdk-blocks/auth", on: shared)

        async let firstToken = first.getAccessToken()
        async let secondToken = second.getAccessToken()
        let tokens = await [firstToken, secondToken]

        XCTAssertEqual(tokens, ["legacy-access", "legacy-access"])
        XCTAssertTrue(OIDCMockURLProtocol.requests.isEmpty)
    }

    // MARK: - fromJSON

    func testFromJSONHydratesFromDescriptor() throws {
        let descriptor: [String: Any] = [
            "exchangePath": "/auth/exchange",
            "signOutPath": "/auth/signout",
            "providers": ["google"],
            "providerConfigs": [
                "google": [
                    "authorizeUrl": "https://accounts.google.com/auth",
                    "clientId": "client-1",
                    "scopes": ["openid"],
                    "kind": "google"
                ]
            ]
        ]
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api")
        let client = try OIDCClient<String>.fromJSON(descriptor, baseUrl: "https://api.example.com", client: blocksClient)
        XCTAssertEqual(client.providers, ["google"])
        XCTAssertEqual(client.exchangePath, "/auth/exchange")
        // Defaulted refreshPath
        XCTAssertEqual(client.refreshPath, "/auth/exchange/refresh")
        XCTAssertEqual(client.signOutPath, "/auth/signout")
    }

    /// The routes `OIDCClient` derives from `exchangePath` must be the ones the `Auth` block
    /// serves (packages/bb-auth DESIGN.md → Routes): `POST <base>/authorize-params/<id>`,
    /// `GET <base>/callback` as the IdP `redirect_uri`, `POST <base>/exchange`, and
    /// `POST <base>/exchange/refresh` as the default refresh path.
    func testSignInDerivesTheAuthBlockRoutesFromExchangePath() async throws {
        let session = makeMockSession()
        stubAuthRoutes()
        let blocksClient = BlocksClient(url: "https://api.example.com/prod/cdk-blocks/api", session: session)
        let client = try OIDCClient<String>.fromJSON(
            [
                "exchangePath": "/cdk-blocks/auth/exchange",
                "signOutPath": "/cdk-blocks/auth/signout",
                "providers": ["google"]
            ],
            baseUrl: blocksClient.baseUrl,
            client: blocksClient
        )
        let launcher = EchoStateRelayLauncher(relay: "nativebindings://auth?code=c")

        let user = try await client.signIn(provider: "google", relayTo: "nativebindings://auth", launcher: launcher)

        XCTAssertEqual(user.userId, "u1")
        XCTAssertEqual(client.refreshPath, "/cdk-blocks/auth/exchange/refresh")
        XCTAssertEqual(
            OIDCMockURLProtocol.requests.compactMap { $0.url?.absoluteString },
            [
                "https://api.example.com/prod/cdk-blocks/auth/authorize-params/google",
                "https://api.example.com/prod/cdk-blocks/auth/exchange"
            ]
        )
        let authorizeURL = try XCTUnwrap(launcher.authorizeURL)
        let redirectURI = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "redirect_uri" }?.value
        XCTAssertEqual(redirectURI, "https://api.example.com/prod/cdk-blocks/auth/callback")
    }

    // MARK: - Descriptor routes

    /// The `oidc/client` descriptor `Auth.createOidcApi().getClient()` sends for a block whose routes
    /// sit under `base`, with `callback` as its `redirects.callbackPath`.
    static func authDescriptor(
        base: String = "/cdk-blocks/auth",
        callback: String? = nil,
        providers: [String] = ["google"],
        sessionCookieName: String? = nil
    ) -> [String: Any] {
        var descriptor: [String: Any] = [
            "__blocks": "oidc/client",
            "providers": providers,
            "providerConfigs": [String: Any](),
            "callbackPath": callback ?? "\(base)/callback",
            "exchangePath": "\(base)/exchange",
            "signOutPath": "\(base)/signout",
            "signInBasePath": "\(base)/signin",
            "authorizeParamsBasePath": "\(base)/authorize-params"
        ]
        if let sessionCookieName { descriptor["sessionCookieName"] = sessionCookieName }
        return descriptor
    }

    /// A client hydrated from `authDescriptor`, as `blocks.<ns>.getClient()` returns it.
    static func authClient(
        on blocksClient: BlocksClient,
        base: String = "/cdk-blocks/auth",
        callback: String? = nil,
        providers: [String] = ["google"],
        sessionCookieName: String? = nil
    ) throws -> OIDCClient<String> {
        try OIDCClient<String>.fromJSON(
            authDescriptor(base: base, callback: callback, providers: providers, sessionCookieName: sessionCookieName),
            baseUrl: blocksClient.baseUrl,
            client: blocksClient
        )
    }

    /// Answers authorize-params with a signed-state envelope carrying the request's `csrf`, as the
    /// server does, and the exchange with a user.
    private func stubAuthRoutes() {
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            if url.path.contains("/authorize-params/") {
                let csrf = requestJSON(request)["csrf"] as? String ?? ""
                let payload = try JSONSerialization.data(withJSONObject: ["v": 1, "csrf": csrf])
                let state = Self.base64URL(payload) + ".sig"
                let body = try JSONSerialization.data(withJSONObject: [
                    "authorizeUrl": "https://idp.example.com/authorize",
                    "clientId": "cid",
                    "scopes": ["openid"],
                    "kind": "oidc",
                    "state": state
                ])
                return (okResponse(for: url), body)
            }
            let body = try JSONSerialization.data(withJSONObject: ["user": ["userId": "u1", "username": "dave"]])
            return (okResponse(for: url), body)
        }
    }

    private static func base64URL(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    /// A block whose `redirects.callbackPath` isn't named `callback`: the client signs in at the
    /// descriptor's routes, and the IdP `redirect_uri` is the block's own callback.
    func testFromJSONSignsInAtTheDescriptorsCallbackAndAuthorizeParamsPaths() async throws {
        stubAuthRoutes()
        let blocksClient = BlocksClient(url: "https://api.example.com/prod/cdk-blocks/api", session: makeMockSession())
        let client = try Self.authClient(
            on: blocksClient,
            base: "/cdk-blocks/auth/sso",
            callback: "/cdk-blocks/auth/sso/return",
            providers: ["corp sso"]
        )
        let launcher = EchoStateRelayLauncher(relay: "nativebindings://auth?code=c")

        let user = try await client.signIn(provider: "corp sso", relayTo: "nativebindings://auth", launcher: launcher)

        XCTAssertEqual(user.userId, "u1")
        XCTAssertEqual(client.callbackPath, "/cdk-blocks/auth/sso/return")
        XCTAssertEqual(client.authorizeParamsBasePath, "/cdk-blocks/auth/sso/authorize-params")
        XCTAssertEqual(
            OIDCMockURLProtocol.requests.compactMap { $0.url?.absoluteString },
            [
                "https://api.example.com/prod/cdk-blocks/auth/sso/authorize-params/corp%20sso",
                "https://api.example.com/prod/cdk-blocks/auth/sso/exchange"
            ]
        )
        let exchange = requestJSON(OIDCMockURLProtocol.requests[1])
        XCTAssertEqual(exchange["callbackUrl"] as? String, "https://api.example.com/prod/cdk-blocks/auth/sso/return")
        let authorizeURL = try XCTUnwrap(launcher.authorizeURL)
        let redirectURI = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "redirect_uri" }?.value
        XCTAssertEqual(redirectURI, "https://api.example.com/prod/cdk-blocks/auth/sso/return")
    }

    func testDecodedClientKeepsTheDescriptorsRoutePaths() throws {
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api")
        let data = try JSONSerialization.data(withJSONObject: Self.authDescriptor(
            base: "/cdk-blocks/auth/sso",
            callback: "/cdk-blocks/auth/sso/return"
        ))
        let client = try blocksClient.makeDecoder().decode(OIDCClient<String>.self, from: data)
        XCTAssertEqual(client.callbackPath, "/cdk-blocks/auth/sso/return")
        XCTAssertEqual(client.authorizeParamsBasePath, "/cdk-blocks/auth/sso/authorize-params")
    }

    /// A client built with `init` for a block whose callback isn't named `callback`
    /// (`redirects.callbackPath: '/cdk-blocks/auth/partner/return'`) signs in through the paths it was given,
    /// not ones derived from `exchangePath`.
    func testSignInUsesTheCallbackAndAuthorizeParamsPathsPassedToInit() async throws {
        stubAuthRoutes()
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let client = OIDCClient<String>(
            exchangePath: "/cdk-blocks/auth/partner/exchange",
            refreshPath: "/cdk-blocks/auth/partner/exchange/refresh",
            signOutPath: "/cdk-blocks/auth/partner/signout",
            providers: ["google"],
            providerConfigs: [:],
            baseUrl: blocksClient.baseUrl,
            client: blocksClient,
            authorizeParamsBasePath: "/cdk-blocks/auth/partner/authorize-params",
            callbackPath: "/cdk-blocks/auth/partner/return"
        )
        let launcher = EchoStateRelayLauncher(relay: "nativebindings://auth?code=c")

        _ = try await client.signIn(provider: "google", relayTo: "nativebindings://auth", launcher: launcher)

        XCTAssertEqual(client.sessionPath, "/cdk-blocks/auth/partner/session")
        XCTAssertEqual(
            OIDCMockURLProtocol.requests.compactMap { $0.url?.absoluteString },
            [
                "https://api.example.com/cdk-blocks/auth/partner/authorize-params/google",
                "https://api.example.com/cdk-blocks/auth/partner/exchange"
            ]
        )
        let authorizeURL = try XCTUnwrap(launcher.authorizeURL)
        let redirectURI = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "redirect_uri" }?.value
        XCTAssertEqual(redirectURI, "https://api.example.com/cdk-blocks/auth/partner/return")
    }

    func testExchangeRefusesAnUnknownProviderBeforeAnyRequest() async {
        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "github", state: "s", nonce: "n")
            XCTFail("Expected unknownProvider")
        } catch let error as OIDCError {
            guard case .unknownProvider("github") = error else { return XCTFail("Expected unknownProvider, got \(error)") }
        } catch {
            XCTFail("Expected OIDCError, got \(error)")
        }
        XCTAssertTrue(OIDCMockURLProtocol.requests.isEmpty)
    }

    /// The relay's state is checked against the csrf this client sent, and refused when its
    /// envelope can't be decoded or carries no csrf.
    func testSignInRefusesAStateWhoseCsrfCannotBeChecked() async throws {
        let payloads: [String] = [
            "no-dot-state",
            "!!!.sig",
            Self.base64URL(Data("not json".utf8)) + ".sig",
            Self.base64URL(try JSONSerialization.data(withJSONObject: ["v": 1])) + ".sig",
            Self.base64URL(try JSONSerialization.data(withJSONObject: ["v": 1, "csrf": "someone-elses"])) + ".sig"
        ]
        for state in payloads {
            OIDCMockURLProtocol.reset()
            OIDCMockURLProtocol.handler = { request in
                let body = try JSONSerialization.data(withJSONObject: [
                    "authorizeUrl": "https://idp.example.com/authorize", "clientId": "cid",
                    "scopes": ["openid"], "kind": "oidc", "state": state
                ])
                return (okResponse(for: request.url!), body)
            }
            let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
            let client = try Self.authClient(on: blocksClient)

            do {
                _ = try await client.signIn(
                    provider: "google",
                    relayTo: "myapp://auth",
                    launcher: EchoStateRelayLauncher(relay: "myapp://auth?code=c")
                )
                XCTFail("Expected stateMismatch for \(state)")
            } catch let error as OIDCError {
                if case .stateMismatch = error {} else { XCTFail("Expected stateMismatch for \(state), got \(error)") }
            }
            XCTAssertEqual(OIDCMockURLProtocol.requests.count, 1, "no exchange for \(state)")
        }
    }

    func testSignInChecksTheStateBeforeTheIdPError() async throws {
        stubAuthRoutes()
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let client = try Self.authClient(on: blocksClient)

        // An error without the sign-in's state is refused as a mismatch, whatever its text.
        do {
            _ = try await client.signIn(
                provider: "google",
                relayTo: "myapp://auth",
                launcher: FixedRelayLauncher(relay: "myapp://auth?error=access_denied&error_description=chosen-text")
            )
            XCTFail("Expected stateMismatch")
        } catch let error as OIDCError {
            if case .stateMismatch = error {} else { XCTFail("Expected stateMismatch, got \(error)") }
        }

        // With the sign-in's state, the IdP error is reported.
        do {
            _ = try await client.signIn(
                provider: "google",
                relayTo: "myapp://auth",
                launcher: EchoStateRelayLauncher(relay: "myapp://auth?error=access_denied&error_description=denied")
            )
            XCTFail("Expected callbackError")
        } catch let error as OIDCError {
            guard case .callbackError(let detail, let cause) = error else { return XCTFail("Expected callbackError, got \(error)") }
            XCTAssertEqual(detail, "access_denied: denied")
            XCTAssertNil(cause)
        }
        XCTAssertFalse(
            OIDCMockURLProtocol.requests.contains { $0.url?.path.hasSuffix("/exchange") == true },
            "no exchange after a refused relay"
        )
    }

    /// A relay with the right state and an IdP error, but whose envelope carries another sign-in's
    /// csrf, is refused as a mismatch: the csrf is checked before the error is reported.
    func testSignInChecksTheEnvelopeCsrfBeforeTheIdPError() async throws {
        let state = Self.base64URL(try JSONSerialization.data(withJSONObject: ["v": 1, "csrf": "someone-elses"])) + ".sig"
        OIDCMockURLProtocol.handler = { request in
            let body = try JSONSerialization.data(withJSONObject: [
                "authorizeUrl": "https://idp.example.com/authorize", "clientId": "cid",
                "scopes": ["openid"], "kind": "oidc", "state": state
            ])
            return (okResponse(for: request.url!), body)
        }
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let client = try Self.authClient(on: blocksClient)

        do {
            _ = try await client.signIn(
                provider: "google",
                relayTo: "myapp://auth",
                launcher: EchoStateRelayLauncher(relay: "myapp://auth?error=access_denied&error_description=chosen-text")
            )
            XCTFail("Expected stateMismatch")
        } catch let error as OIDCError {
            if case .stateMismatch = error {} else { XCTFail("Expected stateMismatch, got \(error)") }
        }
        XCTAssertEqual(OIDCMockURLProtocol.requests.count, 1, "no exchange")
    }

    /// The origin raw routes use the client URL cut at its first `cdk-blocks` or legacy `aws-blocks` segment.
    func testRawRouteBaseKeepsTheStageAndCutsAtTheFirstBlocksSegment() {
        let cases = [
            ("https://x.execute-api.us-east-1.amazonaws.com/prod/cdk-blocks/api",
             "https://x.execute-api.us-east-1.amazonaws.com/prod"),
            ("https://d1.cloudfront.net/cdk-blocks/api", "https://d1.cloudfront.net"),
            ("https://d1.cloudfront.net/cdk-blocks/api/cdk-blocks/api", "https://d1.cloudfront.net"),
            ("https://host/prod/aws-blocks/api", "https://host/prod"),
            ("http://localhost:3001", "http://localhost:3001"),
            ("http://[::1]:3001/cdk-blocks/api", "http://[::1]:3001"),
            ("https://x.example.com/pr%20od/cdk-blocks/api", "https://x.example.com/pr%20od"),
            ("http://localhost:3001/", "http://localhost:3001")
        ]
        for (url, origin) in cases {
            XCTAssertEqual(BlocksClient(url: url).rawRouteBase, origin, url)
        }
    }

    func testFromJSONReadsTheSessionCookieName() throws {
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api")
        let named = try Self.authClient(on: blocksClient, sessionCookieName: "auth_app")
        XCTAssertEqual(named.sessionCookieName, "auth_app")
        let older = try Self.authClient(on: blocksClient)
        XCTAssertNil(older.sessionCookieName, "an older backend sends no sessionCookieName")
    }

    func testFromJSONThrowsOnMissingExchangePath() {
        let descriptor: [String: Any] = ["signOutPath": "/auth/signout"]
        XCTAssertThrowsError(try OIDCClient<String>.fromJSON(descriptor, baseUrl: "x", client: BlocksClient(url: "x"))) { error in
            guard case .invalidDescriptor(let blocksType, let missingField)? = error as? TransferableError else {
                return XCTFail("Expected TransferableError.invalidDescriptor, got \(error)")
            }
            XCTAssertEqual(blocksType, "oidc")
            XCTAssertEqual(missingField, "exchangePath")
        }
    }

    // MARK: - Error taxonomy

    func testCancelledCarriesAMessage() {
        XCTAssertEqual(OIDCError.cancelled.message, "Sign-in cancelled")
        XCTAssertNil(OIDCError.cancelled.underlyingError)
    }

    func testRejectedExchangeIsWrappedInAnOIDCError() async {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["error": "invalid_grant", "error_description": "unknown or expired code"]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (errorResponse(for: request.url!, status: 400), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.exchange(
                code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
            )
            XCTFail("Expected OIDCError.exchangeFailed")
        } catch let error as OIDCError {
            guard case .exchangeFailed = error else {
                return XCTFail("Expected exchangeFailed, got \(error)")
            }
            XCTAssertTrue(error.underlyingError is ApiError, "\(String(describing: error.underlyingError))")
        } catch {
            XCTFail("Expected OIDCError, got \(error)")
        }
    }

    func testAuthorizeParamsFailureSurfacesAsOIDCCallbackError() async {
        OIDCMockURLProtocol.handler = { request in
            let data = try JSONSerialization.data(withJSONObject: ["error": "nope"])
            return (errorResponse(for: request.url!, status: 500), data)
        }

        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.signIn(provider: "google", relayTo: "nativebindings://auth", launcher: EchoStateRelayLauncher(relay: "nativebindings://auth?code=c"))
            XCTFail("Expected OIDCError.callbackError")
        } catch let error as OIDCError {
            guard case .callbackError(let detail, let cause) = error else {
                return XCTFail("Expected callbackError, got \(error)")
            }
            XCTAssertTrue(detail.contains("Failed to fetch authorize params"), detail)
            XCTAssertEqual((cause as? ApiError)?.status, 500)
            XCTAssertTrue(error.underlyingError is ApiError)
        } catch {
            XCTFail("Expected OIDCError, got \(error)")
        }
    }

    func testDescriptorMissingARequiredFieldThrowsTransferableError() {
        let descriptor: [String: Any] = ["exchangePath": "/auth/exchange"]
        XCTAssertThrowsError(try OIDCClient<String>.fromJSON(descriptor, baseUrl: "x", client: BlocksClient(url: "x"))) { error in
            XCTAssertTrue(error is TransferableError, "\(error)")
        }
    }

    // MARK: - OIDCUser / OIDCProviderConfig

    func testOIDCUserFromJSONThrowsOnMissingFields() {
        XCTAssertThrowsError(try OIDCUser.fromJSON([:])) { error in
            guard case .invalidDescriptor(let blocksType, let missingField)? = error as? TransferableError else {
                return XCTFail("Expected TransferableError.invalidDescriptor, got \(error)")
            }
            XCTAssertEqual(blocksType, "oidc")
            XCTAssertEqual(missingField, "userId")
        }
    }

    func testOIDCUserFromJSONReadsTheOptionalFields() throws {
        let user = try OIDCUser.fromJSON([
            "userId": "https://idp.example.com:sub-1",
            "username": "alice",
            "userSub": "https://idp.example.com:sub-1",
            "signInProvider": "google",
            "groups": ["admins"],
            "attributes": ["email": "alice@example.com", "custom:team": "platform"],
            "displayName": "alice@example.com"
        ])
        XCTAssertEqual(user.userSub, "https://idp.example.com:sub-1")
        XCTAssertEqual(user.signInProvider, "google")
        XCTAssertEqual(user.groups, ["admins"])
        XCTAssertEqual(user.attributes, ["email": "alice@example.com", "custom:team": "platform"])
        XCTAssertEqual(user.displayName, "alice@example.com")

        let minimal = try OIDCUser.fromJSON(["userId": "u1", "username": "bob"])
        XCTAssertNil(minimal.userSub)
        XCTAssertNil(minimal.signInProvider)
        XCTAssertNil(minimal.attributes)
        XCTAssertNil(minimal.displayName)
        XCTAssertEqual(minimal.groups, [])
    }

    func testOIDCProviderConfigFromJSONThrowsOnMissingFields() {
        XCTAssertThrowsError(try OIDCProviderConfig.fromJSON(["authorizeUrl": "x", "clientId": "y", "scopes": [String]()])) { error in
            guard case .invalidDescriptor(let blocksType, let missingField)? = error as? TransferableError else {
                return XCTFail("Expected TransferableError.invalidDescriptor, got \(error)")
            }
            XCTAssertEqual(blocksType, "oidc")
            XCTAssertEqual(missingField, "kind")
        }
    }
}

/// Relays back to `relay` with the `state` the authorize URL carried, as the server's callback does.
final class EchoStateRelayLauncher: BrowserLauncher, @unchecked Sendable {
    private let relay: String
    private(set) var authorizeURL: URL?

    init(relay: String) {
        self.relay = relay
    }

    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        self.authorizeURL = authorizeURL
        let state = URLComponents(url: authorizeURL, resolvingAgainstBaseURL: false)?
            .queryItems?.first { $0.name == "state" }?.value ?? ""
        var components = try XCTUnwrap(URLComponents(string: relay))
        components.queryItems = (components.queryItems ?? []) + [URLQueryItem(name: "state", value: state)]
        return try XCTUnwrap(components.url)
    }
}

/// Relays back to `relay` unchanged, without the sign-in's state.
private struct FixedRelayLauncher: BrowserLauncher {
    let relay: String

    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        try XCTUnwrap(URL(string: relay))
    }
}
