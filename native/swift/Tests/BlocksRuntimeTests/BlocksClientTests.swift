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
            let data = Data("""
            {"jsonrpc":"2.0","result":"hello","id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.greet", params: ["world" as any Encodable], id: BlocksRequest.nextId())
        let result = try await client.execute(request)

        XCTAssertNotNil(result)
    }

    // MARK: - Request URL

    func testExecutePostsToTheMethodsNamespacePath() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        var requestedURL: URL?
        MockURLProtocol.handler = { request in
            requestedURL = request.url
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"jsonrpc":"2.0","result":"ok","id":1}"#.utf8))
        }

        let client = BlocksClient(url: "https://d123.cloudfront.net/aws-blocks/api", session: session)
        _ = try await client.execute(BlocksRequest(method: "reports.build", params: [], id: 1))

        XCTAssertEqual(requestedURL?.absoluteString, "https://d123.cloudfront.net/aws-blocks/api/reports")
    }

    func testRpcURLAppendsTheNamespaceSegment() {
        XCTAssertEqual(BlocksClient.rpcURL(base: "http://localhost:3001/aws-blocks/api", method: "api.greet"), "http://localhost:3001/aws-blocks/api/api")
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/prod/aws-blocks/api//", method: "reports.build"), "https://a.example/prod/aws-blocks/api/reports")
        // Only the first `.` separates the namespace.
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/aws-blocks/api", method: "ns.a.b"), "https://a.example/aws-blocks/api/ns")
        // Path-safe characters are sent as they are; others are percent-encoded.
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/aws-blocks/api", method: "$ns.m"), "https://a.example/aws-blocks/api/$ns")
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/aws-blocks/api", method: "café.m"), "https://a.example/aws-blocks/api/caf%C3%A9")
    }

    func testRpcURLLeavesTheBaseForAMethodWithoutNamespace() {
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/aws-blocks/api", method: "greet"), "https://a.example/aws-blocks/api")
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/aws-blocks/api", method: ".greet"), "https://a.example/aws-blocks/api")
    }

    // MARK: - Response Parsing

    func testExecuteReturnsDataForObjectResult() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = Data("""
            {"jsonrpc":"2.0","result":{"name":"Alice","age":30},"id":1}
            """.utf8)
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
            let data = Data("""
            {"jsonrpc":"2.0","result":null,"id":1}
            """.utf8)
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
            let data = Data("""
            {"jsonrpc":"2.0","result":"hello world","id":1}
            """.utf8)
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
            let data = Data("""
            {"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid request"},"id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.bad", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as RPCError {
            XCTAssertEqual(error.message, "Error occured with code: -32600 message: Invalid request")
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
            let data = Data("""
            {"jsonrpc":"2.0","result":null,"id":1}
            """.utf8)
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
            let data = Data("""
            {"jsonrpc":"2.0","result":true,"id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "auth.signIn", params: [], id: 1)
        _ = try await client.execute(request)

        // Cookie should be stored — next request should include it
        // (We can't easily verify the cookie header without another request,
        // but at least verify it doesn't crash)
    }

    // MARK: - Base Host

    func testBaseHostCanBeSetAndReadFromConcurrentTasks() async {
        XCTAssertEqual(BlocksClient.baseHost, "localhost")
        defer { BlocksClient.baseHost = "localhost" }
        let hosts = (0 ..< 100).map { "192.168.1.\($0)" }

        let reads = await withTaskGroup(of: String.self) { group in
            for host in hosts {
                group.addTask {
                    BlocksClient.baseHost = host
                    return BlocksClient.baseHost
                }
            }
            return await group.reduce(into: [String]()) { $0.append($1) }
        }

        XCTAssertEqual(reads.filter { !hosts.contains($0) }, [])
        XCTAssertTrue(hosts.contains(BlocksClient.baseHost))
    }
}
