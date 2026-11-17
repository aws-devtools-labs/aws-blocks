//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Thrown when an upload or download through a file-bucket handle fails — the presigned
/// URL rejected the transfer, or the connection failed partway through.
///
/// Hydrating the handle itself is a different failure: an unusable descriptor is a
/// `TransferableError`.
public struct FileTransferError: BlocksError {
    public let message: String

    /// The HTTP status the transfer was rejected with, or `nil` when the request got no
    /// response.
    public let statusCode: Int?

    public let underlyingError: Error?

    public init(message: String, statusCode: Int? = nil, underlyingError: Error? = nil) {
        self.message = message
        self.statusCode = statusCode
        self.underlyingError = underlyingError
    }
}
