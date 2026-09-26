//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class UserAgentHeaderTests: XCTestCase {

    private final class NoopWebSocketDelegate: WebSocketDelegate {
        func onOpen(_ webSocket: URLSessionWebSocketTask) {}
        func onMessage(_ webSocket: URLSessionWebSocketTask, text: String) {}
        func onFailure(_ webSocket: URLSessionWebSocketTask, error: Error) {}
        func onClosed(_ webSocket: URLSessionWebSocketTask, code: Int, reason: String) {}
    }

    /// True if the head has a header whose name equals `name` (case-insensitive) and value
    /// equals `value`; the exact-name match stops `x-blocks-user-agent` satisfying `User-Agent`.
    private func wireHasHeader(_ head: String, name: String, value: String) -> Bool {
        head.split(separator: "\r\n").contains { line in
            let parts = line.split(separator: ":", maxSplits: 1)
            guard parts.count == 2 else { return false }
            return parts[0].trimmingCharacters(in: .whitespaces).caseInsensitiveCompare(name) == .orderedSame
                && parts[1].trimmingCharacters(in: .whitespaces) == value
        }
    }

    func testRPCSessionSendsCustomUserAgentHeader() {
        let client = BlocksClient(url: "http://localhost")
        let headers = client.session.configuration.httpAdditionalHeaders
        XCTAssertEqual(headers?["x-blocks-user-agent"] as? String, blocksUserAgentToken)
    }

    func testRuntimeSessionCarriesUserAgentHeader() {
        let headers = BlocksRuntimeSession.shared.configuration.httpAdditionalHeaders
        XCTAssertEqual(headers?["User-Agent"] as? String, blocksUserAgentToken)
    }

    func testFileUploadRequestCarriesUserAgentHeader() async throws {
        // No session argument: exercises the `?? BlocksRuntimeSession.shared` default path.
        let listener = try LoopbackListener()
        defer { listener.close() }

        let handle = FileUploadHandle(url: "http://127.0.0.1:\(listener.port)/put")
        _ = try? await handle.upload(data: Data("x".utf8))

        let head = listener.waitForRequestHead()
        XCTAssertTrue(
            wireHasHeader(head, name: "User-Agent", value: blocksUserAgentToken),
            "upload default session must send the user-agent on the wire; got: \(head)"
        )
    }

    func testFileDownloadRequestCarriesUserAgentHeader() async throws {
        // No session argument: exercises the `?? BlocksRuntimeSession.shared` default path.
        let listener = try LoopbackListener()
        defer { listener.close() }

        let handle = FileDownloadHandle(url: "http://127.0.0.1:\(listener.port)/get")
        _ = try? await handle.download()

        let head = listener.waitForRequestHead()
        XCTAssertTrue(
            wireHasHeader(head, name: "User-Agent", value: blocksUserAgentToken),
            "download default session must send the user-agent on the wire; got: \(head)"
        )
    }

    func testWebSocketUpgradeSendsUserAgentHeader() throws {
        let listener = try LoopbackListener()
        defer { listener.close() }

        let session = WebSocketSession()
        let delegate = NoopWebSocketDelegate()
        let wsUrl = "ws://127.0.0.1:\(listener.port)/ws"
        _ = try session.acquire(wsUrl: wsUrl, token: "tok", listener: delegate)
        defer { session.release(wsUrl: wsUrl, token: "tok", listener: delegate) }

        let head = listener.waitForRequestHead()
        XCTAssertTrue(
            wireHasHeader(head, name: "User-Agent", value: blocksUserAgentToken),
            "WebSocket upgrade must send the user-agent on the wire; got: \(head)"
        )
    }

    func testWebSocketUpgradeSetsUserAgentWhenSessionConfigLacksIt() throws {
        let listener = try LoopbackListener()
        defer { listener.close() }

        // A caller-supplied session whose configuration carries no user-agent: the token
        // reaches the wire only via the explicit setValue on the handshake request.
        let bareSession = URLSession(configuration: .ephemeral)
        let session = WebSocketSession(session: bareSession)
        let delegate = NoopWebSocketDelegate()
        let wsUrl = "ws://127.0.0.1:\(listener.port)/ws"
        _ = try session.acquire(wsUrl: wsUrl, token: "tok", listener: delegate)
        defer { session.release(wsUrl: wsUrl, token: "tok", listener: delegate) }

        let head = listener.waitForRequestHead()
        XCTAssertTrue(
            wireHasHeader(head, name: "User-Agent", value: blocksUserAgentToken),
            "explicit handshake user-agent must be sent even when the session config lacks it; got: \(head)"
        )
    }
}
