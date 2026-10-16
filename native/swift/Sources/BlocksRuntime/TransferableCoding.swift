//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Decoding transferables inside models

public extension CodingUserInfoKey {
    /// The `userInfo` key under which a decoder carries the ``BlocksClient`` that fetched the JSON.
    ///
    /// A transferable that talks to the backend itself (an ``OIDCClient``) needs that client to decode, so a
    /// model that holds one, at any depth, must be decoded with it. ``BlocksClient/makeDecoder()`` sets it:
    /// ```swift
    /// let menu = try client.makeDecoder().decode(LoginMenu.self, from: data)
    /// ```
    static let blocksClient = CodingUserInfoKey(rawValue: "com.aws.blocks.client")!
}

public extension BlocksClient {
    /// Returns a `JSONDecoder` that carries this client in `userInfo[.blocksClient]`, so it can decode models
    /// holding transferables that need the client (an ``OIDCClient``). Generated operations use it for such results.
    ///
    /// It also reads the wire format's dates: a `Date` (`format: date-time`) decodes from the ISO 8601 string the
    /// server sends (`"2026-10-05T12:34:56.789Z"`, with or without fractional seconds, any UTC offset), in a field,
    /// a container, an optional or a direct result. Generated operations use it for results that hold a `Date`.
    func makeDecoder() -> JSONDecoder {
        let decoder = BlocksJSONCoding.makeDecoder()
        decoder.userInfo[.blocksClient] = self
        return decoder
    }

    /// Returns the `JSONEncoder` this client encodes requests with. A `Date` encodes as the ISO 8601 string the
    /// server sends and accepts: UTC with milliseconds, like JavaScript's `toISOString()`
    /// (`"2026-10-05T12:34:56.789Z"`). Use it to encode a generated model the way a request sends it.
    ///
    /// It sorts an object's keys (`.sortedKeys`), so a request body is the same bytes every time it's sent.
    func makeEncoder() -> JSONEncoder {
        BlocksJSONCoding.makeEncoder()
    }
}

/// Shared checks for a transferable's `{ "__blocks": "<type>", … }` descriptor.
enum TransferableDescriptor {
    /// Throws when the descriptor names a different transferable type. A descriptor without the tag is accepted.
    static func check<Key: CodingKey>(_ container: KeyedDecodingContainer<Key>, key: Key, expected: String) throws {
        guard let actual = try container.decodeIfPresent(String.self, forKey: key), actual != expected else { return }
        throw DecodingError.dataCorruptedError(
            forKey: key,
            in: container,
            debugDescription: "Expected a '\(expected)' descriptor, got '\(actual)'"
        )
    }
}

// MARK: - JSONValue ↔ JSONSerialization values

extension JSONValue {
    /// Converts a `JSONSerialization` value. Returns `nil` for a value JSON can't hold.
    init?(serialized value: Any) {
        switch value {
        case is NSNull:
            self = .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else if CFNumberIsFloatType(number) {
                self = .double(number.doubleValue)
            } else {
                self = .int(number.intValue)
            }
        case let string as String:
            self = .string(string)
        case let array as [Any]:
            var items: [JSONValue] = []
            for item in array {
                guard let converted = JSONValue(serialized: item) else { return nil }
                items.append(converted)
            }
            self = .array(items)
        case let dictionary as [String: Any]:
            var entries: [String: JSONValue] = [:]
            for (key, item) in dictionary {
                guard let converted = JSONValue(serialized: item) else { return nil }
                entries[key] = converted
            }
            self = .dictionary(entries)
        default:
            return nil
        }
    }

    /// The value as `JSONSerialization` produces it (`[String: Any]`, `[Any]`, `String`, `NSNumber`, `NSNull`).
    var serialized: Any {
        switch self {
        case .string(let value): return value
        case .int(let value): return value
        case .double(let value): return value
        case .bool(let value): return value
        case .null: return NSNull()
        case .array(let value): return value.map(\.serialized)
        case .dictionary(let value): return value.mapValues(\.serialized)
        }
    }
}
