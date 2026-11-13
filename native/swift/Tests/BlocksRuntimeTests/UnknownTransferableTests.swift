//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class UnknownTransferableTests: XCTestCase {

    func testFromJSONAcceptsMatchingTag() throws {
        let json: [String: Any] = ["__blocks": "example-iot/device-link", "endpoint": "wss://iot.example"]
        let unknown = try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link")
        XCTAssertEqual(unknown.tag, "example-iot/device-link")
        guard case .string(let blocks) = unknown.descriptor["__blocks"],
              case .string(let endpoint) = unknown.descriptor["endpoint"] else {
            return XCTFail("descriptor did not preserve its string values: \(unknown.descriptor)")
        }
        XCTAssertEqual(blocks, "example-iot/device-link")
        XCTAssertEqual(endpoint, "wss://iot.example")
    }

    func testFromJSONThrowsOnWrongTag() {
        let json: [String: Any] = ["__blocks": "example-iot/other"]
        XCTAssertThrowsError(try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link")) { error in
            XCTAssertTrue(error is DecodingError, "Expected DecodingError, got \(error)")
        }
    }

    func testFromJSONThrowsOnMissingBlocksTag() {
        let json: [String: Any] = ["endpoint": "wss://iot.example"]
        XCTAssertThrowsError(try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link")) { error in
            XCTAssertTrue(error is DecodingError, "Expected DecodingError, got \(error)")
        }
    }

    func testFromJSONThrowsOnEmptyBlocksTag() {
        // expectedTag is empty too, so the equality check would accept this tag; the non-empty
        // guard is therefore the only one that can reject it, isolating the guard this test names.
        let json: [String: Any] = ["__blocks": ""]
        XCTAssertThrowsError(try UnknownTransferable.fromJSON(json, expectedTag: "")) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected DecodingError, got \(error)")
            }
            XCTAssertTrue(context.debugDescription.contains("non-empty"), "expected the non-empty guard, got: \(context.debugDescription)")
        }
    }

    func testFromJSONThrowsOnNonStringBlocksTag() {
        let json: [String: Any] = ["__blocks": 42]
        XCTAssertThrowsError(try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link")) { error in
            XCTAssertTrue(error is DecodingError, "Expected DecodingError, got \(error)")
        }
    }

    func testFromJSONThrowsOnNonJSONRepresentableDescriptor() {
        let json: [String: Any] = ["__blocks": "example-iot/device-link", "when": Date()]
        XCTAssertThrowsError(try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link")) { error in
            XCTAssertTrue(error is DecodingError, "Expected DecodingError, got \(error)")
        }
    }

    func testFromJSONPreservesNonStringDescriptorValues() throws {
        // The descriptor must preserve every JSON type, including a float with an
        // integer value (`1.0`), which a Codable re-decode would collapse to an int.
        let json: [String: Any] = [
            "__blocks": "example-iot/device-link",
            "count": 3,
            "whole": 1.0,
            "big": NSNumber(value: UInt64(Int64.max) + 1),
            "active": true,
            "meta": NSNull(),
            "nested": ["k": "v"],
            "list": ["a", "b"]
        ]
        let unknown = try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link")
        guard case .int(let count) = unknown.descriptor["count"] else {
            return XCTFail("count did not round-trip as .int: \(String(describing: unknown.descriptor["count"]))")
        }
        XCTAssertEqual(count, 3)
        guard case .double(let whole) = unknown.descriptor["whole"] else {
            return XCTFail("whole did not round-trip as .double: \(String(describing: unknown.descriptor["whole"]))")
        }
        XCTAssertEqual(whole, 1.0)
        guard case .double = unknown.descriptor["big"] else {
            return XCTFail("big did not round-trip as .double: \(String(describing: unknown.descriptor["big"]))")
        }
        guard case .bool(let active) = unknown.descriptor["active"] else {
            return XCTFail("active did not round-trip as .bool: \(String(describing: unknown.descriptor["active"]))")
        }
        XCTAssertTrue(active)
        guard case .null = unknown.descriptor["meta"] else {
            return XCTFail("meta did not round-trip as .null: \(String(describing: unknown.descriptor["meta"]))")
        }
        guard case .dictionary(let nested) = unknown.descriptor["nested"],
              case .string(let value) = nested["k"] else {
            return XCTFail("nested did not round-trip: \(String(describing: unknown.descriptor["nested"]))")
        }
        XCTAssertEqual(value, "v")
        guard case .array(let list) = unknown.descriptor["list"], case .string(let first) = list.first else {
            return XCTFail("list did not round-trip as .array: \(String(describing: unknown.descriptor["list"]))")
        }
        XCTAssertEqual(list.count, 2)
        XCTAssertEqual(first, "a")
    }

    func testCarrierIsEquatableAndCodable() throws {
        let json: [String: Any] = ["__blocks": "example-iot/device-link", "endpoint": "wss://iot.example"]
        let carrier = try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link")
        XCTAssertEqual(carrier, try UnknownTransferable.fromJSON(json, expectedTag: "example-iot/device-link"))
        let roundTripped = try JSONDecoder().decode(UnknownTransferable.self, from: JSONEncoder().encode(carrier))
        XCTAssertEqual(roundTripped, carrier)
    }

    func testCodableRoundTripCollapsesWholeValuedDouble() throws {
        // Pins the documented caveat: a Codable round-trip may decode a whole-valued
        // double back as an integer (fromJSON-level preservation is covered separately).
        let carrier = try UnknownTransferable.fromJSON(["__blocks": "example-iot/device-link", "whole": 1.0], expectedTag: "example-iot/device-link")
        let roundTripped = try JSONDecoder().decode(UnknownTransferable.self, from: JSONEncoder().encode(carrier))
        guard case .int = roundTripped.descriptor["whole"] else {
            return XCTFail("Codable round-trip is expected to collapse 1.0 to .int, got: \(String(describing: roundTripped.descriptor["whole"]))")
        }
    }

    func testDecodableRejectsDescriptorWithoutValidBlocksTag() {
        // Decodable must enforce the same `__blocks` invariant as fromJSON, so a
        // raw decode cannot build a carrier the factory would reject.
        for badDescriptor in ["{\"descriptor\":{\"url\":\"x\"}}", "{\"descriptor\":{\"__blocks\":\"\"}}", "{\"descriptor\":{\"__blocks\":42}}"] {
            XCTAssertThrowsError(try JSONDecoder().decode(UnknownTransferable.self, from: Data(badDescriptor.utf8))) { error in
                XCTAssertTrue(error is DecodingError, "expected DecodingError for \(badDescriptor), got \(error)")
            }
        }
    }
}
