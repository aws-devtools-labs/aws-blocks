//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class BlocksErrorTests: XCTestCase {

    func testApiErrorCarriesStatusNameAndRetriable() {
        let error = ApiError(
            message: "Username already taken",
            status: 409,
            name: "ConditionalCheckFailedException",
            retriable: true
        )
        XCTAssertEqual(error.message, "Username already taken")
        XCTAssertEqual(error.status, 409)
        XCTAssertEqual(error.name, "ConditionalCheckFailedException")
        XCTAssertTrue(error.retriable)
    }

    func testApiErrorNameAndRetriableDefaultToAbsent() {
        let error = ApiError(message: "Internal error", status: 500)
        XCTAssertNil(error.name)
        XCTAssertFalse(error.retriable)
    }

    func testIsBlocksErrorMatchesOnTheNameOnly() {
        let error: Error = ApiError(message: "nope", status: 409, name: "ConditionalCheckFailedException")
        XCTAssertTrue(error.isBlocksError(name: "ConditionalCheckFailedException"))
        XCTAssertFalse(error.isBlocksError(name: "SomeOtherException"))
        XCTAssertFalse(ClientClosedError().isBlocksError(name: "ConditionalCheckFailedException"))
        XCTAssertFalse(ApiError(message: "nameless", status: 500).isBlocksError(name: "ConditionalCheckFailedException"))
    }

    func testTransportErrorHasNoStatusWhenNoResponseArrived() {
        let error = TransportError(message: "Connection refused")
        XCTAssertNil(error.statusCode)
        XCTAssertNil(error.underlyingError)
    }

    func testReservedRpcErrorNameCoversTheFiveReservedCodes() {
        XCTAssertEqual(reservedRpcErrorName(-32_700), "ParseError")
        XCTAssertEqual(reservedRpcErrorName(-32_600), "InvalidRequest")
        XCTAssertEqual(reservedRpcErrorName(-32_601), "MethodNotFound")
        XCTAssertEqual(reservedRpcErrorName(-32_602), "InvalidParams")
        XCTAssertEqual(reservedRpcErrorName(-32_603), "InternalError")
        XCTAssertNil(reservedRpcErrorName(409))
        XCTAssertNil(reservedRpcErrorName(-1))
    }
}
