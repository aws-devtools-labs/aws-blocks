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

    // The Keychain is not reliably writable from `swift test`, so the attribute rules that decide
    // whether a stored cookie is attached are tested on `StoredCookie` and on a `CookieJar` over
    // in-memory items.

    private let apiURL = URL(string: "https://example.com/aws-blocks/api")!
    private let now = Date(timeIntervalSince1970: 1_900_000_000)

    private func cookie(_ setCookie: String, from url: URL? = nil) throws -> StoredCookie {
        try XCTUnwrap(StoredCookie(setCookie: setCookie, requestURL: url ?? apiURL, now: now))
    }

    func testSecureCookieIsAttachedOverHttpsButNotHttp() throws {
        let stored = try cookie("auth_session=token123; Path=/; Secure")
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/aws-blocks/api")!))
        XCTAssertFalse(stored.matches(URL(string: "http://example.com/aws-blocks/api")!))
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
        XCTAssertEqual(stored.path, "/aws-blocks")
        XCTAssertTrue(stored.matches(URL(string: "https://example.com/aws-blocks/other")!))
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

    func testValueStoredByEarlierVersionIsReadWithoutAttributes() throws {
        let legacy = try XCTUnwrap(StoredCookie.decode(account: "example.com|auth_session", value: "token123"))
        XCTAssertEqual(legacy.host, "example.com")
        XCTAssertEqual(legacy.name, "auth_session")
        XCTAssertEqual(legacy.value, "token123")
        XCTAssertEqual(legacy.path, "/")
        XCTAssertFalse(legacy.secure)
        XCTAssertNil(legacy.expiresAt)
        XCTAssertTrue(legacy.matches(URL(string: "http://example.com/aws-blocks/api")!))
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
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "auth_session=old")

        // Set without a `Path`, so it is stored for `/aws-blocks`, and still replaces the old item.
        jar.save(setCookie: "auth_session=new", requestURL: apiURL, now: now)
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "auth_session=new")
        XCTAssertNil(items.items["example.com|auth_session"])

        jar.save(setCookie: "auth_session=; Max-Age=0; Path=/", requestURL: apiURL, now: now)
        XCTAssertNil(jar.cookieHeader(for: apiURL, now: now))
    }

    func testJarListsSameNamedCookiesMostSpecificPathFirst() {
        let jar = CookieJar(items: InMemoryCookieItems())
        // Set from a request the `/aws-blocks/api` cookie is not sent on, so it is not replaced.
        jar.save(setCookie: "a=api; Path=/aws-blocks/api", requestURL: apiURL, now: now)
        jar.save(setCookie: "a=root; Path=/", requestURL: URL(string: "https://example.com/other")!, now: now)
        XCTAssertEqual(jar.cookieHeader(for: apiURL, now: now), "a=api; a=root")
    }

    func testConcurrentReplacementsLeaveOneCookie() {
        let items = InMemoryCookieItems()
        let jar = CookieJar(items: items)
        let url = apiURL
        let now = now
        DispatchQueue.concurrentPerform(iterations: 200) { index in
            let path = index.isMultiple(of: 2) ? "/" : "/aws-blocks"
            jar.save(setCookie: "a=\(index); Path=\(path)", requestURL: url, now: now)
        }
        XCTAssertEqual(items.items.count, 1)
    }

    func testCorruptRecordIsNotReadAsEarlierVersionItem() {
        XCTAssertNil(StoredCookie.decode(account: "example.com|/|a", value: "{not json"))
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
