//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class KVStoreE2ETests: BlocksE2ETestCase {

    private var prefix: String { "kv_swift_\(Int(Date().timeIntervalSince1970))" }

    func testBasicRoundTrip() async throws {
        let key = "\(prefix)_a"
        let r = try await api.kvPut(key: key, value: "hello")
        XCTAssertTrue(r.success)
        let v = try await api.kvGet(key: key)
        XCTAssertEqual(v, "hello")
    }

    func testMissingKeyReturnsNull() async throws {
        let v = try await api.kvGet(key: "\(prefix)_nonexistent")
        XCTAssertNil(v)
    }

    func testOverwrite() async throws {
        let key = "\(prefix)_b"
        _ = try await api.kvPut(key: key, value: "first")
        _ = try await api.kvPut(key: key, value: "second")
        let v = try await api.kvGet(key: key)
        XCTAssertEqual(v, "second")
    }

    func testEmptyStringValue() async throws {
        let key = "\(prefix)_empty"
        _ = try await api.kvPut(key: key, value: "")
        let v = try await api.kvGet(key: key)
        XCTAssertEqual(v, "")
    }

    func testUnicode() async throws {
        let key = "\(prefix)_uni"
        _ = try await api.kvPut(key: key, value: "日本語 🎉 émojis")
        let v = try await api.kvGet(key: key)
        XCTAssertEqual(v, "日本語 🎉 émojis")
    }

    func testLargeValue() async throws {
        let key = "\(prefix)_large"
        let large = String(repeating: "x", count: 10_000)
        _ = try await api.kvPut(key: key, value: large)
        let v = try await api.kvGet(key: key)
        XCTAssertEqual(v, large)
    }

    func testSpecialCharactersInKey() async throws {
        let key = "\(prefix)/slashes/and spaces!@#"
        _ = try await api.kvPut(key: key, value: "ok")
        let v = try await api.kvGet(key: key)
        XCTAssertEqual(v, "ok")
    }

    func testDelete() async throws {
        let key = "\(prefix)_del"
        _ = try await api.kvPut(key: key, value: "temp")
        _ = try await api.kvDelete(key: key)
        let v = try await api.kvGet(key: key)
        XCTAssertNil(v)
    }

    func testParallelWritesAndReads() async throws {
        let p = prefix
        try await withThrowingTaskGroup(of: Void.self) { group in
            for i in 0 ..< 10 {
                group.addTask {
                    _ = try await self.api.kvPut(key: "\(p)_par_\(i)", value: "val_\(i)")
                }
            }
            try await group.waitForAll()
        }
        for i in 0 ..< 10 {
            let v = try await api.kvGet(key: "\(p)_par_\(i)")
            XCTAssertEqual(v, "val_\(i)")
        }
    }
}
