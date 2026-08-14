//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class FileDownloadHandleTests: XCTestCase {

    func testFromJSONParsesURL() throws {
        let json: [String: Any] = ["url": "https://s3.amazonaws.com/bucket/file.txt"]
        let handle = try FileDownloadHandle.fromJSON(json)
        XCTAssertEqual(handle.getUrl(), "https://s3.amazonaws.com/bucket/file.txt")
    }

    func testFromJSONThrowsOnMissingURL() {
        let json: [String: Any] = ["notUrl": "something"]
        XCTAssertThrowsError(try FileDownloadHandle.fromJSON(json)) { error in
            if let bucketError = error as? FileBucketError {
                if case .invalidURL = bucketError {
                    // correct
                } else {
                    XCTFail("Expected invalidURL error")
                }
            } else {
                XCTFail("Expected FileBucketError")
            }
        }
    }

    func testDownloadThrowsOnInvalidURL() async {
        let handle = FileDownloadHandle(url: "")
        do {
            _ = try await handle.download()
            XCTFail("Expected error")
        } catch let error as FileBucketError {
            if case .invalidURL = error {
                // correct
            } else if case .downloadFailed = error {
                // also acceptable — URL was technically parseable but failed
            } else {
                XCTFail("Expected invalidURL or downloadFailed, got \(error)")
            }
        } catch {
            XCTFail("Expected FileBucketError, got \(error)")
        }
    }
}
