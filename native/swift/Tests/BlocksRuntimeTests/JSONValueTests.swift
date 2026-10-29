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

    /// The shape codegen emits for `AuthenticatedUser.claims` (`Record<string, unknown>`, optional
    /// and nullable): every JSON kind survives a decode/encode, and absent or null claims are nil.
    private struct UserWithClaims: Codable {
        let userId: String
        let claims: [String: JSONValue]?
    }

    func testOptionalMapOfJSONValueRoundTrips() throws {
        let wire = Data(#"""
        {
            "claims": {
                "address": { "country": "NZ", "postal_code": null },
                "amr": ["pwd", "mfa"],
                "email_verified": true,
                "exp": 1767225600,
                "iss": "https://idp.example.com",
                "nickname": null,
                "ratio": 0.5
            },
            "userId": "u1"
        }
        """#.utf8)
        let decoded = try JSONDecoder().decode(UserWithClaims.self, from: wire)
        let claims = try XCTUnwrap(decoded.claims)
        XCTAssertEqual(claims.count, 7)
        if case .int(let exp) = claims["exp"] { XCTAssertEqual(exp, 1_767_225_600) } else { XCTFail("exp") }
        if case .string(let iss) = claims["iss"] { XCTAssertEqual(iss, "https://idp.example.com") } else { XCTFail("iss") }

        // Re-encoding gives back the same JSON (compared as parsed objects, so key order and spacing don't matter).
        let reencoded = try JSONEncoder().encode(decoded)
        let expected = try XCTUnwrap(JSONSerialization.jsonObject(with: wire) as? NSDictionary)
        let actual = try XCTUnwrap(JSONSerialization.jsonObject(with: reencoded) as? NSDictionary)
        XCTAssertEqual(actual, expected)

        let absent = try JSONDecoder().decode(UserWithClaims.self, from: Data(#"{"userId":"u1"}"#.utf8))
        XCTAssertNil(absent.claims)
        let explicitNull = try JSONDecoder().decode(UserWithClaims.self, from: Data(#"{"userId":"u1","claims":null}"#.utf8))
        XCTAssertNil(explicitNull.claims)
    }
}
