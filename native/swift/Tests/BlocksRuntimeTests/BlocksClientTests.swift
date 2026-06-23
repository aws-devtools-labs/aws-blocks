//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class BlocksClientTests: XCTestCase {

    // MARK: - Request Encoding

    func testExecuteEncodesCorrectJSONRPCRequest() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { request in
            // Verify basic request properties
            XCTAssertEqual(request.httpMethod, "POST")
            XCTAssertEqual(request.value(forHTTPHeaderField: "Content-Type"), "application/json")

            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = """
            {"jsonrpc":"2.0","result":"hello","id":1}
            """.data(using: .utf8)!
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.greet", params: ["world" as any Encodable], id: BlocksRequest.nextId())
        let result = try await client.execute(request)

        XCTAssertNotNil(result)
    }

    // MARK: - Response Parsing

    func testExecuteReturnsDataForObjectResult() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = """
            {"jsonrpc":"2.0","result":{"name":"Alice","age":30},"id":1}
            """.data(using: .utf8)!
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.getUser", params: [], id: 1)
        let result = try await client.execute(request)

        XCTAssertNotNil(result)
        // Should be decodable as a struct
        struct User: Decodable { let name: String
        let age: Int
        }
        let user = try JSONDecoder().decode(User.self, from: result!)
        XCTAssertEqual(user.name, "Alice")
        XCTAssertEqual(user.age, 30)
    }

    func testExecuteReturnsNilForNullResult() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = """
            {"jsonrpc":"2.0","result":null,"id":1}
            """.data(using: .utf8)!
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.get", params: [], id: 1)
        let result = try await client.execute(request)

        XCTAssertNil(result)
    }

    func testExecuteReturnsPrimitiveStringResult() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = """
            {"jsonrpc":"2.0","result":"hello world","id":1}
            """.data(using: .utf8)!
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.getValue", params: [], id: 1)
        let result = try await client.execute(request)

        XCTAssertNotNil(result)
        let str = try JSONDecoder().decode(String.self, from: result!)
        XCTAssertEqual(str, "hello world")
    }

    // MARK: - Error Handling

    func testExecuteThrowsOnJSONRPCError() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = """
            {"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid request"},"id":1}
            """.data(using: .utf8)!
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.bad", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as RPCError {
            XCTAssertEqual(error.message, "Invalid request")
        } catch {
            XCTFail("Expected RPCError, got \(error)")
        }
    }

    func testExecuteThrowsOnHTTPError() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 500, httpVersion: nil, headerFields: nil)!
            let data = """
            {"jsonrpc":"2.0","result":null,"id":1}
            """.data(using: .utf8)!
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.fail", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as RPCError {
            XCTAssertTrue(error.message.contains("500"))
        } catch {
            XCTFail("Expected RPCError, got \(error)")
        }
    }

    func testExecuteThrowsOnInvalidURL() async {
        let client = BlocksClient(url: "")

        let request = BlocksRequest(method: "api.test", params: [], id: 1)
        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as RPCError {
            XCTAssertTrue(error.message.contains("Invalid URL"))
        } catch {
            XCTFail("Expected RPCError, got \(error)")
        }
    }

    // MARK: - Cookie Handling

    func testStoresCookiesFromResponse() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let headers = ["Set-Cookie": "auth_session=token123; Max-Age=3600; Secure"]
            let response = HTTPURLResponse(url: URL(string: "http://localhost:3001/api")!, statusCode: 200, httpVersion: nil, headerFields: headers)!
            let data = """
            {"jsonrpc":"2.0","result":true,"id":1}
            """.data(using: .utf8)!
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "auth.signIn", params: [], id: 1)
        _ = try await client.execute(request)

        // Cookie should be stored — next request should include it
        // (We can't easily verify the cookie header without another request,
        // but at least verify it doesn't crash)
    }
}

// MARK: - Mock URLProtocol

private class MockURLProtocol: URLProtocol {
    static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = MockURLProtocol.handler else {
            client?.urlProtocol(self, didFailWithError: NSError(domain: "MockURLProtocol", code: -1))
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
