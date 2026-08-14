//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Errors for file bucket operations (download/upload).
public enum FileBucketError: BlocksError {
    case invalidURL(String)
    case downloadFailed(String, Error?)
    case uploadFailed(String, Error?)

    public var message: String {
        switch self {
        case .invalidURL(let url):
            return "Invalid URL: \(url)"
        case .downloadFailed(let reason, _):
            return "Download failed: \(reason)"
        case .uploadFailed(let reason, _):
            return "Upload failed: \(reason)"
        }
    }

    public var underlyingError: Error? {
        switch self {
        case .downloadFailed(_, let error): return error
        case .uploadFailed(_, let error): return error
        default: return nil
        }
    }
}
