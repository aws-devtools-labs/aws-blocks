//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// Tuples on the wire, against the real server, which calls a method with its params spread (`method(...params)`).
///
/// A rest parameter typed as a tuple (`...args: [label: string, count?: number]`, or
/// `...args: Parameters<typeof describeKey>`) takes one positional param per element. The spec used to describe it
/// as one param holding the tuple, so the client sent `[["x", 2]]` and the method's `args` was `[["x", 2]]`. A tuple
/// is a JSON array (`["abc", 3]`), never an object keyed `item0`, `item1`.
final class RestTupleParamsE2ETests: BlocksE2ETestCase {

    func testRestTupleElementsArePositionalParams() async throws {
        let both = try await api.echoRestArgs(label: "x", count: 2)
        XCTAssertEqual(both.argCount, 2)
        XCTAssertEqual(both.label, "x")
        XCTAssertEqual(both.count, 2)
        let labelOnly = try await api.echoRestArgs(label: "y")
        XCTAssertEqual(labelOnly.argCount, 1)
        XCTAssertNil(labelOnly.count)
    }

    func testParametersOfAFunctionArePositionalParams() async throws {
        let forwarded = try await api.echoForwardedArgs(key: "k", options: .init(tag: "t"))
        XCTAssertEqual(forwarded.argCount, 2)
        XCTAssertEqual(forwarded.key, "k")
        XCTAssertEqual(forwarded.tag, "t")
    }

    func testTuplesAreJSONArrays() async throws {
        let tuples = try await api.echoTuples(one: ["abc"])
        XCTAssertEqual(tuples.one, [3])
        XCTAssertEqual(tuples.short.item0, "abc")
        XCTAssertNil(tuples.short.item1)
        XCTAssertEqual(tuples.pair.item0, "abc")
        XCTAssertEqual(tuples.pair.item1, 3)
    }
}
