//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class TransferableDescriptorTests: XCTestCase {

    func testReturnsDescriptorUnchangedForMatchingTag() throws {
        let descriptor: [String: Any] = ["__blocks": "example-iot/device-link", "endpoint": "wss://iot.example"]
        let validated = try validateTransferableDescriptor(descriptor, expectedTag: "example-iot/device-link")
        XCTAssertEqual(validated["__blocks"] as? String, "example-iot/device-link")
        XCTAssertEqual(validated["endpoint"] as? String, "wss://iot.example")
        XCTAssertEqual(validated.count, descriptor.count)
    }

    func testThrowsOnMissingTag() {
        XCTAssertThrowsError(try validateTransferableDescriptor(["endpoint": "wss://iot.example"], expectedTag: "example-iot/device-link")) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected DecodingError.dataCorrupted, got \(error)")
            }
            XCTAssertTrue(context.debugDescription.contains("string '__blocks' tag"), "got: \(context.debugDescription)")
        }
    }

    func testThrowsOnNonStringTag() {
        XCTAssertThrowsError(try validateTransferableDescriptor(["__blocks": 7], expectedTag: "example-iot/device-link")) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected DecodingError.dataCorrupted, got \(error)")
            }
            XCTAssertTrue(
                context.debugDescription.contains("string '__blocks' tag"),
                "a non-string tag must fail the type guard, not the mismatch check, got: \(context.debugDescription)"
            )
        }
    }

    func testThrowsOnEmptyTagEvenWhenExpectedTagIsEmpty() {
        XCTAssertThrowsError(try validateTransferableDescriptor(["__blocks": ""], expectedTag: "")) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected DecodingError.dataCorrupted, got \(error)")
            }
            XCTAssertTrue(context.debugDescription.contains("non-empty"), "got: \(context.debugDescription)")
        }
    }

    func testThrowsOnMismatchedTag() {
        XCTAssertThrowsError(try validateTransferableDescriptor(["__blocks": "example-iot/other"], expectedTag: "example-iot/device-link")) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected DecodingError.dataCorrupted, got \(error)")
            }
            XCTAssertTrue(context.debugDescription.contains("example-iot/other"), "got: \(context.debugDescription)")
        }
    }

    func testTagComparisonIsCaseSensitive() {
        XCTAssertThrowsError(try validateTransferableDescriptor(["__blocks": "Example-IoT/Device-Link"], expectedTag: "example-iot/device-link")) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected DecodingError.dataCorrupted, got \(error)")
            }
            XCTAssertTrue(
                context.debugDescription.contains("Example-IoT/Device-Link"),
                "a case difference must fail the equality check and name the received tag, got: \(context.debugDescription)"
            )
        }
    }

    func testSubjectDefaultsToTransferableAndIsOverridable() throws {
        let tag = "example-iot/device-link"
        let cases: [([String: Any], String)] = [
            ([:], "Transferable for '\(tag)' expected a string '__blocks' tag"),
            (["__blocks": 1], "Transferable for '\(tag)' expected a string '__blocks' tag"),
            (["__blocks": ""], "Transferable for '\(tag)' expected a non-empty '__blocks' tag"),
            (["__blocks": "other/tag"], "Transferable expected tag '\(tag)', got 'other/tag'")
        ]
        for (descriptor, expected) in cases {
            XCTAssertEqual(dataCorruptedDescription { _ = try validateTransferableDescriptor(descriptor, expectedTag: tag) }, expected)
        }
        XCTAssertEqual(
            dataCorruptedDescription {
                _ = try validateTransferableDescriptor([:], expectedTag: tag, subject: "UnknownTransferable")
            },
            "UnknownTransferable for '\(tag)' expected a string '__blocks' tag"
        )
    }

    func testUnknownTransferableKeepsItsOwnSubjectInEveryMessage() throws {
        let tag = "example-iot/device-link"
        let expected = [
            "UnknownTransferable for '\(tag)' expected a string '__blocks' tag",
            "UnknownTransferable for '\(tag)' expected a non-empty '__blocks' tag",
            "UnknownTransferable expected tag '\(tag)', got 'other/tag'"
        ]
        let descriptors: [[String: Any]] = [[:], ["__blocks": ""], ["__blocks": "other/tag"]]
        for (descriptor, message) in zip(descriptors, expected) {
            XCTAssertEqual(
                dataCorruptedDescription { _ = try UnknownTransferable.fromJSON(descriptor, expectedTag: tag) },
                message
            )
        }
    }

    private func dataCorruptedDescription(_ body: () throws -> Void) -> String {
        do {
            try body()
            return "<no error>"
        } catch let error as DecodingError {
            guard case .dataCorrupted(let context) = error else { return "\(error)" }
            return context.debugDescription
        } catch {
            return "\(error)"
        }
    }
}
