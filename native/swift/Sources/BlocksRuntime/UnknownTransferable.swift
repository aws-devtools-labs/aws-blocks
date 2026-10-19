//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

/// A checked carrier for a transferable whose tag has no runtime binding on this
/// platform: holds the tag and descriptor without hydrating them.
public struct UnknownTransferable: Sendable, Codable, Equatable {
    /// The descriptor (including `__blocks`), as `JSONValue` with JSON number
    /// types preserved; an integer beyond `Int` range is stored as `Double`.
    /// A `Codable` round-trip is value-preserving except that a whole-valued
    /// double (e.g. `1.0`, `-0.0`), at any depth, may decode back as an integer.
    public let descriptor: [String: JSONValue]

    /// The `__blocks` tag, read from `descriptor` (its single source of truth).
    public var tag: String {
        if case .string(let value) = descriptor["__blocks"] { return value }
        return ""
    }

    private init(descriptor: [String: JSONValue]) {
        self.descriptor = descriptor
    }

    private enum CodingKeys: String, CodingKey { case descriptor }

    /// Decodes a carrier, enforcing the same `__blocks` invariant as `fromJSON`
    /// (present, a string, non-empty) so `Decodable` cannot build a carrier the
    /// factory would reject. The tag-equality check needs `expectedTag`, so it
    /// stays in `fromJSON`.
    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        let decoded = try container.decode([String: JSONValue].self, forKey: .descriptor)
        guard case .string(let tag) = decoded["__blocks"], !tag.isEmpty else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "UnknownTransferable expected a non-empty string '__blocks' tag"
            ))
        }
        self.descriptor = decoded
    }

    /// Throws unless `descriptor`'s `__blocks` is a non-empty string equal to `expectedTag` and every value is JSON-representable.
    public static func fromJSON(_ descriptor: [String: Any], expectedTag: String) throws -> UnknownTransferable {
        guard let tag = descriptor["__blocks"] as? String else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: [],
                debugDescription: "UnknownTransferable for '\(expectedTag)' expected a string '__blocks' tag"
            ))
        }
        guard !tag.isEmpty else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: [],
                debugDescription: "UnknownTransferable for '\(expectedTag)' expected a non-empty '__blocks' tag"
            ))
        }
        guard tag == expectedTag else {
            throw DecodingError.dataCorrupted(.init(
                codingPath: [],
                debugDescription: "UnknownTransferable expected tag '\(expectedTag)', got '\(tag)'"
            ))
        }
        // Convert directly to JSONValue (needed for Sendable), preserving each
        // JSON number's type instead of collapsing it through a Codable re-decode.
        var value: [String: JSONValue] = [:]
        for (key, element) in descriptor {
            value[key] = try jsonValue(from: element, expectedTag: expectedTag)
        }
        return UnknownTransferable(descriptor: value)
    }

    private static func jsonValue(from element: Any, expectedTag: String) throws -> JSONValue {
        switch element {
        case is NSNull:
            return .null
        case let number as NSNumber:
            // A JSON bool is an NSNumber backed by CFBoolean; check it before
            // the numeric cases, or `true` would decode as the integer 1.
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                return .bool(number.boolValue)
            }
            if CFNumberIsFloatType(number) {
                return .double(number.doubleValue)
            }
            if let int = Int(exactly: number) {
                return .int(int)
            }
            // Integer beyond Int's range: JSONValue has no wider integer type,
            // so fall back to Double (may lose precision).
            return .double(number.doubleValue)
        case let string as String:
            return .string(string)
        case let array as [Any]:
            return .array(try array.map { try jsonValue(from: $0, expectedTag: expectedTag) })
        case let dictionary as [String: Any]:
            var nested: [String: JSONValue] = [:]
            for (key, value) in dictionary {
                nested[key] = try jsonValue(from: value, expectedTag: expectedTag)
            }
            return .dictionary(nested)
        default:
            throw DecodingError.dataCorrupted(.init(
                codingPath: [],
                debugDescription: "UnknownTransferable for '\(expectedTag)' expected a JSON object descriptor"
            ))
        }
    }
}
