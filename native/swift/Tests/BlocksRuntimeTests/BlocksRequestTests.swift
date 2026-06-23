//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class BlocksRequestTests: XCTestCase {

    func testNextIdIncrementsMonotonically() {
        let id1 = BlocksRequest.nextId()
        let id2 = BlocksRequest.nextId()
        let id3 = BlocksRequest.nextId()
        XCTAssertEqual(id2, id1 + 1)
        XCTAssertEqual(id3, id2 + 1)
    }

    func testEncodesAsJSONRPC() throws {
        let request = BlocksRequest(method: "api.greet", params: ["hello" as any Encodable], id: 1)
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])

        XCTAssertEqual(json["jsonrpc"] as? String, "2.0")
        XCTAssertEqual(json["method"] as? String, "api.greet")
        XCTAssertEqual(json["id"] as? Int, 1)
        XCTAssertNotNil(json["params"])
    }

    func testEncodesParamsAsArray() throws {
        let request = BlocksRequest(method: "api.create", params: ["title" as any Encodable, 42 as any Encodable], id: 1)
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let params = json["params"] as? [Any]

        XCTAssertNotNil(params)
        XCTAssertEqual(params?.count, 2)
        XCTAssertEqual(params?[0] as? String, "title")
        XCTAssertEqual(params?[1] as? Int, 42)
    }

    func testEncodesEmptyParams() throws {
        let request = BlocksRequest(method: "api.get", params: [], id: 1)
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let params = json["params"] as? [Any]

        XCTAssertNotNil(params)
        XCTAssertEqual(params?.count, 0)
    }

    func testEncodesNilParam() throws {
        let optionalValue: String? = nil
        let request = BlocksRequest(method: "api.list", params: [optionalValue as any Encodable], id: 1)
        let data = try JSONEncoder().encode(request)
        let json = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let params = json["params"] as? [Any]

        XCTAssertNotNil(params)
        XCTAssertEqual(params?.count, 1)
    }
}
