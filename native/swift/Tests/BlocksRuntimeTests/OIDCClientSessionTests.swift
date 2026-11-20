//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// `OIDCClient`'s session: `signOut()` and `restore()`. The mock, the clients and the stubs they use
/// are in `OIDCClientTests.swift`.
extension OIDCClientTests {
    // MARK: - Sign out

    func testSignOutClearsTokensAndEmitsSignedOut() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/signout")
            XCTAssertEqual(request.url?.query, "format=json")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")
            XCTAssertEqual(requestJSON(request).count, 0, "the body is {}, even with a refresh token stored")
            return (okResponse(for: request.url!), Data("{}".utf8))
        }

        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "at")
        await store.set(tokenKey("refresh_token"), value: "rt")

        let stream = await client.authStateChanges().dropFirst()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
                if events.count == 1 { break }
            }
            return events
        }

        let logoutURL = try await client.signOut()

        XCTAssertNil(logoutURL)
        let accessToken = await store.get(tokenKey("access_token"))
        let refreshToken = await store.get(tokenKey("refresh_token"))
        let events = await collector.value
        XCTAssertNil(accessToken)
        XCTAssertNil(refreshToken)
        XCTAssertEqual(events, [.signedOut])
    }

    func testSignOutReturnsTheLogoutURL() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(requestJSON(request).count, 0, "the body is {}")
            let body = ["logoutUrl": "https://idp.example.com/logout?client_id=cid"]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())

        let logoutURL = try await client.signOut()

        XCTAssertEqual(logoutURL?.absoluteString, "https://idp.example.com/logout?client_id=cid")
    }

    func testSignOutAcceptsAnEmpty204() async throws {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 204), Data())
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")
        let state = await firstState(of: client)

        let logoutURL = try await client.signOut()

        XCTAssertNil(logoutURL)
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertNil(refresh)
        let event = await state.value
        XCTAssertEqual(event, .signedOut)
    }

    func testSignOutIncompleteSignsOutLocallyAndThrows() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body = ["error": "The session could not be removed.", "name": "SignOutIncompleteException"]
            return (errorResponse(for: request.url!, status: 503), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")
        let state = await firstState(of: client)

        do {
            _ = try await client.signOut()
            XCTFail("Expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.status, 503)
            XCTAssertEqual(error.name, "SignOutIncompleteException")
        }
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertNil(refresh)
        let event = await state.value
        XCTAssertEqual(event, .signedOut)
    }

    /// The `SignOutIncompleteException` name only counts on a 503: on another status it is a failed
    /// sign-out, which also signs out locally and throws.
    func testSignOutIncompleteNameOnAnotherStatusIsAFailure() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body = ["error": "Something else broke.", "name": "SignOutIncompleteException"]
            return (errorResponse(for: request.url!, status: 500), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")

        let events = await states(of: client) {
            do {
                _ = try await client.signOut()
                XCTFail("Expected ApiError")
            } catch let error as ApiError {
                XCTAssertEqual(error.status, 500)
                XCTAssertEqual(error.name, "SignOutIncompleteException")
            } catch {
                XCTFail("Expected ApiError, got \(error)")
            }
        }

        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertNil(refresh)
        XCTAssertEqual(events, [.signedOut])
    }

    /// A failed sign-out signs out locally: the tokens go, `.signedOut` is emitted, then the error is thrown.
    func testSignOutFailureSignsOutLocallyAndThrows() async throws {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 500), Data("{}".utf8))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "at")
        await store.set(tokenKey("refresh_token"), value: "rt")

        let events = await states(of: client) {
            do {
                _ = try await client.signOut()
                XCTFail("Expected ApiError")
            } catch let error as ApiError {
                XCTAssertEqual(error.status, 500)
            } catch {
                XCTFail("Expected ApiError, got \(error)")
            }
        }

        let access = await store.get(tokenKey("access_token"))
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertNil(access)
        XCTAssertNil(refresh)
        XCTAssertEqual(events, [.signedOut])
    }

    func testASignOutTransportErrorRemovesOnlyThisBlocksSessionCookie() async throws {
        try await assertAFailedSignOutSignsOutLocally { _ in throw URLError(.cannotConnectToHost) }
    }

    func testASignOut500RemovesOnlyThisBlocksSessionCookie() async throws {
        try await assertAFailedSignOutSignsOutLocally { request in
            let body = try JSONSerialization.data(withJSONObject: ["error": "Internal error", "name": "InternalError"])
            return (errorResponse(for: request.url!, status: 500), body)
        }
    }

    func testACancelledSignOutRemovesOnlyThisBlocksSessionCookie() async throws {
        try await assertAFailedSignOutSignsOutLocally(cancelled: true) { request in
            (okResponse(for: request.url!), Data("{}".utf8))
        }
    }

    /// After a relaunch the token store no longer holds the cookie names the sign-in recorded, so a failed
    /// sign-out finds this block's session cookie by the descriptor's `sessionCookieName`.
    func testAFailedSignOutAfterARelaunchRemovesTheDescriptorsSessionCookie() async throws {
        BlocksClient.clearCookies()
        defer { BlocksClient.clearCookies() }
        stubSessionCookieRoutes(mainCookies: "auth_main=a1; Path=/; Secure; HttpOnly")
        let launched = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let sso = "/cdk-blocks/auth/sso"
        _ = try await Self.authClient(on: launched, sessionCookieName: "auth_main")
            .exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "")
        _ = try await Self.authClient(on: launched, base: sso, providers: ["corp"], sessionCookieName: "auth_sso")
            .exchange(code: "c", verifier: "v", callbackURL: "x", provider: "corp", state: "s", nonce: "")

        // A fresh in-memory token store: the recorded names are gone, the cookies are still in the jar.
        let relaunched = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let main = try Self.authClient(on: relaunched, sessionCookieName: "auth_main")
        let other = try Self.authClient(on: relaunched, base: sso, providers: ["corp"], sessionCookieName: "auth_sso")
        do {
            _ = try await main.signOut()
            XCTFail("Expected the sign-out to fail")
        } catch {}

        let cookies = try await cookieHeaderOfARestore(by: other)
        XCTAssertTrue(cookies.contains("auth_sso=b1"), cookies)
        XCTAssertFalse(cookies.contains("auth_main"), cookies)
    }

    /// With a `sessionCookieName`, a failed sign-out removes exactly that cookie, not every cookie the
    /// sign-in response set.
    func testAFailedSignOutRemovesOnlyTheDescriptorsSessionCookie() async throws {
        BlocksClient.clearCookies()
        defer { BlocksClient.clearCookies() }
        stubSessionCookieRoutes(mainCookies: "auth_main=a1; Path=/; Secure; HttpOnly, prefs=p1; Path=/")
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let main = try Self.authClient(on: blocksClient, sessionCookieName: "auth_main")
        let other = try Self.authClient(on: blocksClient, base: "/cdk-blocks/auth/sso", providers: ["corp"])
        _ = try await main.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "")
        _ = try await other.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "corp", state: "s", nonce: "")

        do {
            _ = try await main.signOut()
            XCTFail("Expected the sign-out to fail")
        } catch {}

        let cookies = try await cookieHeaderOfARestore(by: other)
        XCTAssertTrue(cookies.contains("prefs=p1"), cookies)
        XCTAssertTrue(cookies.contains("auth_sso=b1"), cookies)
        XCTAssertFalse(cookies.contains("auth_main"), cookies)
    }

    /// Answers the two blocks' exchanges with their session cookies (`mainCookies` for the first block,
    /// `auth_sso` for the second), fails the sign-out with no response, and answers a session read.
    private func stubSessionCookieRoutes(mainCookies: String) {
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            if url.path == "/cdk-blocks/auth/signout" {
                throw URLError(.cannotConnectToHost)
            }
            let (cookie, body): (String?, [String: Any]) = if url.path == "/cdk-blocks/auth/exchange" {
                (mainCookies, ["user": ["userId": "a", "username": "a"]])
            } else if url.path == "/cdk-blocks/auth/sso/exchange" {
                ("auth_sso=b1; Path=/; Secure; HttpOnly", ["user": ["userId": "b", "username": "b"]])
            } else {
                (nil, ["user": ["userId": "b", "username": "b"]])
            }
            let headers = cookie.map { ["Set-Cookie": $0] } ?? [:]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!
            return (response, try JSONSerialization.data(withJSONObject: body))
        }
    }

    /// The `Cookie` header of a `restore()` by `client`.
    private func cookieHeaderOfARestore(by client: OIDCClient<String>) async throws -> String {
        _ = try await client.restore()
        let request = try XCTUnwrap(OIDCMockURLProtocol.requests.last)
        XCTAssertEqual(request.url?.path, "/cdk-blocks/auth/sso/session")
        return request.value(forHTTPHeaderField: "Cookie") ?? ""
    }

    /// Signs two `Auth` blocks in, with bb-auth's `Path=/` session cookies, fails the first block's
    /// sign-out with `signOutResponse` (or by cancelling it), and checks that the first block signed out
    /// locally and threw, and that the second block's session cookie is still sent.
    private func assertAFailedSignOutSignsOutLocally(
        cancelled: Bool = false,
        signOutResponse: @escaping (URLRequest) throws -> (HTTPURLResponse, Data),
        file: StaticString = #filePath,
        line: UInt = #line
    ) async throws {
        BlocksClient.clearCookies()
        defer { BlocksClient.clearCookies() }
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            if url.path == "/cdk-blocks/auth/signout" {
                return try signOutResponse(request)
            }
            let (cookie, body): (String?, [String: Any]) = if url.path == "/cdk-blocks/auth/exchange" {
                ("auth_main=a1; Path=/; Secure; HttpOnly", ["user": ["userId": "a", "username": "a"]])
            } else if url.path == "/cdk-blocks/auth/sso/exchange" {
                ("auth_sso=b1; Path=/; Secure; HttpOnly", ["user": ["userId": "b", "username": "b"]])
            } else {
                (nil, ["user": ["userId": "b", "username": "b"]])
            }
            let headers = cookie.map { ["Set-Cookie": $0] } ?? [:]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!
            return (response, try JSONSerialization.data(withJSONObject: body))
        }
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let main = try Self.authClient(on: blocksClient)
        let sso = try Self.authClient(on: blocksClient, base: "/cdk-blocks/auth/sso", providers: ["corp"])
        _ = try await main.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "")
        _ = try await sso.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "corp", state: "s", nonce: "")
        let store = blocksClient.tokenStore
        let refreshKey = tokenKey("refresh_token", exchangePath: "/cdk-blocks/auth/exchange")
        await store.set(refreshKey, value: "rt")

        let events = try await states(of: main) {
            let signOut = Task {
                if cancelled {
                    withUnsafeCurrentTask { $0?.cancel() }
                }
                return try await main.signOut()
            }
            let result = await signOut.result
            XCTAssertThrowsError(try result.get(), "a failed sign-out throws", file: file, line: line)
        }

        let refresh = await store.get(refreshKey)
        XCTAssertNil(refresh, "this block's tokens are cleared", file: file, line: line)
        XCTAssertEqual(events, [.signedOut], file: file, line: line)
        _ = try await sso.restore()
        let session = try XCTUnwrap(OIDCMockURLProtocol.requests.last, file: file, line: line)
        XCTAssertEqual(session.url?.path, "/cdk-blocks/auth/sso/session", file: file, line: line)
        let cookies = session.value(forHTTPHeaderField: "Cookie") ?? ""
        XCTAssertTrue(cookies.contains("auth_sso=b1"), cookies, file: file, line: line)
        XCTAssertFalse(cookies.contains("auth_main"), cookies, file: file, line: line)
    }

    /// Two `Auth` blocks on one app keep their cookies in the one jar. Signing out of one clears only
    /// what its server expires: the other block's session cookie is still sent.
    func testSignOutOfOneBlockKeepsTheOtherBlocksSessionCookie() async throws {
        BlocksClient.clearCookies()
        defer { BlocksClient.clearCookies() }
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            let path = url.path
            let (cookie, body): (String?, [String: Any]) = if path == "/cdk-blocks/auth/exchange" {
                ("authsession_a=a1; Path=/cdk-blocks/auth; Secure; HttpOnly", ["user": ["userId": "a", "username": "a"]])
            } else if path == "/cdk-blocks/auth/sso/exchange" {
                ("authsession_b=b1; Path=/cdk-blocks/auth/sso; Secure; HttpOnly", ["user": ["userId": "b", "username": "b"]])
            } else if path == "/cdk-blocks/auth/signout" {
                ("authsession_a=; Max-Age=0; Path=/cdk-blocks/auth; Secure; HttpOnly", [:])
            } else {
                (nil, ["user": ["userId": "b", "username": "b"]])
            }
            let headers = cookie.map { ["Set-Cookie": $0] } ?? [:]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!
            return (response, try JSONSerialization.data(withJSONObject: body))
        }
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession())
        let main = try Self.authClient(on: blocksClient)
        let sso = try Self.authClient(on: blocksClient, base: "/cdk-blocks/auth/sso", providers: ["corp"])
        _ = try await main.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "")
        _ = try await sso.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "corp", state: "s", nonce: "")

        _ = try await main.signOut()
        _ = try await sso.restore()

        let session = try XCTUnwrap(OIDCMockURLProtocol.requests.last)
        XCTAssertEqual(session.url?.path, "/cdk-blocks/auth/sso/session")
        let cookies = session.value(forHTTPHeaderField: "Cookie") ?? ""
        XCTAssertTrue(cookies.contains("authsession_b=b1"), cookies)
        XCTAssertFalse(cookies.contains("authsession_a"), cookies)
    }

    /// Subscribes to `client` and returns every state it emits in the next 50 ms after `body` runs.
    func states(of client: OIDCClient<String>, during body: () async throws -> Void) async rethrows -> [OIDCAuthState] {
        let stream = await client.authStateChanges().dropFirst()
        let collector = Task<[OIDCAuthState], Never> {
            var events: [OIDCAuthState] = []
            for await event in stream {
                events.append(event)
            }
            return events
        }
        try await body()
        try? await Task.sleep(for: .milliseconds(50))
        collector.cancel()
        return await collector.value
    }

    func testSignOutOnAClosedClientKeepsTheTokens() async throws {
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")
        client.client.close()

        let events = await states(of: client) {
            do {
                _ = try await client.signOut()
                XCTFail("Expected ClientClosedError")
            } catch {
                XCTAssertTrue(error is ClientClosedError, "got \(error)")
            }
        }

        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(refresh, "rt", "the request was never sent")
        XCTAssertEqual(events, [])
    }

    // MARK: - Restore

    /// The first state `client` emits after `subscribe` returns, collected in the background.
    private func firstState(of client: OIDCClient<String>) async -> Task<OIDCAuthState?, Never> {
        let stream = await client.authStateChanges().dropFirst()
        return Task {
            for await event in stream {
                return event
            }
            return nil
        }
    }

    func testRestoreReadsTheServersSession() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(request.httpMethod, "GET")
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"), "no token is stored")
            let body: [String: Any] = ["user": ["userId": "https://idp.example.com:sub-1", "username": "alice"]]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let blocksClient = BlocksClient(url: "https://api.example.com/prod/cdk-blocks/api", session: makeMockSession())
        let client = try Self.authClient(on: blocksClient)
        let state = await firstState(of: client)

        let user = try await client.restore()

        XCTAssertEqual(user?.userId, "https://idp.example.com:sub-1")
        XCTAssertEqual(
            OIDCMockURLProtocol.requests.compactMap { $0.url?.absoluteString },
            ["https://api.example.com/prod/cdk-blocks/auth/session"]
        )
        let event = await state.value
        XCTAssertEqual(event, user.map(OIDCAuthState.signedIn))
    }

    /// A client hydrated from a descriptor restores at the descriptor's session route, or at the one
    /// beside its callback when the descriptor names none.
    func testHydratedClientRestoresAtItsSessionRoute() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["user": ["userId": "u1", "username": "alice"]]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let blocksClient = BlocksClient(url: "http://localhost:3001/cdk-blocks/api", session: makeMockSession())
        var named = Self.authDescriptor(base: "/cdk-blocks/auth/sso", callback: "/cdk-blocks/auth/sso/return")
        named["sessionPath"] = "/cdk-blocks/auth/sso/current"
        let withPath = try OIDCClient<String>.fromJSON(named, baseUrl: blocksClient.baseUrl, client: blocksClient)
        let derived = try Self.authClient(on: blocksClient, base: "/cdk-blocks/auth/sso", callback: "/cdk-blocks/auth/sso/return")

        let first = try await withPath.restore()
        let second = try await derived.restore()

        XCTAssertEqual(first?.userId, "u1")
        XCTAssertEqual(second?.userId, "u1")
        XCTAssertEqual(
            OIDCMockURLProtocol.requests.compactMap { $0.url?.absoluteString },
            ["http://localhost:3001/cdk-blocks/auth/sso/current", "http://localhost:3001/cdk-blocks/auth/sso/session"]
        )
    }

    /// A client on the default routes over a `HoldingTokenStore`, warmed so the 0.x token move has run.
    func holdingClient() async throws -> (OIDCClient<String>, HoldingTokenStore) {
        let store = HoldingTokenStore()
        let blocksClient = BlocksClient(
            url: "https://api.example.com/cdk-blocks/api",
            session: makeMockSession(),
            ownsSession: true,
            tokenStore: store
        )
        let client = try Self.authClient(on: blocksClient)
        _ = await client.getAccessToken()
        return (client, store)
    }

    /// A sign-in that finishes while `restore()` waits wins: the restore's 401 neither signs the user
    /// out nor clears the new tokens.
    func testARestoreThatFinishesAfterASignInLeavesTheSignIn() async throws {
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            if url.path.hasSuffix("/session") {
                return (errorResponse(for: url, status: 401), Data("{}".utf8))
            }
            let body: [String: Any] = [
                "user": ["userId": "u1", "username": "alice"],
                "accessToken": "at-new", "refreshToken": "rt-new", "expiresIn": 3_600
            ]
            return (okResponse(for: url), try JSONSerialization.data(withJSONObject: body))
        }
        let (client, store) = try await holdingClient()
        await store.arm(tokenKey("access_token", exchangePath: "/cdk-blocks/auth/exchange"))

        let restoring = Task { try await client.restore() }
        await store.waitUntilHeld()
        let user = try await client.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n")
        await store.release()
        let restored = try await restoring.value

        XCTAssertEqual(restored, user)
        let state = await client.authState
        XCTAssertEqual(state, .signedIn(user))
        let access = await store.get(tokenKey("access_token", exchangePath: "/cdk-blocks/auth/exchange"))
        XCTAssertEqual(access, "at-new")
    }

    /// A sign-out that finishes while `restore()` waits wins: the restore's stale user isn't applied.
    func testARestoreThatFinishesAfterASignOutLeavesTheSignOut() async throws {
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            let body: [String: Any] = url.path.hasSuffix("/signout") ? [:] : ["user": ["userId": "u1", "username": "alice"]]
            return (okResponse(for: url), try JSONSerialization.data(withJSONObject: body))
        }
        let (client, store) = try await holdingClient()
        _ = try await client.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "n")
        await store.arm(tokenKey("access_token", exchangePath: "/cdk-blocks/auth/exchange"))

        let restoring = Task { try await client.restore() }
        await store.waitUntilHeld()
        _ = try await client.signOut()
        await store.release()
        let restored = try await restoring.value

        XCTAssertNil(restored)
        let state = await client.authState
        XCTAssertEqual(state, .signedOut)
    }

    func testRestoreSendsAStoredAccessToken() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertEqual(request.url?.path, "/auth/session")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Authorization"), "Bearer at-1")
            let body: [String: Any] = ["user": ["userId": "u1", "username": "alice"]]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        await client.client.tokenStore.set(tokenKey("access_token"), value: "at-1")
        await client.client.tokenStore.set(tokenKey("expires_at"), value: "9999999999000")

        let user = try await client.restore()

        XCTAssertEqual(user?.userId, "u1")
        XCTAssertEqual(OIDCMockURLProtocol.requests.count, 1)
    }

    func testRestoreLeavesAnExpiredAccessTokenOut() async throws {
        OIDCMockURLProtocol.handler = { request in
            XCTAssertNil(request.value(forHTTPHeaderField: "Authorization"))
            let body: [String: Any] = ["user": ["userId": "u1", "username": "alice"]]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "expired")
        await store.set(tokenKey("refresh_token"), value: "rt")
        await store.set(tokenKey("expires_at"), value: "0")

        let user = try await client.restore()

        XCTAssertEqual(user?.userId, "u1")
        XCTAssertEqual(OIDCMockURLProtocol.requests.count, 1, "restore doesn't refresh")
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(refresh, "rt")
    }

    func testRestoreOn401ClearsTokensAndEmitsSignedOut() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["error": "Not signed in", "name": "NotAuthenticatedException"]
            return (errorResponse(for: request.url!, status: 401), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "at")
        await store.set(tokenKey("refresh_token"), value: "rt")
        let state = await firstState(of: client)

        let user = try await client.restore()

        XCTAssertNil(user)
        let access = await store.get(tokenKey("access_token"))
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertNil(access)
        XCTAssertNil(refresh)
        let event = await state.value
        XCTAssertEqual(event, .signedOut)
    }

    func testRestoreOn404NamesTheMissingSessionRoute() async {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 404), Data("{}".utf8))
        }
        let client = makeClient(session: makeMockSession())

        do {
            _ = try await client.restore()
            XCTFail("Expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.status, 404)
            XCTAssertTrue(error.message.contains("no session route"), error.message)
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testRestoreOnAServerErrorThrowsAndKeepsTheTokens() async {
        OIDCMockURLProtocol.handler = { request in
            (errorResponse(for: request.url!, status: 500), Data("{}".utf8))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")

        do {
            _ = try await client.restore()
            XCTFail("Expected ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.status, 500)
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(refresh, "rt")
    }

    func testRestoreOnATransportErrorThrowsAndChangesNothing() async throws {
        // No handler: the mock fails the request with `URLError(.cannotConnectToHost)`.
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")

        let events = await states(of: client) {
            do {
                _ = try await client.restore()
                XCTFail("Expected a TransportError")
            } catch let error as TransportError {
                XCTAssertNil(error.statusCode)
                XCTAssertEqual((error.underlyingError as? URLError)?.code, .cannotConnectToHost, "got \(error)")
            } catch {
                XCTFail("Expected TransportError, got \(error)")
            }
        }

        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(refresh, "rt")
        XCTAssertEqual(events, [])
    }

    /// A 2xx session response without a usable user, missing or one `OIDCUser` rejects, is no usable
    /// result: a `TransportError` with status 200, as for a refresh without an access token.
    func testRestoreWithoutAUsableUserThrowsATransportError() async throws {
        for body in [#"{}"#, #"{"user":{"username":"alice"}}"#] {
            OIDCMockURLProtocol.reset()
            OIDCMockURLProtocol.handler = { request in
                (okResponse(for: request.url!), Data(body.utf8))
            }
            let client = makeClient(session: makeMockSession())

            let events = await states(of: client) {
                do {
                    _ = try await client.restore()
                    XCTFail("Expected TransportError for \(body)")
                } catch let error as TransportError {
                    XCTAssertEqual(error.statusCode, 200, body)
                    XCTAssertTrue(error.message.contains("/auth/session"), error.message)
                } catch {
                    XCTFail("Expected TransportError for \(body), got \(error)")
                }
            }

            XCTAssertEqual(events, [], body)
        }
    }

    // MARK: - Cancellation

    func testACancelledRestoreThrowsCancellationErrorAndChangesNothing() async throws {
        let client = makeClient(session: Self.hangingSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")

        let events = await states(of: client) {
            let error = await Self.errorOfACancelledCall { _ = try await client.restore() }
            XCTAssertTrue(error is CancellationError, "got \(String(describing: error))")
        }

        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(refresh, "rt")
        XCTAssertEqual(events, [])
        let state = await client.authState
        XCTAssertEqual(state, .loading)
    }

    func testACancelledRefreshThrowsCancellationErrorAndKeepsTheTokens() async throws {
        let client = makeClient(session: Self.hangingSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("access_token"), value: "expired")
        await store.set(tokenKey("refresh_token"), value: "rt")
        await store.set(tokenKey("expires_at"), value: "0")

        let events = await states(of: client) {
            let error = await Self.errorOfACancelledCall { try await client.refresh() }
            XCTAssertTrue(error is CancellationError, "got \(String(describing: error))")
        }

        let access = await store.get(tokenKey("access_token"))
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(access, "expired")
        XCTAssertEqual(refresh, "rt")
        XCTAssertEqual(events, [])
    }

    /// Cancelling one caller of a shared refresh leaves the refresh running: the other caller gets its result,
    /// and the tokens it stores are kept.
    func testACancelledRefreshCallerLeavesTheSharedRefreshToTheOtherCaller() async throws {
        let started = DispatchSemaphore(value: 0)
        let answer = DispatchSemaphore(value: 0)
        OIDCMockURLProtocol.handler = { request in
            started.signal()
            _ = answer.wait(timeout: .now() + 5)
            let body = ["accessToken": "at2", "refreshToken": "rt2", "expiresIn": 3_600] as [String: Any]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")

        let cancelled = Task { try await client.refresh() }
        await Task.detached { started.wait() }.value
        let shared = Task { try await client.refresh() }
        // Let the second caller join the in-flight refresh before the first one is cancelled.
        try await Task.sleep(for: .milliseconds(50))
        cancelled.cancel()
        let cancelledResult = await cancelled.result
        XCTAssertThrowsError(try cancelledResult.get()) { XCTAssertTrue($0 is CancellationError, "got \($0)") }

        answer.signal()
        try await shared.value

        let access = await store.get(tokenKey("access_token"))
        let refresh = await store.get(tokenKey("refresh_token"))
        XCTAssertEqual(access, "at2")
        XCTAssertEqual(refresh, "rt2")
        XCTAssertEqual(OIDCMockURLProtocol.requests.count, 1, "one shared refresh request")
    }

    /// A session whose requests never answer, and time out after a second so the abandoned request ends.
    static func hangingSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HangingURLProtocol.self]
        config.timeoutIntervalForRequest = 1
        return URLSession(configuration: config)
    }

    /// Runs `call` in a task, cancels it once its request is in flight, and returns what it threw.
    static func errorOfACancelledCall(_ call: @escaping @Sendable () async throws -> Void) async -> Error? {
        let started = DispatchSemaphore(value: 0)
        HangingURLProtocol.onStart = { started.signal() }
        defer { HangingURLProtocol.onStart = nil }
        let task = Task { try await call() }
        await Task.detached { _ = started.wait(timeout: .now() + 5) }.value
        task.cancel()
        do {
            try await task.value
            return nil
        } catch {
            return error
        }
    }

    // MARK: - Session writes that overlap

    /// A restore whose 401 is clearing the tokens while a sign-in finishes leaves the sign-in: the
    /// sign-in's cookie names stay, and the client ends signed in.
    func testARestoreClearingAfterA401LeavesASignInThatFinishesMeanwhile() async throws {
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            if url.path == "/cdk-blocks/auth/session" {
                return (errorResponse(for: url, status: 401), Data("{}".utf8))
            }
            // A cookie-only answer, as with `tokens: false`.
            let headers = ["Set-Cookie": "auth_main=a1; Path=/; Secure; HttpOnly"]
            let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: headers)!
            return (response, try JSONSerialization.data(withJSONObject: ["user": ["userId": "u1", "username": "dave"]]))
        }
        BlocksClient.clearCookies()
        defer { BlocksClient.clearCookies() }
        let store = HoldingWriteTokenStore()
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession(), tokenStore: store)
        let client = try Self.authClient(on: blocksClient)
        let key = tokenKey("access_token", exchangePath: "/cdk-blocks/auth/exchange")
        await store.arm(.delete, key)

        let restore = Task { try await client.restore() }
        await store.waitUntilHeld()
        let signIn = Task {
            try await client.exchange(code: "c", verifier: "v", callbackURL: "x", provider: "google", state: "s", nonce: "")
        }
        try await Task.sleep(for: .milliseconds(50))
        await store.release()
        _ = try await restore.value
        let user = try await signIn.value

        let state = await client.authState
        XCTAssertEqual(state, .signedIn(user))
        let cookieNames = await store.get(tokenKey("session_cookies", exchangePath: "/cdk-blocks/auth/exchange"))
        XCTAssertEqual(cookieNames, "auth_main")
    }

    /// A sign-out that lands while a refresh is storing its tokens leaves none of them stored.
    func testASignOutWhileARefreshStoresItsTokensLeavesNone() async throws {
        OIDCMockURLProtocol.handler = { request in
            let url = try XCTUnwrap(request.url)
            let body: [String: Any] = url.path.hasSuffix("/refresh")
                ? ["accessToken": "at-new", "refreshToken": "rt-new", "expiresIn": 3_600]
                : [:]
            return (okResponse(for: url), try JSONSerialization.data(withJSONObject: body))
        }
        let store = HoldingWriteTokenStore()
        let blocksClient = BlocksClient(url: "https://api.example.com/cdk-blocks/api", session: makeMockSession(), tokenStore: store)
        let client = try Self.authClient(on: blocksClient)
        let key = { (name: String) in tokenKey(name, exchangePath: "/cdk-blocks/auth/exchange") }
        await store.set(key("refresh_token"), value: "rt")
        await store.arm(.set, key("access_token"))

        let refresh = Task { try await client.refresh() }
        await store.waitUntilHeld()
        let signOut = Task { try await client.signOut() }
        try await Task.sleep(for: .milliseconds(50))
        await store.release()
        try await refresh.value
        _ = try await signOut.value

        let access = await store.get(key("access_token"))
        let refreshToken = await store.get(key("refresh_token"))
        XCTAssertNil(access)
        XCTAssertNil(refreshToken)
        let state = await client.authState
        XCTAssertEqual(state, .signedOut)
        let token = await client.getAccessToken()
        XCTAssertNil(token)
    }

    /// An `expiresIn` too large for epoch milliseconds is stored as expired instead of trapping.
    func testAnExpiresInTooLargeForMillisecondsReadsAsExpired() async throws {
        OIDCMockURLProtocol.handler = { request in
            let body: [String: Any] = ["accessToken": "at-new", "expiresIn": 1e300]
            return (okResponse(for: request.url!), try JSONSerialization.data(withJSONObject: body))
        }
        let client = makeClient(session: makeMockSession())
        let store = client.client.tokenStore
        await store.set(tokenKey("refresh_token"), value: "rt")

        try await client.refresh()

        let expiresAt = await store.get(tokenKey("expires_at"))
        XCTAssertEqual(expiresAt, "0")
    }
}

/// Holds the first `set` or `delete` of an armed key, before applying it, until `release()`, so a test can run
/// another call while that write is suspended.
private actor HoldingWriteTokenStore: TokenStore {
    enum Write { case set, delete }

    private var storage: [String: String] = [:]
    private var armed: (write: Write, key: String)?
    private var held: CheckedContinuation<Void, Never>?
    private var arrived = false
    private var arrivalWaiter: CheckedContinuation<Void, Never>?

    func arm(_ write: Write, _ key: String) {
        armed = (write, key)
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
        storage[key]
    }

    func set(_ key: String, value: String) async {
        await holdIfArmed(.set, key)
        storage[key] = value
    }

    func delete(_ key: String) async {
        await holdIfArmed(.delete, key)
        storage[key] = nil
    }

    private func holdIfArmed(_ write: Write, _ key: String) async {
        guard let armed, armed.write == write, armed.key == key else { return }
        self.armed = nil
        arrived = true
        arrivalWaiter?.resume()
        arrivalWaiter = nil
        await withCheckedContinuation { held = $0 }
    }
}
