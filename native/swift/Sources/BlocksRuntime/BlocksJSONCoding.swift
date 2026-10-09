//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - The wire format's JSON coding

/// How values cross the wire, in one place: every decoder and encoder the runtime and the generated code use
/// comes from here (through ``BlocksClient/makeDecoder()`` and ``BlocksClient/makeEncoder()``).
///
/// A `Date` (`format: date-time`) is an ISO 8601 string, the form the server's `JSON.stringify` gives a
/// JavaScript `Date` (`toISOString()`, e.g. `"2026-10-05T12:34:56.789Z"`). It encodes in exactly that form, in UTC
/// with milliseconds, and decodes with or without fractional seconds and with any UTC offset. Foundation's default
/// (a number of seconds since 2001) is never what the server sends or accepts.
///
/// The encoder sorts an object's keys (`.sortedKeys`), so the same value always encodes to the same bytes. Darwin's
/// `JSONEncoder` doesn't otherwise fix their order: a dictionary's keys, and on recent SDKs a struct's, can come out
/// in a different order from one run to the next. The server doesn't care, but anything that compares or hashes a
/// request body does.
enum BlocksJSONCoding {
    static func makeDecoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = date(from: text) else {
                throw DecodingError.dataCorruptedError(
                    in: container,
                    debugDescription: "Expected an ISO 8601 date-time, like \"2026-10-05T12:34:56.789Z\", got \"\(text)\""
                )
            }
            return date
        }
        return decoder
    }

    static func makeEncoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(string(from: date))
        }
        return encoder
    }

    /// `ISO8601DateFormatter` is thread-safe, and building one is expensive, so these are shared.
    private static let withFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()

    private static let withoutFractionalSeconds: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    /// `"2026-10-05T12:34:56.789Z"`: UTC, three fractional digits, like JavaScript's `toISOString()`.
    static func string(from date: Date) -> String {
        withFractionalSeconds.string(from: date)
    }

    /// An RFC 3339 date-time, with or without fractional seconds. Nil for anything else, including a day alone.
    static func date(from text: String) -> Date? {
        withFractionalSeconds.date(from: text) ?? withoutFractionalSeconds.date(from: text)
    }
}
