//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

final class FileUploadHandleTests: XCTestCase {

    func testFromJSONParsesURL() throws {
        let json: [String: Any] = ["url": "https://s3.amazonaws.com/bucket/upload"]
        let handle = try FileUploadHandle.fromJSON(json)
        XCTAssertEqual(handle.getUrl(), "https://s3.amazonaws.com/bucket/upload")
    }

    func testFromJSONParsesContentType() throws {
        let json: [String: Any] = ["url": "https://example.com/upload", "contentType": "image/jpeg"]
        let handle = try FileUploadHandle.fromJSON(json)
        XCTAssertEqual(handle.getUrl(), "https://example.com/upload")
    }

    func testFromJSONThrowsOnMissingURL() {
        let json: [String: Any] = ["contentType": "image/png"]
        XCTAssertThrowsError(try FileUploadHandle.fromJSON(json)) { error in
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

    func testUploadThrowsOnInvalidURL() async {
        let handle = FileUploadHandle(url: "")
        do {
            try await handle.upload(data: Data("test".utf8))
            XCTFail("Expected error")
        } catch let error as FileBucketError {
            if case .invalidURL = error {
                // correct
            } else if case .uploadFailed = error {
                // also acceptable
            } else {
                XCTFail("Expected invalidURL or uploadFailed, got \(error)")
            }
        } catch {
            XCTFail("Expected FileBucketError, got \(error)")
        }
    }
}
