//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import BlocksRuntime
import Foundation
import XCTest

/// Records each request's JSON-RPC method and URL, and answers it.
private final class RecordingURLProtocol: URLProtocol {
    private static let lock = NSLock()
    private nonisolated(unsafe) static var recorded: [(method: String, url: URL?)] = []

    static var methods: [String] {
        lock.withLock { recorded.map(\.method) }
    }

    static var urls: Set<URL?> {
        lock.withLock { Set(recorded.map(\.url)) }
    }

    static func reset() {
        lock.withLock { recorded = [] }
    }

    override static func canInit(with request: URLRequest) -> Bool { true }
    override static func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        let body = request.httpBodyStream.map(Self.read) ?? request.httpBody ?? Data()
        let method = ((try? JSONSerialization.jsonObject(with: body)) as? [String: Any])?["method"] as? String ?? "?"
        Self.lock.withLock { Self.recorded.append((method, request.url)) }
        let result = switch method {
        case "users.list": #"["ada"]"#
        case "auth.getClient": #"{"exchangePath":"/auth/exchange","signOutPath":"/auth/signout","providers":["google","github","my-sso"]}"#
        case "admin.getClient": #"{"exchangePath":"/admin/exchange","signOutPath":"/auth/signout"}"#
        default: #""pong""#
        }
        guard let url = request.url, let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: nil, headerFields: nil) else {
            return
        }
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(#"{"jsonrpc":"2.0","result":\#(result),"id":1}"#.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func read(_ stream: InputStream) -> Data {
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let count = stream.read(&buffer, maxLength: buffer.count)
            guard count > 0 else { break }
            data.append(buffer, count: count)
        }
        return data
    }
}

/// Drives the build plugin's output for `blocks.spec.json` through a recording session.
final class GeneratedEntryPointTests: XCTestCase {
    override func setUp() {
        super.setUp()
        RecordingURLProtocol.reset()
    }

    private func mockSession() -> URLSession {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [RecordingURLProtocol.self]
        return URLSession(configuration: config)
    }

    func testZeroArgumentInitFollowsTheFirstServer() {
        let blocks = Blocks()
        XCTAssertEqual(blocks.server, Servers.default)
        XCTAssertEqual(blocks.client.baseUrl, "https://example.invalid/prod/aws-blocks/api")
    }

    func testEveryNamespaceRunsOnTheOneClient() async throws {
        let blocks = Blocks(server: Servers.local, session: mockSession())
        let users = try await blocks.users.list()
        let pong = try await blocks.clientApi.ping()
        let defaultPong = try await blocks.default.ping()
        XCTAssertEqual(users, ["ada"])
        XCTAssertEqual([pong, defaultPong], ["pong", "pong"])
        XCTAssertEqual(RecordingURLProtocol.methods, ["users.list", "client.ping", "ping"])
        XCTAssertEqual(RecordingURLProtocol.urls, [URL(string: Servers.local.url)])
    }

    func testNamespacePropertiesAreStable() {
        let blocks = Blocks()
        XCTAssertIdentical(blocks.users, blocks.users)
    }

    func testRenamedAndKeywordNamespacesAreReachable() async throws {
        let blocks = Blocks(server: Servers.local, session: mockSession())
        let calls: [() async throws -> String] = [
            { try await blocks.class.ping() }, { try await blocks.type.ping() }, { try await blocks.selfApi.ping() },
            { try await blocks.initApi.ping() }, { try await blocks.closeApi.ping() }, { try await blocks.serverApi.ping() },
            { try await blocks.blocks.ping() }, { try await blocks.blocksApi.ping() }, { try await blocks.sendable.ping() },
            { try await blocks.servers.ping() }, { try await blocks.session.ping() }
        ]
        for call in calls {
            let pong = try await call()
            XCTAssertEqual(pong, "pong")
        }
        let namespaces = ["class", "type", "self", "init", "close", "server", "blocks", "blocksApi", "sendable", "servers", "session"]
        XCTAssertEqual(RecordingURLProtocol.methods, namespaces.map { "\($0).ping" })
        let renamed: [Any] = [blocks.blocks, blocks.blocksApi, blocks.sendable, blocks.selfApi, blocks.servers]
        XCTAssertEqual(renamed.map { "\(type(of: $0))" }, ["BlocksApiApi", "BlocksApi", "SendableApi", "SelfApi", "ServersApi"])
    }

