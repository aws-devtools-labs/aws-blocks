//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class BlocksArrayParamsTests: XCTestCase {

    func testEncodesStringArray() throws {
        let params = BlocksArrayParams(["hello", "world"])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr.count, 2)
        XCTAssertEqual(arr[0] as? String, "hello")
        XCTAssertEqual(arr[1] as? String, "world")
    }

    func testEncodesIntArray() throws {
        let params = BlocksArrayParams([1, 2, 3])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr.count, 3)
        XCTAssertEqual(arr[0] as? Int, 1)
        XCTAssertEqual(arr[2] as? Int, 3)
    }

    func testEncodesMixedTypes() throws {
        let params = BlocksArrayParams(["title" as any Encodable, 42 as any Encodable, true as any Encodable])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr.count, 3)
        XCTAssertEqual(arr[0] as? String, "title")
        XCTAssertEqual(arr[1] as? Int, 42)
        XCTAssertEqual(arr[2] as? Bool, true)
    }

    func testEncodesEmptyArray() throws {
        let params = BlocksArrayParams([])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr.count, 0)
    }

    func testEncodesNilAsNull() throws {
        let nilValue: String? = nil
        let params = BlocksArrayParams([nilValue as any Encodable])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr.count, 1)
        XCTAssertTrue(arr[0] is NSNull)
    }

    func testEncodesCodableStruct() throws {
        // swiftlint:disable identifier_name
        struct Point: Encodable { let x: Int; let y: Int }
        // swiftlint:enable identifier_name

        let params = BlocksArrayParams([Point(x: 10, y: 20)])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr.count, 1)
        let obj = arr[0] as? [String: Any]
        XCTAssertEqual(obj?["x"] as? Int, 10)
        XCTAssertEqual(obj?["y"] as? Int, 20)
    }

    func testEncodesDoubleValues() throws {
        let params = BlocksArrayParams([3.14, 2.718])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr.count, 2)
        XCTAssertEqual(try XCTUnwrap(arr[0] as? Double), 3.14, accuracy: 0.001)
        XCTAssertEqual(try XCTUnwrap(arr[1] as? Double), 2.718, accuracy: 0.001)
    }

    func testPreservesOrder() throws {
        let params = BlocksArrayParams(["first", "second", "third"])
        let data = try JSONEncoder().encode(params)
        let arr = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [Any])

        XCTAssertEqual(arr[0] as? String, "first")
        XCTAssertEqual(arr[1] as? String, "second")
        XCTAssertEqual(arr[2] as? String, "third")
    }
}
