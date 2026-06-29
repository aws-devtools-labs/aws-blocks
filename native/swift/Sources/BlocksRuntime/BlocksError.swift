//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Protocol for all errors thrown by the Blocks runtime.
public protocol BlocksError: Error {
    var message: String { get }
    var underlyingError: Error? { get }
}

public extension BlocksError {
    var underlyingError: Error? { nil }
}

/// Errors thrown by generated code (models and API extensions).
public enum CodegenError: BlocksError {
    case validation(String)

    public var message: String {
        switch self {
        case .validation(let msg): return msg
        }
    }
}
