//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// A request body is the same bytes every time. Darwin's `JSONEncoder` doesn't fix the order of an object's keys
/// (a dictionary's keys come out in its hash order, which changes from process to process), so without
/// `.sortedKeys` the same call could send `{"a":1,"b":2}` once and `{"b":2,"a":1}` the next. The server doesn't
/// care, but anything that compares or hashes a body (a test, a cache, a request signature) did. The client's
/// encoder sorts keys, so the wire is deterministic.
final class DeterministicEncodingTests: XCTestCase {

    private struct Profile: Encodable {
        let zone: String
        let name: String
        let age: Int
        let tags: [String: Int]
    }

    /// Enough keys that an unsorted encoding comes out in sorted order only by a very unlikely accident.
    private let tags = ["kilo": 11, "alpha": 1, "juliet": 10, "bravo": 2, "india": 9, "charlie": 3, "hotel": 8,
                        "delta": 4, "golf": 7, "echo": 5, "foxtrot": 6]
    private let sortedTags = #"{"alpha":1,"bravo":2,"charlie":3,"delta":4,"echo":5,"foxtrot":6,"golf":7,"hotel":8,"#
        + #""india":9,"juliet":10,"kilo":11}"#

    private var client: BlocksClient { BlocksClient(url: "http://localhost:3001/aws-blocks/api") }

    private func string(_ data: Data) -> String { String(bytes: data, encoding: .utf8) ?? "" }

    func testClientEncoderSortsKeys() throws {
        let encoder = client.makeEncoder()
        XCTAssertTrue(encoder.outputFormatting.contains(.sortedKeys))
        XCTAssertEqual(string(try encoder.encode(tags)), sortedTags)
        XCTAssertEqual(
            string(try encoder.encode(Profile(zone: "z", name: "n", age: 3, tags: tags))),
            #"{"age":3,"name":"n","tags":\#(sortedTags),"zone":"z"}"#
        )
    }

    func testRequestEncodesWithSortedKeysAtEveryDepth() throws {
        let request = BlocksRequest(method: "api.save", params: [Profile(zone: "z", name: "n", age: 3, tags: tags), tags], id: 4)
        XCTAssertEqual(
            string(try client.makeEncoder().encode(request)),
            #"{"id":4,"jsonrpc":"2.0","method":"api.save","params":[{"age":3,"name":"n","tags":\#(sortedTags),"zone":"z"},"#
                + #"\#(sortedTags)]}"#
        )
    }

    /// What `execute` puts on the wire, byte for byte.
    func testExecuteSendsTheSameBytesEveryTime() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        var bodies: [String] = []
        MockURLProtocol.handler = { request in
            bodies.append(Self.body(of: request) ?? "")
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"jsonrpc":"2.0","result":null,"id":1}"#.utf8))
        }
        defer { MockURLProtocol.handler = nil }
        let client = BlocksClient(url: "http://localhost:3001/aws-blocks/api", session: URLSession(configuration: config))
        for _ in 0 ..< 3 {
            // A fresh dictionary each time: its storage, and so its unsorted key order, can differ.
            // Named apart from the `tags` property so it doesn't shadow it inside its own initializer.
            let fresh = Dictionary(uniqueKeysWithValues: tags.map { ($0.key, $0.value) })
            _ = try await client.execute(BlocksRequest(method: "api.save", params: [fresh], id: 1))
        }
        XCTAssertEqual(bodies, Array(repeating: #"{"id":1,"jsonrpc":"2.0","method":"api.save","params":[\#(sortedTags)]}"#, count: 3))
    }

    /// A raw route (the OIDC exchange and sign-out) sends a `[String: Any]` body, sorted the same way.
    func testRawRouteSendsSortedKeys() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        var sent: String?
        MockURLProtocol.handler = { request in
            sent = Self.body(of: request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data("{}".utf8))
        }
        defer { MockURLProtocol.handler = nil }
        let client = BlocksClient(url: "http://localhost:3001/aws-blocks/api", session: URLSession(configuration: config))
        _ = try await client.postRawRoute(path: "/auth/exchange", body: tags)
        XCTAssertEqual(sent, sortedTags)
    }

    private static func body(of request: URLRequest) -> String? {
        if let body = request.httpBody { return String(bytes: body, encoding: .utf8) }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return String(bytes: data, encoding: .utf8)
    }
}
