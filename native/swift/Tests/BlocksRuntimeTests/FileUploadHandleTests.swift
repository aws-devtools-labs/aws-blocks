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

    func testFromJSONThrowsTransferableErrorOnMissingURL() {
        XCTAssertThrowsError(try FileUploadHandle.fromJSON(["contentType": "image/png"])) { error in
            XCTAssertTrue(error is TransferableError, "got \(error)")
        }
    }

    func testUploadThrowsTransferableErrorOnUnparseableURL() async {
        let handle = FileUploadHandle(url: "")
        do {
            try await handle.upload(data: Data("test".utf8))
            XCTFail("Expected error")
        } catch let error as TransferableError {
            XCTAssertEqual(error.message, "Descriptor 'file-bucket/upload' is missing required field: url")
        } catch {
            XCTFail("Expected TransferableError, got \(error)")
        }
    }

    func testFailedUploadCarriesItsStatusAsAField() async {
        MockURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 403, httpVersion: nil, headerFields: nil)!, Data())
        }
        defer { MockURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let handle = FileUploadHandle(url: "https://example.com/upload", session: URLSession(configuration: config))
        do {
            try await handle.upload(data: Data("test".utf8))
            XCTFail("Expected error")
        } catch let error as FileTransferError {
            XCTAssertEqual(error.statusCode, 403)
            XCTAssertEqual(error.message, "Upload failed: HTTP 403")
        } catch {
            XCTFail("Expected FileTransferError, got \(error)")
        }
    }
}
