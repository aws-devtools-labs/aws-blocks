//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// Answers every request with a JSON-RPC result and counts them.
private final class CountingURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var count = 0

    static var requests: Int {
        lock.withLock { count }
    }

    static func reset() {
        lock.withLock { count = 0 }
    }

    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        // Loaders run on URLSession threads.
        Self.lock.withLock { Self.count += 1 }
        respond(self)
    }

    override func stopLoading() {}
}

/// Holds each response until the test signals `release`.
private final class GatedURLProtocol: URLProtocol {
    nonisolated(unsafe) static var started: XCTestExpectation?
    nonisolated(unsafe) static var release = DispatchSemaphore(value: 0)

    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        Self.started?.fulfill()
        Self.release.wait()
        respond(self)
    }

    override func stopLoading() {}
}

private func respond(_ loader: URLProtocol) {
    guard let url = loader.request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
        return
    }
    loader.client?.urlProtocol(loader, didReceive: response, cacheStoragePolicy: .notAllowed)
    loader.client?.urlProtocol(loader, didLoad: Data(#"{"jsonrpc":"2.0","result":"ok","id":1}"#.utf8))
    loader.client?.urlProtocolDidFinishLoading(loader)
}

/// Fulfils `invalidated` when its session becomes invalid.
private final class InvalidationRecorder: NSObject, URLSessionDelegate {
    let invalidated: XCTestExpectation

    init(_ invalidated: XCTestExpectation) {
        self.invalidated = invalidated
    }

    func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        invalidated.fulfill()
    }
}

final class BlocksClientLifecycleTests: XCTestCase {
    private let url = "http://127.0.0.1:9/aws-blocks/api"

    override func setUp() {
        super.setUp()
        CountingURLProtocol.reset()
    }

    private func session(_ protocolClass: AnyClass, delegate: URLSessionDelegate? = nil) -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [protocolClass]
        return URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
    }

    /// A client that owns `session`, as one built without a session does.
    private func ownedClient(_ session: URLSession) -> BlocksClient {
        BlocksClient(url: url, session: session, ownsSession: true, tokenStore: InMemoryTokenStore())
    }

    private func ping(_ client: BlocksClient) async throws -> Data? {
        try await client.execute(BlocksRequest(method: "api.ping", params: [], id: BlocksRequest.nextId()))
    }

    func testRequestAfterCloseThrowsInsteadOfCrashing() async {
        // Without the gate this request would abort the process.
        let client = ownedClient(session(CountingURLProtocol.self))
        client.close()
        client.close()
        do {
            _ = try await ping(client)
            XCTFail("expected ClientClosedError")
        } catch {
            XCTAssertTrue(error is ClientClosedError, "got \(error)")
        }
        XCTAssertEqual(CountingURLProtocol.requests, 0)
        XCTAssertTrue(client.gate.isInvalidated)
    }

    func testInFlightRequestFinishesBeforeTheOwnedSessionIsInvalidated() async throws {
        let started = expectation(description: "started")
        let invalidated = expectation(description: "invalidated")
        GatedURLProtocol.started = started
        GatedURLProtocol.release = DispatchSemaphore(value: 0)
        let client = ownedClient(session(GatedURLProtocol.self, delegate: InvalidationRecorder(invalidated)))

        let request = Task { try await ping(client) }
        await fulfillment(of: [started], timeout: 5)
        client.close()
        XCTAssertFalse(client.gate.isInvalidated, "a request is still using the session")
        GatedURLProtocol.release.signal()

        let result = try await request.value
        XCTAssertEqual(result.flatMap { String(data: $0, encoding: .utf8) }, #""ok""#)
        XCTAssertTrue(client.gate.isInvalidated)
        await fulfillment(of: [invalidated], timeout: 5)
    }

    func testCloseAndReleaseLeaveAnInjectedSessionValid() async throws {
        let invalidated = expectation(description: "invalidated")
        invalidated.isInverted = true
        let shared = session(CountingURLProtocol.self, delegate: InvalidationRecorder(invalidated))
        weak var released: BlocksClient?
        do {
            let first = BlocksClient(url: url, session: shared)
            released = first
            first.close()
            XCTAssertFalse(first.gate.isInvalidated)
        }
        XCTAssertNil(released)
        // A request on an invalidated session would abort the process here.
        let result = try await ping(BlocksClient(url: url, session: shared))
        XCTAssertNotNil(result)
        await fulfillment(of: [invalidated], timeout: 0.3)
    }

    func testReleasingTheClientInvalidatesItsOwnedSession() async throws {
        let invalidated = expectation(description: "invalidated")
        var client: BlocksClient? = ownedClient(session(CountingURLProtocol.self, delegate: InvalidationRecorder(invalidated)))
        if let client {
            _ = try await ping(client)
        }
        client = nil
        await fulfillment(of: [invalidated], timeout: 5)
    }

    func testRequestsRacingCloseEitherFinishOrThrowClosed() async throws {
        for _ in 0 ..< 20 {
            let invalidated = expectation(description: "invalidated")
            let client = ownedClient(session(CountingURLProtocol.self, delegate: InvalidationRecorder(invalidated)))
            let outcomes = await withTaskGroup(of: String.self) { group in
                for index in 0 ..< 100 {
                    group.addTask {
                        if index == 50 {
                            client.close()
                        }
                        do {
                            _ = try await self.ping(client)
                            return "ok"
                        } catch is ClientClosedError {
                            return "closed"
                        } catch {
                            return "\(error)"
                        }
                    }
                }
                return await group.reduce(into: [String]()) { $0.append($1) }
            }
            XCTAssertEqual(outcomes.filter { $0 != "ok" && $0 != "closed" }, [])
            await fulfillment(of: [invalidated], timeout: 5)
        }
    }

    func testClosedClientKeepsStoredOIDCTokens() async {
        let store = InMemoryTokenStore()
        await store.set("/auth/exchange#access_token", value: "at")
        await store.set("/auth/exchange#refresh_token", value: "rt")
        await store.set("/auth/exchange#expires_at", value: "0")
        let client = BlocksClient(url: url, tokenStore: store)
        let oidc = OIDCClient(
            exchangePath: "/auth/exchange", refreshPath: "/auth/refresh", signOutPath: "/auth/signout",
            providers: ["google"], providerConfigs: [:], baseUrl: "http://127.0.0.1:9", client: client
        )
        client.close()

        do {
            try await oidc.refresh()
            XCTFail("expected ClientClosedError")
        } catch {
            XCTAssertTrue(error is ClientClosedError, "got \(error)")
        }
        let token = await oidc.getAccessToken()
        await oidc.onAuthFailure()
        await oidc.restore()
        let access = await store.get("/auth/exchange#access_token")
        let refresh = await store.get("/auth/exchange#refresh_token")
        XCTAssertNil(token)
        XCTAssertEqual(access, "at")
        XCTAssertEqual(refresh, "rt")
    }
}
