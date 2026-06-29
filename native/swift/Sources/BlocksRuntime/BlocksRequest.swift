//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// A JSON-RPC 2.0 request envelope.
///
/// `params` is `[any Encodable]` — each param is a typed serializable value.
/// `BlocksArrayParams` writes them as a positional JSON array.
public struct BlocksRequest: Encodable {
    public let method: String
    public let params: [any Encodable]
    public let id: Int
    public let jsonrpc: String = "2.0"

    private static var counter: Int = 0
    private static let lock = NSLock()

    public static func nextId() -> Int {
        lock.lock()
        defer { lock.unlock() }
        counter += 1
        return counter
    }

    public init(method: String, params: [any Encodable], id: Int) {
        self.method = method
        self.params = params
        self.id = id
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(method, forKey: .method)
        try container.encode(id, forKey: .id)
        try container.encode(jsonrpc, forKey: .jsonrpc)
        try container.encode(BlocksArrayParams(params), forKey: .params)
    }

    private enum CodingKeys: String, CodingKey {
        case method, params, id, jsonrpc
    }
}
