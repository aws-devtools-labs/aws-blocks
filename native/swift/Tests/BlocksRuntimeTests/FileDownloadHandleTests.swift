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

    func testFromJSONThrowsTransferableErrorOnMissingURL() {
        XCTAssertThrowsError(try FileDownloadHandle.fromJSON([:])) { error in
            XCTAssertTrue(error is TransferableError, "got \(error)")
        }
    }

    func testDownloadThrowsTransferableErrorOnUnparseableURL() async {
        let handle = FileDownloadHandle(url: "")
        do {
            _ = try await handle.download()
            XCTFail("Expected error")
        } catch let error as TransferableError {
            XCTAssertEqual(error.message, "Descriptor 'file-bucket/download' is missing required field: url")
        } catch {
            XCTFail("Expected TransferableError, got \(error)")
        }
    }

    func testFailedDownloadCarriesItsStatusAsAField() async {
        MockURLProtocol.handler = { request in
            (HTTPURLResponse(url: request.url!, statusCode: 404, httpVersion: nil, headerFields: nil)!, Data())
        }
        defer { MockURLProtocol.handler = nil }
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        let handle = FileDownloadHandle(url: "https://example.com/file.txt", session: URLSession(configuration: config))
        do {
            _ = try await handle.download()
            XCTFail("Expected error")
        } catch let error as FileTransferError {
            XCTAssertEqual(error.statusCode, 404)
            XCTAssertEqual(error.message, "Download failed: HTTP 404")
        } catch {
            XCTFail("Expected FileTransferError, got \(error)")
        }
    }
}
