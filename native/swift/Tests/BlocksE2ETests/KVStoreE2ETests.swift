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
        let result = try await api.kvPut(key: key, value: "hello")
        XCTAssertTrue(result.success)
        let value = try await api.kvGet(key: key)
        XCTAssertEqual(value, "hello")
    }

    func testMissingKeyReturnsNull() async throws {
        let value = try await api.kvGet(key: "\(prefix)_nonexistent")
        XCTAssertNil(value)
    }

    func testOverwrite() async throws {
        let key = "\(prefix)_b"
        _ = try await api.kvPut(key: key, value: "first")
        _ = try await api.kvPut(key: key, value: "second")
        let value = try await api.kvGet(key: key)
        XCTAssertEqual(value, "second")
    }

    func testEmptyStringValue() async throws {
        let key = "\(prefix)_empty"
        _ = try await api.kvPut(key: key, value: "")
        let value = try await api.kvGet(key: key)
        XCTAssertEqual(value, "")
    }

    func testUnicode() async throws {
        let key = "\(prefix)_uni"
        _ = try await api.kvPut(key: key, value: "日本語 🎉 émojis")
        let value = try await api.kvGet(key: key)
        XCTAssertEqual(value, "日本語 🎉 émojis")
    }

    func testLargeValue() async throws {
        let key = "\(prefix)_large"
        let large = String(repeating: "x", count: 10_000)
        _ = try await api.kvPut(key: key, value: large)
        let value = try await api.kvGet(key: key)
        XCTAssertEqual(value, large)
    }

    func testSpecialCharactersInKey() async throws {
        let key = "\(prefix)/slashes/and spaces!@#"
        _ = try await api.kvPut(key: key, value: "ok")
        let value = try await api.kvGet(key: key)
        XCTAssertEqual(value, "ok")
    }

    func testDelete() async throws {
        let key = "\(prefix)_del"
        _ = try await api.kvPut(key: key, value: "temp")
        _ = try await api.kvDelete(key: key)
        let value = try await api.kvGet(key: key)
        XCTAssertNil(value)
    }

    func testParallelWritesAndReads() async throws {
        let keyPrefix = prefix
        try await withThrowingTaskGroup(of: Void.self) { group in
            for idx in 0 ..< 10 {
                group.addTask {
                    _ = try await self.api.kvPut(key: "\(keyPrefix)_par_\(idx)", value: "val_\(idx)")
                }
            }
            try await group.waitForAll()
        }
        for idx in 0 ..< 10 {
            let value = try await api.kvGet(key: "\(keyPrefix)_par_\(idx)")
            XCTAssertEqual(value, "val_\(idx)")
        }
    }
}
