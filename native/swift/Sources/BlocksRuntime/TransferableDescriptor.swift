//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Requires `descriptor["__blocks"]` to be a non-empty string equal to
/// `expectedTag`, and returns `descriptor` unchanged so it can be passed
/// straight to a package factory. Throws `DecodingError.dataCorrupted`
/// otherwise. Called from generated code before every factory.
///
/// `subject` opens every message. `UnknownTransferable` passes its own name so the
/// text it published before this function existed is unchanged, as Dart and Kotlin do.
public func validateTransferableDescriptor(
    _ descriptor: [String: Any],
    expectedTag: String,
    subject: String = "Transferable"
) throws -> [String: Any] {
    guard let tag = descriptor["__blocks"] as? String else {
        throw DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "\(subject) for '\(expectedTag)' expected a string '__blocks' tag"
        ))
    }
    guard !tag.isEmpty else {
        throw DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "\(subject) for '\(expectedTag)' expected a non-empty '__blocks' tag"
        ))
    }
    guard tag == expectedTag else {
        throw DecodingError.dataCorrupted(.init(
            codingPath: [],
            debugDescription: "\(subject) expected tag '\(expectedTag)', got '\(tag)'"
        ))
    }
    return descriptor
}
