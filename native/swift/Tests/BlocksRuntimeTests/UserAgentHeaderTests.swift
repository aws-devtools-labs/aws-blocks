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
        let config = URLSessionConfiguration.ephemeral
        config.httpAdditionalHeaders = BlocksRuntimeSession.shared.configuration.httpAdditionalHeaders
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        var captured: String?
        MockURLProtocol.handler = { request in
            captured = request.value(forHTTPHeaderField: "User-Agent")
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data())
        }

        let handle = FileUploadHandle(url: "https://s3.example.com/put", session: session)
        try await handle.upload(data: Data("x".utf8))
        XCTAssertEqual(captured, blocksUserAgentToken)
    }

    func testFileDownloadRequestCarriesUserAgentHeader() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.httpAdditionalHeaders = BlocksRuntimeSession.shared.configuration.httpAdditionalHeaders
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        var captured: String?
        MockURLProtocol.handler = { request in
            captured = request.value(forHTTPHeaderField: "User-Agent")
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data("x".utf8))
        }

        let handle = FileDownloadHandle(url: "https://s3.example.com/get", session: session)
        _ = try await handle.download()
        XCTAssertEqual(captured, blocksUserAgentToken)
    }

    func testWebSocketUpgradeSendsUserAgentHeader() throws {
        let session = WebSocketSession()
        let delegate = NoopWebSocketDelegate()
        let connection = try session.acquire(wsUrl: "wss://127.0.0.1:1/ws", token: "tok", listener: delegate)
        defer { session.release(wsUrl: "wss://127.0.0.1:1/ws", token: "tok", listener: delegate) }

        let sent = connection.task.originalRequest?.value(forHTTPHeaderField: "User-Agent")
        XCTAssertEqual(sent, blocksUserAgentToken)
    }
}
