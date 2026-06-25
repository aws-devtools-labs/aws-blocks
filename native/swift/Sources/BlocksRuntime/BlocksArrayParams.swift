//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// Encodes a fixed-order list of heterogeneous values as a JSON array.
/// Used to send JSON-RPC positional params so argument order is preserved
/// regardless of JSONEncoder key ordering.
public struct BlocksArrayParams: Encodable {
    private let values: [any Encodable]

    public init(_ values: [any Encodable]) {
        self.values = values
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.unkeyedContainer()
        for value in values {
            try container.encode(AnyEncodableValue(value))
        }
    }
}

/// Type-erased wrapper that forwards encoding to the underlying value.
private struct AnyEncodableValue: Encodable {
    private let _encode: (Encoder) throws -> Void

    init(_ value: any Encodable) {
        self._encode = { encoder in try value.encode(to: encoder) }
    }

    func encode(to encoder: Encoder) throws {
        try _encode(encoder)
    }
}
