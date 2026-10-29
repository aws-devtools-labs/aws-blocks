//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// The JSON-RPC wire contract the generated client relies on, against the real server (`parseRpcRequest` in
/// `packages/core`).
///
/// Params are positional: the server calls the method with `params` as its argument list. A generated call that
/// leaves out an optional argument before a set one sends `null` in its slot, as the TypeScript client does, so
/// `echoArgs(first: "a", middle: nil, last: "c")` reaches the server as `echoArgs("a", null, "c")`. The base
/// generator appended only the optional arguments that were set and sent `["a","c"]`, which the server read as
/// `middle = "c"` (FX46).
///
/// An optional parameter defaults to `nil` even when its schema is nullable (the spec generator writes every
/// TypeScript `x?: T` as `oneOf [T, null]`), so a call can leave `middle` out: `echoArgs(first: "a", last: "c")`
/// (FX50). Passing `nil` still compiles.
final class RpcWireE2ETests: BlocksE2ETestCase {

    func testLeftOutMiddleOptionalKeepsTheLaterArgumentInItsSlot() async throws {
        let echoed = try await api.echoArgs(first: "a", last: "c")
        XCTAssertEqual(echoed.first, "a")
        XCTAssertNil(echoed.middle)
        XCTAssertEqual(echoed.last, "c")
    }

    func testExplicitNilMiddleStillKeepsTheLaterArgumentInItsSlot() async throws {
        let echoed = try await api.echoArgs(first: "a", middle: nil, last: "c")
        XCTAssertNil(echoed.middle)
        XCTAssertEqual(echoed.last, "c")
    }

    func testEveryArgumentSetArrivesInOrder() async throws {
        let echoed = try await api.echoArgs(first: "a", middle: "b", last: "c")
        XCTAssertEqual(echoed.first, "a")
        XCTAssertEqual(echoed.middle, "b")
        XCTAssertEqual(echoed.last, "c")
    }

    func testTrailingUnsetArgumentsAreLeftOff() async throws {
        let onlyFirst = try await api.echoArgs(first: "a")
        XCTAssertNil(onlyFirst.middle)
        XCTAssertNil(onlyFirst.last)
        let firstTwo = try await api.echoArgs(first: "a", middle: "b")
        XCTAssertEqual(firstTwo.middle, "b")
        XCTAssertNil(firstTwo.last)
    }
}
