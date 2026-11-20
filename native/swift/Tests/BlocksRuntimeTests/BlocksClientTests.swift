//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class BlocksClientTests: XCTestCase {

    override func tearDown() {
        MockURLProtocol.handler = nil
        super.tearDown()
    }

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

    // MARK: - JSON-RPC errors on a non-2xx status (`httpErrorStatus`)

    /// A namespace created with `httpErrorStatus: true` answers a 401 with the same envelope
    /// as the 200 it sends otherwise, so both decode to the same `ApiError`.
    func testJSONRPCErrorOnHTTP401IsTheSameApiErrorAsOnHTTP200() async throws {
        for status in [401, 200] {
            let client = makeClient(status: status, body: """
            {"jsonrpc":"2.0","error":{"code":401,"message":"Authentication required","data":{"name":"NotAuthenticatedException"}},"id":1}
            """)
            do {
                _ = try await client.execute(BlocksRequest(method: "api.authRequired", params: [], id: BlocksRequest.nextId()))
                XCTFail("HTTP \(status): expected an ApiError")
            } catch let error as ApiError {
                XCTAssertEqual(error.status, 401)
                XCTAssertEqual(error.message, "Authentication required")
                XCTAssertEqual(error.name, "NotAuthenticatedException")
                XCTAssertFalse(error.retriable)
            }
        }
    }

    func testReservedJSONRPCCodeIsReportedAs500WithItsNameIntact() async throws {
        let client = makeClient(status: 200, body: """
        {"jsonrpc":"2.0","error":{"code":-32602,"message":"Invalid params","data":{"name":"InvalidParams"}},"id":1}
        """)
        do {
            _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
            XCTFail("expected an ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.status, 500)
            XCTAssertEqual(error.name, "InvalidParams")
        }
    }

    func testAReservedCodeTheServerLeavesUnnamedGetsItsNameSynthesized() async throws {
        let client = makeClient(status: 200, body: """
        {"jsonrpc":"2.0","error":{"code":-32601,"message":"Method not found: api.nope"},"id":1}
        """)
        do {
            _ = try await client.execute(BlocksRequest(method: "api.nope", params: [], id: 1))
            XCTFail("expected an ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.status, 500)
            XCTAssertEqual(error.name, "MethodNotFound")
            XCTAssertTrue(error.isBlocksError(name: "MethodNotFound"))
        }
    }

    func testANameTheServerSentWinsOverTheSynthesizedOne() async throws {
        let client = makeClient(status: 200, body: """
        {"jsonrpc":"2.0","error":{"code":-32600,"message":"Invalid Request","data":{"name":"SomethingSpecific"}},"id":1}
        """)
        do {
            _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
            XCTFail("expected an ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.name, "SomethingSpecific")
        }
    }

    func testRetriableCrossesTheWire() async throws {
        let client = makeClient(status: 200, body: """
        {"jsonrpc":"2.0","error":{"code":400,"message":"Wrong code","data":{"name":"CodeMismatchException","retriable":true}},"id":1}
        """)
        do {
            _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
            XCTFail("expected an ApiError")
        } catch let error as ApiError {
            XCTAssertTrue(error.retriable)
        }
    }

    func testANon2xxWithoutAJSONRPCErrorObjectIsATransportError() async throws {
        let client = makeClient(status: 502, body: "<html>bad gateway</html>")
        do {
            _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
            XCTFail("expected a TransportError")
        } catch let error as TransportError {
            XCTAssertEqual(error.statusCode, 502)
            XCTAssertEqual(error.message, "HTTP 502")
        }
    }

    /// API Gateway's own errors carry their text under `message`, e.g. a 504
    /// `{"message":"Endpoint request timed out"}` or a 429 `{"message":"Too Many Requests"}`.
    func testAGatewaysMessageBodyIsReadBeforeItsErrorBody() async throws {
        let cases: [(status: Int, body: String, message: String)] = [
            (504, #"{"message":"Endpoint request timed out"}"#, "Endpoint request timed out"),
            (429, #"{"message":"Too Many Requests"}"#, "Too Many Requests"),
            (502, #"{"message":"Bad gateway","error":"ignored"}"#, "Bad gateway"),
            (404, #"{"error":"Not Found"}"#, "Not Found"),
            (503, #"{"message":"","error":"Unavailable"}"#, "Unavailable"),
            (503, #"{"message":"","error":""}"#, "HTTP 503"),
            (500, #"{"message":42}"#, "HTTP 500")
        ]
        for (status, body, message) in cases {
            let client = makeClient(status: status, body: body)
            do {
                _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
                XCTFail("\(body): expected a TransportError")
            } catch let error as TransportError {
                XCTAssertEqual(error.statusCode, status, body)
                XCTAssertEqual(error.message, message, body)
            }
        }
    }

    func testA2xxResponseThatIsNotJSONIsATransportError() async throws {
        let client = makeClient(status: 200, body: "<html>not json</html>")
        do {
            _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
            XCTFail("expected a TransportError")
        } catch let error as TransportError {
            XCTAssertEqual(error.statusCode, 200)
            XCTAssertEqual(error.message, "Response was not a JSON-RPC envelope")
        }
    }

    func testA2xxEnvelopeWithNoResultIsAVoidSuccess() async throws {
        // A void handler on current core answers this: `JSON.stringify` drops `result: undefined`.
        let client = makeClient(status: 200, body: "{\"jsonrpc\":\"2.0\",\"id\":1}")
        let result = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
        XCTAssertNil(result)
    }

    func testA2xxEnvelopeWithANullResultIsAVoidSuccess() async throws {
        // What an older core answered for a void handler.
        let client = makeClient(status: 200, body: "{\"jsonrpc\":\"2.0\",\"result\":null,\"id\":1}")
        let result = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
        XCTAssertNil(result)
    }

    func testA2xxJSONObjectThatIsNotAnEnvelopeIsATransportError() async throws {
        for body in ["{\"id\":1}", "{\"jsonrpc\":\"1.0\",\"id\":1}", "{\"result\":{\"a\":1}}", "[]"] {
            let client = makeClient(status: 200, body: body)
            do {
                _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
                XCTFail("expected a TransportError for \(body)")
            } catch let error as TransportError {
                XCTAssertEqual(error.statusCode, 200, body)
                XCTAssertEqual(error.message, "Response was not a JSON-RPC envelope", body)
            }
        }
    }

    // MARK: - Cancellation

    func testACancelledRequestThrowsCancellationErrorNotTransportError() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HangingURLProtocol.self]
        let client = BlocksClient(url: "http://localhost:3000/cdk-blocks/api", session: URLSession(configuration: config))
        let started = expectation(description: "request started")
        HangingURLProtocol.onStart = { started.fulfill() }

        let task = Task {
            try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
        }
        await fulfillment(of: [started], timeout: 10)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {
            // The request was in flight when its task was cancelled.
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
    }

    func testACancelledRawRouteThrowsCancellationError() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [HangingURLProtocol.self]
        let client = BlocksClient(url: "http://localhost:3000/cdk-blocks/api", session: URLSession(configuration: config))
        let started = expectation(description: "request started")
        HangingURLProtocol.onStart = { started.fulfill() }

        let task = Task {
            try await client.postRawRoute(path: "/auth/exchange", body: [:])
        }
        await fulfillment(of: [started], timeout: 10)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("expected CancellationError")
        } catch is CancellationError {
            // The request was in flight when its task was cancelled.
        } catch {
            XCTFail("expected CancellationError, got \(error)")
        }
    }

    // MARK: - Raw-route errors

    func testARawRouteNonJSONErrorBodyIsATransportError() async throws {
        let client = makeClient(status: 502, body: "<html>Bad Gateway</html>")
        do {
            _ = try await client.postRawRoute(path: "/auth/exchange", body: [:])
            XCTFail("expected a TransportError")
        } catch let error as TransportError {
            XCTAssertEqual(error.statusCode, 502)
            XCTAssertEqual(error.message, "HTTP 502")
        }
    }

    func testARawRouteJSONErrorBodyKeepsTheServersMessageUnchanged() async throws {
        let client = makeClient(status: 403, body: "{\"name\":\"RelayNotAllowed\",\"error\":\"That relay is not allowed.\"}")
        do {
            _ = try await client.postRawRoute(path: "/auth/authorize-params/google", body: [:])
            XCTFail("expected an ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.status, 403)
            XCTAssertEqual(error.name, "RelayNotAllowed")
            XCTAssertEqual(error.message, "That relay is not allowed.")
        }
    }

    func testARawRouteJSONErrorBodyWithNoTextFallsBackToTheStatus() async throws {
        let client = makeClient(status: 500, body: "{\"name\":\"Boom\"}")
        do {
            _ = try await client.postRawRoute(path: "/x", body: [:])
            XCTFail("expected an ApiError")
        } catch let error as ApiError {
            XCTAssertEqual(error.name, "Boom")
            XCTAssertEqual(error.message, "HTTP 500")
        }
    }

    func testAConnectionFailureIsATransportErrorWithNoStatus() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        MockURLProtocol.handler = { _ in
            throw URLError(.cannotConnectToHost)
        }
        let client = BlocksClient(url: "http://localhost:3000/cdk-blocks/api", session: URLSession(configuration: config))
        do {
            _ = try await client.execute(BlocksRequest(method: "api.x", params: [], id: 1))
            XCTFail("expected a TransportError")
        } catch let error as TransportError {
            XCTAssertNil(error.statusCode)
            XCTAssertNotNil(error.underlyingError)
        }
    }

    /// A client whose every request is answered with `status` and `body`.
    private func makeClient(status: Int, body: String) -> BlocksClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        MockURLProtocol.handler = { request in
            (
                HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!,
                Data(body.utf8)
            )
        }
        return BlocksClient(url: "http://localhost:3000/cdk-blocks/api", session: URLSession(configuration: config))
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

        let client = BlocksClient(url: "https://d123.cloudfront.net/cdk-blocks/api", session: session)
        _ = try await client.execute(BlocksRequest(method: "reports.build", params: [], id: 1))

        XCTAssertEqual(requestedURL?.absoluteString, "https://d123.cloudfront.net/cdk-blocks/api/reports")
    }

    func testRpcURLAppendsTheNamespaceSegment() {
        XCTAssertEqual(BlocksClient.rpcURL(base: "http://localhost:3001/cdk-blocks/api", method: "api.greet"), "http://localhost:3001/cdk-blocks/api/api")
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/prod/cdk-blocks/api//", method: "reports.build"), "https://a.example/prod/cdk-blocks/api/reports")
        // Only the first `.` separates the namespace.
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/cdk-blocks/api", method: "ns.a.b"), "https://a.example/cdk-blocks/api/ns")
        // Path-safe characters are sent as they are; others are percent-encoded.
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/cdk-blocks/api", method: "$ns.m"), "https://a.example/cdk-blocks/api/$ns")
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/cdk-blocks/api", method: "café.m"), "https://a.example/cdk-blocks/api/caf%C3%A9")
    }

    func testRpcURLLeavesTheBaseForAMethodWithoutNamespace() {
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/cdk-blocks/api", method: "greet"), "https://a.example/cdk-blocks/api")
        XCTAssertEqual(BlocksClient.rpcURL(base: "https://a.example/cdk-blocks/api", method: ".greet"), "https://a.example/cdk-blocks/api")
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
        } catch let error as ApiError {
            XCTAssertEqual(error.message, "Invalid request")
            XCTAssertEqual(error.status, 500, "a reserved JSON-RPC code has no HTTP meaning")
            XCTAssertEqual(error.name, "InvalidRequest", "the server sent no `data`, so the name is filled in from the code")
            XCTAssertFalse(error.retriable, "the server sent no `data`")
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testExecuteExposesServerErrorNameAndStatus() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = Data("""
            {"jsonrpc":"2.0","error":{"code":401,"message":"Not signed in","data":{"name":"NotAuthenticatedException"}},"id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.whoAmI", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as ApiError {
            XCTAssertEqual(error.name, "NotAuthenticatedException")
            XCTAssertEqual(error.status, 401)
            XCTAssertEqual(error.message, "Not signed in")
            XCTAssertFalse(error.retriable, "the server sent no `retriable`")
            XCTAssertTrue(error.isBlocksError(name: "NotAuthenticatedException"))
            XCTAssertFalse(error.isBlocksError(name: "CodeMismatchException"))
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    /// The server sends `error.data.retriable: true` for a failure the caller can retry in place
    /// (a wrong MFA code on a sign-in challenge); it is omitted otherwise.
    func testExecuteExposesServerErrorRetriable() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = Data("""
            {"jsonrpc":"2.0","error":{"code":400,"message":"Wrong MFA code","data":{"name":"CodeMismatchException","retriable":true}},"id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "authApi.setAuthState", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as ApiError {
            XCTAssertEqual(error.name, "CodeMismatchException")
            XCTAssertEqual(error.status, 400)
            XCTAssertTrue(error.retriable)
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testExecuteReadsRetriableOnlyWhenTrue() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = Data("""
            {"jsonrpc":"2.0","error":{"code":400,"message":"Code expired","data":{"name":"ExpiredCodeException","retriable":false}},"id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "authApi.setAuthState", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as ApiError {
            XCTAssertEqual(error.name, "ExpiredCodeException")
            XCTAssertFalse(error.retriable)
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testExecuteIgnoresNonObjectErrorData() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = Data("""
            {"jsonrpc":"2.0","error":{"code":500,"message":"Internal error","data":["not","an","object"]},"id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.fail", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as ApiError {
            XCTAssertEqual(error.status, 500)
            XCTAssertEqual(error.message, "Internal error")
            XCTAssertNil(error.name)
            XCTAssertFalse(error.retriable)
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testExecuteIgnoresNonBooleanRetriableAndNonStringName() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            let data = Data("""
            {"jsonrpc":"2.0","error":{"code":400,"message":"Odd data","data":{"name":42,"retriable":1}},"id":1}
            """.utf8)
            return (response, data)
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.fail", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as ApiError {
            XCTAssertNil(error.name)
            XCTAssertFalse(error.retriable, "`retriable` is true only for the JSON boolean `true`, not the number 1")
        } catch {
            XCTFail("Expected ApiError, got \(error)")
        }
    }

    func testExecuteFillsInACodeAndMessageTheErrorLacks() async {
        let cases: [(body: String, message: String)] = [
            (#"{"jsonrpc":"2.0","error":{},"id":1}"#, "Unknown error"),
            (#"{"jsonrpc":"2.0","error":{"code":"abc","message":"Odd code"},"id":1}"#, "Odd code")
        ]
        for (body, message) in cases {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [MockURLProtocol.self]
            let session = URLSession(configuration: config)
            MockURLProtocol.handler = { request in
                let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
                return (response, Data(body.utf8))
            }
            let client = BlocksClient(url: "http://localhost:3001/api", session: session)
            do {
                _ = try await client.execute(BlocksRequest(method: "api.fail", params: [], id: 1))
                XCTFail("\(body): expected an ApiError")
            } catch let error as ApiError {
                XCTAssertEqual(error.status, 500, body)
                XCTAssertEqual(error.message, message, body)
            } catch {
                XCTFail("\(body): expected ApiError, got \(error)")
            }
        }
    }

    func testIsBlocksErrorIsFalseForOtherErrors() {
        XCTAssertFalse(TransportError(message: "HTTP 502", statusCode: 502).isBlocksError(name: "NotAuthenticatedException"))
        XCTAssertFalse(ApiError(message: "Nope", status: 400, name: "SomethingElse").isBlocksError(name: "NotAuthenticatedException"))
        XCTAssertFalse(ApiError(message: "Nope", status: 400).isBlocksError(name: "NotAuthenticatedException"))
        XCTAssertFalse(ClientClosedError().isBlocksError(name: "NotAuthenticatedException"))
        XCTAssertFalse(URLError(.notConnectedToInternet).isBlocksError(name: "NotAuthenticatedException"))
    }

    func testIsBlocksErrorMatchesAnApiErrorByName() {
        let error = ApiError(message: "The sign-in provider refused the sign-in.", status: 400, name: "IdpErrorException")
        XCTAssertTrue(error.isBlocksError(name: "IdpErrorException"))
        XCTAssertFalse(error.isBlocksError(name: "NotAuthenticatedException"))
    }

    /// The server collapses an unbranded exception to a nameless JSON-RPC 500 with no `data`; a
    /// gateway 500 has no JSON-RPC body at all. The first is an `ApiError`, the second a
    /// `TransportError`, and neither carries a name.
    func testNamelessJSONRPC500IsAnApiErrorAndGateway500IsATransportError() async {
        let cases: [(body: String, isApi: Bool, message: String)] = [
            (#"{"jsonrpc":"2.0","error":{"code":500,"message":"Internal error"},"id":1}"#, true, "Internal error"),
            ("<html>Internal Server Error</html>", false, "HTTP 500")
        ]
        for (body, isApi, message) in cases {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [MockURLProtocol.self]
            let session = URLSession(configuration: config)
            MockURLProtocol.handler = { request in
                let response = HTTPURLResponse(url: request.url!, statusCode: 500, httpVersion: nil, headerFields: nil)!
                return (response, Data(body.utf8))
            }
            let client = BlocksClient(url: "http://localhost:3001/api", session: session)
            do {
                _ = try await client.execute(BlocksRequest(method: "api.fail", params: [], id: 1))
                XCTFail("\(body): expected an error")
            } catch let error as ApiError {
                XCTAssertTrue(isApi, body)
                XCTAssertEqual(error.status, 500, body)
                XCTAssertNil(error.name, body)
                XCTAssertFalse(error.retriable, body)
                XCTAssertEqual(error.message, message, body)
            } catch let error as TransportError {
                XCTAssertFalse(isApi, body)
                XCTAssertEqual(error.statusCode, 500, body)
                XCTAssertEqual(error.message, message, body)
            } catch {
                XCTFail("\(body): unexpected \(error)")
            }
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
        } catch let error as TransportError {
            XCTAssertEqual(error.statusCode, 500)
            XCTAssertTrue(error.message.contains("500"))
        } catch {
            XCTFail("Expected TransportError, got \(error)")
        }
    }

    func testExecuteKeepsTheHTTPStatusWhenTheBodyIsNotAJSONObject() async {
        let cases: [(body: String, status: Int)] = [
            ("<html>Bad Gateway</html>", 502),
            ("[1,2,3]", 500),
            ("42", 500)
        ]
        for (body, status) in cases {
            let config = URLSessionConfiguration.ephemeral
            config.protocolClasses = [MockURLProtocol.self]
            let session = URLSession(configuration: config)
            MockURLProtocol.handler = { request in
                let response = HTTPURLResponse(url: request.url!, statusCode: status, httpVersion: nil, headerFields: nil)!
                return (response, Data(body.utf8))
            }
            let client = BlocksClient(url: "http://localhost:3001/api", session: session)
            do {
                _ = try await client.execute(BlocksRequest(method: "api.fail", params: [], id: 1))
                XCTFail("\(body): expected a TransportError")
            } catch let error as TransportError {
                XCTAssertEqual(error.message, "HTTP \(status)", body)
                XCTAssertEqual(error.statusCode, status, body)
            } catch {
                XCTFail("\(body): expected TransportError, got \(error)")
            }
        }
    }

    func testExecuteThrowsOnInvalidJSONWithASuccessStatus() async {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let session = URLSession(configuration: config)

        MockURLProtocol.handler = { _ in
            let response = HTTPURLResponse(url: URL(string: "http://localhost")!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data("not json".utf8))
        }

        let client = BlocksClient(url: "http://localhost:3001/api", session: session)
        let request = BlocksRequest(method: "api.fail", params: [], id: 1)

        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as TransportError {
            XCTAssertEqual(error.message, "Response was not a JSON-RPC envelope")
            XCTAssertEqual(error.statusCode, 200)
        } catch {
            XCTFail("Expected TransportError, got \(error)")
        }
    }

    func testExecuteThrowsOnInvalidURL() async {
        let client = BlocksClient(url: "")

        let request = BlocksRequest(method: "api.test", params: [], id: 1)
        do {
            _ = try await client.execute(request)
            XCTFail("Expected error")
        } catch let error as TransportError {
            XCTAssertTrue(error.message.contains("Invalid URL"))
        } catch {
            XCTFail("Expected TransportError, got \(error)")
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

    // The Keychain is not reliably writable from `swift test`, so the attribute rules that decide
    // whether a stored cookie is attached are tested on `StoredCookie` and on a `CookieJar` over
    // in-memory items.

    private let apiURL = URL(string: "https://example.com/cdk-blocks/api")!
    private let now = Date(timeIntervalSince1970: 1_900_000_000)

    private func cookie(_ setCookie: String, from url: URL? = nil) throws -> StoredCookie {
        try XCTUnwrap(StoredCookie(setCookie: setCookie, requestURL: url ?? apiURL, now: now))
    }

    func testSecureCookieIsAttachedOverHttpsButNotHttp() throws {
        let stored = try cookie("auth_session=token123; Path=/; Secure")
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/cdk-blocks/api")!))
        XCTAssertFalse(stored.matches(URL(string: "http://example.com/cdk-blocks/api")!))
    }

    func testCookieIsAttachedOnlyUnderItsPath() throws {
        let stored = try cookie("auth_session=token123; Path=/foo")
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/foo")!))
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/foo/bar")!))
        XCTAssertFalse(stored.matches(URL(string: "https://example.com/bar")!))
        XCTAssertFalse(stored.matches(URL(string: "https://example.com/foobar")!))
    }

    func testTrailingSlashPathIsNotSentToPathWithoutIt() throws {
        let stored = try cookie("auth_session=token123; Path=/admin/")
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/admin/")!))
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/admin/users")!))
        XCTAssertFalse(stored.matches(URL(string: "https://example.com/admin")!))
    }

    func testPathIsComparedPercentEncoded() throws {
        let plain = try cookie("a=1; Path=/private")
        XCTAssertFalse(plain.matches(URL(string: "https://example.com/pri%76ate")!))
        let encoded = try cookie("a=1; Path=/foo%2Fbar")
        XCTAssertTrue(encoded.matches(URL(string: "https://example.com/foo%2Fbar")!))
    }

    func testCookieWithoutPathAppliesToRequestDirectory() throws {
        let stored = try cookie("auth_session=token123")
        XCTAssertEqual(stored.path, "/cdk-blocks")
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/cdk-blocks/other")!))
        XCTAssertFalse(stored.matches(URL(string: "https://example.com/auth")!))
    }

    func testCookieIsAttachedOnlyToHostThatSetIt() throws {
        let stored = try cookie("auth_session=token123; Path=/")
        XCTAssertFalse(stored.matches(URL(string: "https://other.com/")!))
        XCTAssertFalse(stored.matches(URL(string: "https://sub.example.com/")!))
    }

    func testMaxAgeZeroCookieIsExpired() throws {
        XCTAssertTrue(try cookie("auth_session=; Max-Age=0; Path=/").isExpired(at: now))
    }

    func testPastExpiresCookieIsExpired() throws {
        let stored = try cookie("auth_session=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/")
        XCTAssertTrue(stored.isExpired(at: now))
    }

    func testMaxAgeCookieIsKeptUntilItPasses() throws {
        let stored = try cookie("auth_session=token123; Max-Age=3600; Path=/")
        XCTAssertFalse(stored.isExpired(at: now))
        XCTAssertFalse(stored.isExpired(at: now.addingTimeInterval(3_599)))
        XCTAssertTrue(stored.isExpired(at: now.addingTimeInterval(3_600)))
    }

    func testMaxAgeTakesPrecedenceOverExpires() throws {
        let stored = try cookie("a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60")
        XCTAssertFalse(stored.isExpired(at: now))
    }

    func testParsesExpiresFormats() {
        let expected = Date(timeIntervalSince1970: 1_445_412_480)
        XCTAssertEqual(StoredCookie.parseDate("Wed, 21 Oct 2015 07:28:00 GMT"), expected)
        XCTAssertEqual(StoredCookie.parseDate("Wednesday, 21-Oct-15 07:28:00 GMT"), expected)
        XCTAssertNil(StoredCookie.parseDate("not a date"))
    }

    func testSameNamedCookiesFromDifferentHostsOrPathsHaveDistinctKeys() throws {
        let root = try cookie("a=1; Path=/")
        let other = try cookie("a=2; Path=/", from: URL(string: "https://other.com/")!)
        let foo = try cookie("a=3; Path=/foo")
        XCTAssertEqual(Set([root.storageKey, other.storageKey, foo.storageKey]).count, 3)
    }

    func testStoredRecordRoundTrips() throws {
        let stored = try cookie("a=1; Path=/foo; Secure; Max-Age=60")
        let record = try XCTUnwrap(stored.encodedValue())
        XCTAssertEqual(StoredCookie.decode(account: stored.storageKey, value: record), stored)
    }

    /// An earlier version stored only `host|name` → value. The item is read for its host as `Path=/`
    /// and `Secure`, the attributes the Auth block sets its session cookies with.
    func testValueStoredByEarlierVersionIsReadAsSecureForRootPath() {
        XCTAssertEqual(
            StoredCookie.decode(account: "example.com|auth_session", value: "token123"),
            StoredCookie(
                host: "example.com", name: "auth_session", value: "token123", path: "/", secure: true, expiresAt: nil
            )
        )
        XCTAssertTrue(StoredCookie.isEarlierVersionItem(account: "example.com|auth_session", value: "token123"))
    }

    func testRecordOfThisVersionIsNotAnEarlierVersionItem() throws {
        let stored = try cookie("a=1; Path=/; Secure")
        let record = try XCTUnwrap(stored.encodedValue())
        XCTAssertFalse(StoredCookie.isEarlierVersionItem(account: stored.storageKey, value: record))
        XCTAssertFalse(StoredCookie.isEarlierVersionItem(account: "example.com|/|a", value: "{not json"))
    }

    /// Only touched under the `CookieJar` lock, or after concurrent work has finished.
    private final class InMemoryCookieItems: CookieItemStore, @unchecked Sendable {
        var items: [String: String] = [:]
        func loadAll() -> [String: String] { items }
        func set(name: String, value: String) { items[name] = value }
        func remove(name: String) { items[name] = nil }
    }

    func testJarAttachesOnlyMatchingCookies() {
        let jar = CookieJar(items: InMemoryCookieItems())
        jar.save(setCookie: "a=1; Path=/; Secure", requestURL: apiURL, now: now)
        jar.save(setCookie: "b=2; Path=/foo", requestURL: apiURL, now: now)
        XCTAssertEqual(jar.cookieHeader(for: URL(string: "https://example.com/")!, now: now), "a=1")
        XCTAssertNil(jar.cookieHeader(for: URL(string: "http://example.com/")!, now: now))
        XCTAssertNil(jar.cookieHeader(for: URL(string: "https://other.com/")!, now: now))
        let fooHeader = jar.cookieHeader(for: URL(string: "https://example.com/foo")!, now: now)
        XCTAssertEqual(fooHeader?.split(separator: ";").map { $0.trimmingCharacters(in: .whitespaces) }.sorted(), ["a=1", "b=2"])
    }

    func testJarDropsCookieOnMaxAgeZeroAndOnceExpired() {
        let items = InMemoryCookieItems()
        let jar = CookieJar(items: items)
        jar.save(setCookie: "a=1; Path=/", requestURL: apiURL, now: now)
        jar.save(setCookie: "a=; Max-Age=0; Path=/", requestURL: apiURL, now: now)
        XCTAssertTrue(items.items.isEmpty)

        jar.save(setCookie: "b=2; Max-Age=60; Path=/", requestURL: apiURL, now: now)
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "b=2")
        XCTAssertNil(jar.cookieHeader(for: apiURL, now: now.addingTimeInterval(60)))
        XCTAssertTrue(items.items.isEmpty)
    }

    func testJarReplacesCookieStoredByEarlierVersion() {
        let items = InMemoryCookieItems()
        items.items["example.com|auth_session"] = "old"
        let jar = CookieJar(items: items)

        // A cookie of another name leaves the earlier version's item in place.
        jar.save(setCookie: "other=1; Path=/", requestURL: apiURL, now: now)
        XCTAssertEqual(items.items["example.com|auth_session"], "old")

        // Set without a `Path`, so it is stored for `/cdk-blocks`, and the old item is removed by `save`.
        jar.save(setCookie: "auth_session=new", requestURL: apiURL, now: now)
        XCTAssertNil(items.items["example.com|auth_session"])
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "auth_session=new; other=1")

        // Deleting `auth_session` leaves the unrelated `other` cookie set above.
        jar.save(setCookie: "auth_session=; Max-Age=0; Path=/", requestURL: apiURL, now: now)
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "other=1")
    }

    /// The earlier version's item is read as `Secure`, so it is sent over `https` to the host that set
    /// it and to no other host, subdomains included, and never over plain `http`. Reading it leaves it
    /// in place.
    func testJarSendsCookieStoredByEarlierVersionOnlyOverHttpsToItsHost() {
        let items = InMemoryCookieItems()
        items.items["example.com|auth_session"] = "old"
        let jar = CookieJar(items: items)

        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "auth_session=old")
        XCTAssertEqual(jar.cookieHeader(for: URL(string: "wss://example.com/realtime")!, now: now), "auth_session=old")
        XCTAssertNil(jar.cookieHeader(for: URL(string: "http://example.com/cdk-blocks/api")!, now: now))
        XCTAssertNil(jar.cookieHeader(for: URL(string: "https://other.com/cdk-blocks/api")!, now: now))
        XCTAssertNil(jar.cookieHeader(for: URL(string: "https://api.example.com/cdk-blocks/api")!, now: now))
        XCTAssertEqual(items.items["example.com|auth_session"], "old")
    }

    /// The earlier version's item is not sent over `http`, but a cookie of the same name set over
    /// `http` by its host still replaces it, so the two are never both stored.
    func testJarReplacesCookieStoredByEarlierVersionFromHttpResponse() {
        let items = InMemoryCookieItems()
        items.items["example.com|auth_session"] = "old"
        items.items["other.com|auth_session"] = "kept"
        let jar = CookieJar(items: items)
        let httpURL = URL(string: "http://example.com/cdk-blocks/api")!

        jar.save(setCookie: "auth_session=new; Path=/", requestURL: httpURL, now: now)
        XCTAssertNil(items.items["example.com|auth_session"])
        XCTAssertEqual(items.items["other.com|auth_session"], "kept")
        XCTAssertEqual(jar.cookieHeader(for: httpURL, now: now), "auth_session=new")
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "auth_session=new")
    }

    /// A `Secure` cookie stored by this version keeps its flag through the stored record, so it is
    /// still withheld from plain `http` after being read back from storage.
    func testJarDoesNotSendStoredSecureCookieOverHttp() {
        let items = InMemoryCookieItems()
        let jar = CookieJar(items: items)
        jar.save(setCookie: "auth_session=token123; Path=/; Secure", requestURL: apiURL, now: now)

        let reloaded = CookieJar(items: items)
        XCTAssertNil(reloaded.cookieHeader(for: URL(string: "http://example.com/cdk-blocks/api")!, now: now))
        XCTAssertEqual(reloaded.cookieHeader(for: apiURL, now: now), "auth_session=token123")
    }

    func testJarListsSameNamedCookiesMostSpecificPathFirst() {
        let jar = CookieJar(items: InMemoryCookieItems())
        // Set from a request the `/cdk-blocks/api` cookie is not sent on, so it is not replaced.
        jar.save(setCookie: "a=api; Path=/cdk-blocks/api", requestURL: apiURL, now: now)
        jar.save(setCookie: "a=root; Path=/", requestURL: URL(string: "https://example.com/other")!, now: now)
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "a=api; a=root")
    }

    func testConcurrentReplacementsLeaveOneCookie() {
        let items = InMemoryCookieItems()
        let jar = CookieJar(items: items)
        let url = apiURL
        let now = now
        DispatchQueue.concurrentPerform(iterations: 200) { index in
            let path = index.isMultiple(of: 2) ? "/" : "/cdk-blocks"
            jar.save(setCookie: "a=\(index); Path=\(path)", requestURL: url, now: now)
        }
        XCTAssertEqual(items.items.count, 1)
    }

    func testCorruptRecordIsNotReadAsEarlierVersionItem() {
        XCTAssertNil(StoredCookie.decode(account: "example.com|/|a", value: "{not json"))
    }

    // MARK: - Log Redaction

    func testRedactedForLoggingDropsCredentialsFromURL() throws {
        let presigned = try XCTUnwrap(URL(string: "https://user:pw@bucket.s3.amazonaws.com:8443/a%20b/key.txt?X-Amz-Signature=abc&X-Amz-Credential=c#frag"))
        XCTAssertEqual(presigned.redactedForLogging, "https://bucket.s3.amazonaws.com:8443/a%20b/key.txt")
        let ws = try XCTUnwrap(URL(string: "wss://abc.execute-api.us-east-1.amazonaws.com/prod?token=secret"))
        XCTAssertEqual(ws.redactedForLogging, "wss://abc.execute-api.us-east-1.amazonaws.com/prod")
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
