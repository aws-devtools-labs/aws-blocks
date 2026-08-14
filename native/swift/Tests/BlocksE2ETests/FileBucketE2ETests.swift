//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class FileBucketE2ETests: BlocksE2ETestCase {

    private var prefix: String { "swift_e2e_\(Int(Date().timeIntervalSince1970))" }

    func testServerSidePutAndGet() async throws {
        let path = "\(prefix)/hello.txt"
        _ = try await api.filePut(path: path, content: "hello from swift", contentType: "text/plain")

        let file = try await api.fileGet(path: path)
        XCTAssertEqual(file?.body, "hello from swift")
        XCTAssertEqual(file?.contentType, "text/plain")
    }

    func testGetMissingFile() async throws {
        let file = try await api.fileGet(path: "\(prefix)/nonexistent.txt")
        XCTAssertNil(file)
    }

    func testDelete() async throws {
        let path = "\(prefix)/delete.txt"
        _ = try await api.filePut(path: path, content: "temp", contentType: nil)
        _ = try await api.fileDelete(path: path)

        let file = try await api.fileGet(path: path)
        XCTAssertNil(file)
    }

    func testScanWithPrefix() async throws {
        let pathPrefix = prefix
        _ = try await api.filePut(path: "\(pathPrefix)/scan/a.txt", content: "a", contentType: nil)
        _ = try await api.filePut(path: "\(pathPrefix)/scan/b.txt", content: "b", contentType: nil)

        let scanned = try await api.fileScan(prefix: "\(pathPrefix)/scan/")
        XCTAssertGreaterThanOrEqual(scanned.count, 2)
    }

    func testCreateUploadHandle() async throws {
        let handle = try await api.fileCreateUploadHandle(path: "\(prefix)/upload.bin", contentType: nil)
        XCTAssertNotNil(handle)
    }
}
