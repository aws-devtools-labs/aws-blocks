//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class JSONValueTests: XCTestCase {

    func testDecodesString() throws {
        let data = Data("\"hello\"".utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if case .string(let str) = value {
            XCTAssertEqual(str, "hello")
        } else {
            XCTFail("Expected string")
        }
    }

    func testDecodesInt() throws {
        let data = Data("42".utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if case .int(let num) = value {
            XCTAssertEqual(num, 42)
        } else {
            XCTFail("Expected int")
        }
    }

    func testDecodesDouble() throws {
        let data = Data("3.14".utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if case .double(let num) = value {
            XCTAssertEqual(num, 3.14, accuracy: 0.001)
        } else {
            XCTFail("Expected double")
        }
    }

    func testDecodesBool() throws {
        let data = Data("true".utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if case .bool(let flag) = value {
            XCTAssertTrue(flag)
        } else {
            XCTFail("Expected bool")
        }
    }

    func testDecodesNull() throws {
        let data = Data("null".utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if case .null = value {
            // correct
        } else {
            XCTFail("Expected null")
        }
    }

    func testDecodesArray() throws {
        let data = Data("[1, \"two\", true]".utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if case .array(let arr) = value {
            XCTAssertEqual(arr.count, 3)
        } else {
            XCTFail("Expected array")
        }
    }

    func testDecodesDictionary() throws {
        let data = Data("{\"key\": \"value\"}".utf8)
        let value = try JSONDecoder().decode(JSONValue.self, from: data)
        if case .dictionary(let dict) = value {
            XCTAssertEqual(dict.count, 1)
            if case .string(let val) = dict["key"] {
                XCTAssertEqual(val, "value")
            } else {
                XCTFail("Expected string value")
            }
        } else {
            XCTFail("Expected dictionary")
        }
    }

    func testEncodesString() throws {
        let value = JSONValue.string("hello")
        let data = try JSONEncoder().encode(value)
        let str = String(data: data, encoding: .utf8)
        XCTAssertEqual(str, "\"hello\"")
    }

    func testEncodesNull() throws {
        let value = JSONValue.null
        let data = try JSONEncoder().encode(value)
        let str = String(data: data, encoding: .utf8)
        XCTAssertEqual(str, "null")
    }

    func testRoundTrip() throws {
        let original = JSONValue.dictionary([
            "name": .string("test"),
            "count": .int(5),
            "active": .bool(true),
            "tags": .array([.string("a"), .string("b")]),
            "meta": .null
        ])
        // `JSONEncoder` does not guarantee key ordering on dictionaries, so
        // byte-equality comparison of two encoded outputs is non-deterministic
        // without `.sortedKeys`. Pin both encoders to the same sorted output
        // so this test asserts logical round-trip equivalence rather than
        // accidentally testing dict iteration order.
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]

        let data = try encoder.encode(original)
        let decoded = try JSONDecoder().decode(JSONValue.self, from: data)

        // Re-encode both and compare
        let originalData = try encoder.encode(original)
        let decodedData = try encoder.encode(decoded)
        XCTAssertEqual(originalData, decodedData)
    }
}
