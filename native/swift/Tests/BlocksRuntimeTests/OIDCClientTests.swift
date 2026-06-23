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

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

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
        let accessToken = await store.get("access_token")
        let refreshToken = await store.get("refresh_token")
        let expiresAt = await store.get("expires_at")
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
        await store.set("refresh_token", value: "refresh-existing")

        try await client.refresh()

        let accessToken = await store.get("access_token")
        let refreshToken = await store.get("refresh_token")
        XCTAssertEqual(accessToken, "access-2")
        XCTAssertEqual(refreshToken, "refresh-existing")
    }

    func testRefreshFailureClearsTokensAndEmitsSignedOut() async throws {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 401), Data("{}".utf8))
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set("access_token", value: "expired")
        await store.set("refresh_token", value: "rt")
        await store.set("expires_at", value: "0")

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

        let accessToken = await store.get("access_token")
        let refreshToken = await store.get("refresh_token")
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
        await store.set("access_token", value: "at")
        await store.set("refresh_token", value: "rt")

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

        let accessToken = await store.get("access_token")
        let refreshToken = await store.get("refresh_token")
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
        await store.set("access_token", value: "at-1")
        await store.set("expires_at", value: "9999999999000")
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

        let s1 = await client.authStateChanges()
        let s2 = await client.authStateChanges()

        let c1 = Task<OIDCAuthState?, Never> {
            for await e in s1 {
                return e
            }
            return nil
        }
        let c2 = Task<OIDCAuthState?, Never> {
            for await e in s2 {
                return e
            }
            return nil
        }

        _ = try await client.exchange(
            code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n"
        )

        let e1 = await c1.value
        let e2 = await c2.value
        XCTAssertNotNil(e1)
        XCTAssertEqual(e1, e2)
        if case .signedIn = e1 {} else { XCTFail("Expected signedIn") }
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
