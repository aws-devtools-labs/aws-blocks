//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Coding for transferables nested in a generated result: decoded from their descriptor, never encoded.
enum TransferableCoding {
    /// The descriptor object, as `JSONSerialization` reads a top-level one.
    static func descriptor(from decoder: Decoder) throws -> [String: Any] {
        try decoder.singleValueContainer().decode([String: JSONValue].self).mapValues(\.foundationObject)
    }

    /// The error `encode(to:)` throws: transferables are read-only.
    static func readOnlyError(_ value: Any, _ encoder: Encoder) -> EncodingError {
        EncodingError.invalidValue(value, .init(codingPath: encoder.codingPath, debugDescription: "Transferables are read-only"))
    }
}

extension JSONValue {
    /// The value as `JSONSerialization` returns it: `NSNumber` for numbers and booleans, `NSNull` for null.
    var foundationObject: Any {
        switch self {
        case .string(let value): return value
        case .int(let value): return NSNumber(value: value)
        case .double(let value): return NSNumber(value: value)
        case .bool(let value): return NSNumber(value: value)
        case .null: return NSNull()
        case .array(let values): return values.map(\.foundationObject)
        case .dictionary(let values): return values.mapValues(\.foundationObject)
        }
    }
}