    func testOIDCNamespacesShareTheStoreButNotTheirSessions() async throws {
        let store = BlocksRuntime.InMemoryTokenStore()
        await store.set("/auth/exchange#access_token", value: "at")
        await store.set("/auth/exchange#expires_at", value: "\(Int64.max)")
        let blocks = Blocks(session: mockSession(), tokenStore: store)
        let auth = try await blocks.auth.getClient()
        let admin = try await blocks.admin.getClient()
        let authToken = await auth.getAccessToken()
        let adminToken = await admin.getAccessToken()
        XCTAssertEqual(authToken, "at")
        XCTAssertNil(adminToken)
        XCTAssertIdentical(blocks.client.tokenStore as AnyObject, store)
    }

    func testTypedSignInSendsTheProvidersWireName() async throws {
        let blocks = Blocks(server: Servers.local, session: mockSession())
        // Typed by its own providers, so `auth.signIn(provider: Admin.GetClient.Provider.okta, ...)` doesn't compile.
        let auth: OIDCClient<Auth.GetClient.Provider> = try await blocks.auth.getClient()
        XCTAssertEqual(Auth.GetClient.Provider.allCases.map(\.rawValue), ["google", "github", "my-sso"])
        XCTAssertEqual(Admin.GetClient.Provider.allCases, [.okta])
        do {
            _ = try await auth.signIn(provider: .mySso, relayTo: "app://auth", launcher: UnusedLauncher())
            XCTFail("expected the stubbed authorize-params response to fail sign-in")
        } catch OIDCError.callbackError {
            // The recorder answers authorize-params with an RPC body, so sign-in stops after that request.
        }
        XCTAssertTrue(RecordingURLProtocol.urls.contains(URL(string: "http://localhost:3001/auth/authorize-params/my-sso")), "\(RecordingURLProtocol.urls)")
    }

    func testCloseFailsLaterCallsFromEveryNamespace() async {
        let blocks = Blocks(session: mockSession())
        blocks.close()
        let calls: [() async throws -> Void] = [{ _ = try await blocks.users.list() }, { _ = try await blocks.default.ping() }]
        for call in calls {
            do {
                try await call()
                XCTFail("expected ClientClosedError")
            } catch {
                XCTAssertTrue(error is ClientClosedError, "\(error)")
            }
        }
        XCTAssertEqual(RecordingURLProtocol.methods, [])
    }

    func testNamespaceOutlivesItsBlocks() async throws {
        weak var released: Blocks?
        let users: Users = {
            let blocks = Blocks(session: mockSession())
            released = blocks
            return blocks.users
        }()
        XCTAssertNil(released)
        let names = try await users.list()
        XCTAssertEqual(names, ["ada"])
    }

    // Compiles only while generated code and runtime types stay Sendable.
    func testBlocksCrossesConcurrencyDomains() async throws {
        let blocks = Blocks(server: Servers.local, session: mockSession())
        async let users = blocks.users.list()
        async let pong = blocks.default.ping()
        let detached = Task.detached { try await blocks.clientApi.ping() }
        let results = try await (users, pong, detached.value)
        XCTAssertEqual(results.0, ["ada"])
        XCTAssertEqual([results.1, results.2], ["pong", "pong"])
        requireSendable(Blocks.self)
        requireSendable(Users.self)
        requireSendable(BlocksClient.self)
        requireSendable(BlocksServer.self)
    }

    // Compiles only while BlocksClient.baseHost, which apps set, is not a stored static var.
    func testBaseHostIsReadableFromAnyConcurrencyDomain() async {
        let host = await Task.detached { BlocksClient.baseHost }.value
        XCTAssertEqual(host, BlocksClient.baseHost)
    }

    @available(*, deprecated)
    func testDeprecatedServerInitBuildsItsOwnLiveClient() async {
        // Port 9 refuses the connection, so a URLError shows the bridge's own client sent the request.
        let users = Users(server: BlocksServer(name: "refused", url: "http://127.0.0.1:9/aws-blocks/api"))
        do {
            _ = try await users.list()
            XCTFail("expected a connection error")
        } catch {
            XCTAssertTrue(error is URLError, "\(error)")
        }
    }

    private func requireSendable<T: Sendable>(_: T.Type) {}
}

private struct UnusedLauncher: BlocksRuntime.BrowserLauncher {
    func launch(authorizeURL: URL, callbackScheme: String) async throws -> URL {
        XCTFail("sign-in should stop before the browser opens")
        return authorizeURL
    }
}
