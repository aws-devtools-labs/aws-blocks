//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Thrown when a `__blocks` transferable descriptor cannot be hydrated into a client-side
/// handle — the server sent a shape this client cannot construct.
///
/// A transfer that fails after the handle exists is a `FileTransferError` instead. A
/// descriptor decoded through `Decodable` reports `DecodingError` instead, so the coding-key
/// path survives for `JSONDecoder` to report.
public enum TransferableError: BlocksError {
    /// No hydrator is registered for this `__blocks` type.
    case unknownType(String)
    /// The descriptor is missing a field the handle needs, or that field is unusable.
    case invalidDescriptor(blocksType: String, missingField: String)

    public var message: String {
        switch self {
        case .unknownType(let blocksType):
            return "No hydrator registered for transferable type: \(blocksType)"
        case .invalidDescriptor(let blocksType, let missingField):
            return "Descriptor '\(blocksType)' is missing required field: \(missingField)"
        }
    }
}
