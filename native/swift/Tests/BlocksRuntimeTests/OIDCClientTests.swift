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

private func makeMockSession() -> URLSession {
    let config = URLSessionConfiguration.ephemeral
    config.protocolClasses = [OIDCMockURLProtocol.self] + (config.protocolClasses ?? [])
    return URLSession(configuration: config)
}

private func okResponse(for url: URL) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil)!
}

private func errorResponse(for url: URL, status: Int) -> HTTPURLResponse {
    HTTPURLResponse(url: url, statusCode: status, httpVersion: nil, headerFields: nil)!
}

/// The JSON body of a request; URLSession hands it to the protocol as a stream.
private func requestJSON(_ request: URLRequest) -> [String: Any] {
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
private func tokenKey(_ name: String, exchangePath: String = "/auth/exchange") -> String {
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

// MARK: - Tests

final class OIDCClientTests: XCTestCase {

    private func makeClient(session: URLSession) -> OIDCClient {
        let blocksClient = BlocksClient(url: "https://api.example.com/aws-blocks/api", session: session)
        return OIDCClient(
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

    private func makeClient(named namespace: String, on blocksClient: BlocksClient) -> OIDCClient {
        OIDCClient(
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
        let verifier = OIDCClient.generateVerifier()
        let challenge = OIDCClient.generateChallenge(verifier)
        XCTAssertFalse(verifier.isEmpty)
        XCTAssertFalse(challenge.isEmpty)
        // base64URL: no '+', '/', or '='
        XCTAssertFalse(verifier.contains("+"))
        XCTAssertFalse(verifier.contains("/"))
        XCTAssertFalse(verifier.contains("="))
        XCTAssertFalse(challenge.contains("="))
        // Same verifier → same challenge (S256 deterministic)
        XCTAssertEqual(challenge, OIDCClient.generateChallenge(verifier))
    }

    func testRandomValuesAreFullLengthNonZeroAndDistinct() throws {
        let values = (0 ..< 8).map { _ in OIDCClient.generateVerifier() } + [OIDCClient.generateNonce()]
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
        let stream = await client.authStateChanges()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
                if events.count == 1 { break }
            }
            return events
        }

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
        XCTAssertEqual(expiresAt, "3600")

        let events = await collector.value
        XCTAssertEqual(events, [.signedIn(user)])
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
            XCTAssertEqual(error, .malformedExchangeResponse)
        } catch {
            XCTFail("Expected OIDCError, got \(error)")
        }
    }

    // MARK: - Refresh

    func testRefreshUpdatesAccessToken() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/refresh")
            let body: [String: Any] = [
                "accessToken": "access-2",
                "expiresAt": 9_999_999_999_000
            ]
            let data = try JSONSerialization.data(withJSONObject: body)
            return (okResponse(for: request.url!), data)
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "refresh-existing")

        try await client.refresh()

        let accessToken = await store.get(tokenKey("access_token"))
        let refreshToken = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(accessToken, "access-2")
        XCTAssertEqual(refreshToken, "refresh-existing")
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

        let stream = await client.authStateChanges()
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

    func testRefreshWithoutTokenEmitsSignedOut() async throws {
        let client = makeClient(session: makeMockSession())

        let stream = await client.authStateChanges()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
                if events.count == 1 { break }
            }
            return events
        }

        try await client.refresh()
        let events = await collector.value
        XCTAssertEqual(events, [.signedOut])
    }

    // MARK: - Sign out

    func testSignOutClearsTokensAndEmitsSignedOut() async {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/signout")
            return (okResponse(for: request.url!), Data("{}".utf8))
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "at")
        await store.set(tokenKey("refresh_token"), value: "rt")

        let stream = await client.authStateChanges()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
                if events.count == 1 { break }
            }
            return events
        }

        await client.signOut()

        let accessToken = await store.get(tokenKey("access_token"))
        let refreshToken = await store.get(tokenKey("refresh_token"))
        let events = await collector.value
        XCTAssertNil(accessToken)
        XCTAssertNil(refreshToken)
        XCTAssertEqual(events, [.signedOut])
    }

    // MARK: - Restore

    func testRestoreEmitsSignedOutWhenNoTokens() async {
        let client = makeClient(session: makeMockSession())

        let stream = await client.authStateChanges()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
                if events.count == 2 { break }
            }
            return events
        }

        await client.restore()
        let events = await collector.value
        XCTAssertEqual(events, [.loading, .signedOut])
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

        let stream1 = await client.authStateChanges()
        let stream2 = await client.authStateChanges()

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
        let shared = BlocksClient(url: "https://api.example.com/aws-blocks/api", session: makeMockSession())
        let auth = makeClient(named: "auth", on: shared)
        let admin = makeClient(named: "admin", on: shared)
        for client in [auth, admin] {
            _ = try await client.exchange(code: "c", verifier: "v", callbackURL: "x://cb", provider: "google", state: "s", nonce: "n")
        }

        try await auth.refresh()
        await admin.signOut()

        let authToken = await auth.getAccessToken()
        let adminToken = await admin.getAccessToken()
        XCTAssertEqual(authToken, "renewed-with-auth-refresh")
        XCTAssertNil(adminToken)
    }

    func testTokensUnderTheUnscopedKeysAreAdoptedOnce() async {
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set("access_token", value: "legacy-access")
        await store.set("refresh_token", value: "legacy-refresh")
        await store.set("expires_at", value: "9999999999000")
        let other = makeClient(named: "admin", on: client.client)

        let token = await client.getAccessToken()
        let otherToken = await other.getAccessToken()
        let scoped = await store.get(tokenKey("refresh_token"))
        let legacy = await store.get("refresh_token")
        XCTAssertEqual(token, "legacy-access")
        XCTAssertNil(otherToken, "only the first client to use the store adopts the old session")
        XCTAssertEqual(scoped, "legacy-refresh")
        XCTAssertNil(legacy)
    }

    func testClientsFirstUsingTheStoreTogetherAdoptTheUnscopedSessionOnce() async {
        let store = RendezvousTokenStore(
            ["access_token": "legacy-access", "refresh_token": "legacy-refresh", "expires_at": "9999999999000"],
            holding: "access_token"
        )
        let shared = BlocksClient(url: "https://api.example.com/aws-blocks/api", session: makeMockSession(), tokenStore: store)
        let auth = makeClient(named: "auth", on: shared)
        let admin = makeClient(named: "admin", on: shared)

        async let authToken = auth.getAccessToken()
        async let adminToken = admin.getAccessToken()
        let tokens = await [authToken, adminToken]

        let adopters = await Set(store.writtenKeys.map { $0.components(separatedBy: "#")[0] })
        XCTAssertEqual(adopters.count, 1, "only one client adopts the old session: \(adopters)")
        XCTAssertEqual(tokens.compactMap { $0 }, ["legacy-access"])
        XCTAssertTrue(OIDCMockURLProtocol.requests.isEmpty)
    }

    // Each getClient() hydrates a new OIDCClient, so one exchange path can have several.
    func testClientsOnOneExchangePathWaitForTheMoveOfTheUnscopedSession() async {
        let store = RendezvousTokenStore(
            ["access_token": "legacy-access", "refresh_token": "legacy-refresh", "expires_at": "9999999999000"],
            holding: "access_token"
        )
        let shared = BlocksClient(url: "https://api.example.com/aws-blocks/api", session: makeMockSession(), tokenStore: store)
        let first = makeClient(named: "auth", on: shared)
        let second = makeClient(named: "auth", on: shared)

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
        let blocksClient = BlocksClient(url: "https://api.example.com/aws-blocks/api")
        let client = try OIDCClient.fromJSON(descriptor, baseUrl: "https://api.example.com", client: blocksClient)
        XCTAssertEqual(client.providers, ["google"])
        XCTAssertEqual(client.exchangePath, "/auth/exchange")
        // Defaulted refreshPath
        XCTAssertEqual(client.refreshPath, "/auth/exchange/refresh")
        XCTAssertEqual(client.signOutPath, "/auth/signout")
    }

    func testFromJSONThrowsOnMissingExchangePath() {
        let descriptor: [String: Any] = ["signOutPath": "/auth/signout"]
        XCTAssertThrowsError(try OIDCClient.fromJSON(descriptor, baseUrl: "x", client: BlocksClient(url: "x"))) { error in
            guard let oidc = error as? OIDCError else { return XCTFail("Expected OIDCError") }
            XCTAssertEqual(oidc, .malformedDescriptor("exchangePath"))
        }
    }

    // MARK: - OIDCUser / OIDCProviderConfig

    func testOIDCUserFromJSONThrowsOnMissingFields() {
        XCTAssertThrowsError(try OIDCUser.fromJSON([:])) { error in
            guard let oidc = error as? OIDCError else { return XCTFail("Expected OIDCError") }
            XCTAssertEqual(oidc, .malformedDescriptor("userId"))
        }
    }

    func testOIDCProviderConfigFromJSONThrowsOnMissingFields() {
        XCTAssertThrowsError(try OIDCProviderConfig.fromJSON(["authorizeUrl": "x", "clientId": "y", "scopes": [String]()])) { error in
            guard let oidc = error as? OIDCError else { return XCTFail("Expected OIDCError") }
            XCTAssertEqual(oidc, .malformedDescriptor("kind"))
        }
    }
}
