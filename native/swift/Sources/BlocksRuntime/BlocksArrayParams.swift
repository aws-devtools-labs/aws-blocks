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
            // Through the container, not `value.encode(to:)`: the encoder applies its strategies only to values
            // it encodes itself, so a `Date` parameter is sent as an ISO 8601 string, not as a number.
            try container.encode(value)
        }
    }
}
