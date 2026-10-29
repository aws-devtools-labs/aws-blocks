//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksRuntime

/// A `format: date-time` value is a `Date` in Swift and an ISO 8601 string on the wire: the server's
/// `JSON.stringify` sends a `Date` as its `toISOString()` (`"2026-10-05T12:34:56.789Z"`). A plain `JSONDecoder`
/// expects a number (seconds since 2001), so every such string failed to decode, and a plain `JSONEncoder` sent
/// that number. The client's decoder and encoder use ISO 8601 everywhere: a field, a container, an optional, a
/// direct result, a request parameter and a channel message.
final class DateCodingTests: XCTestCase {

    private struct Event: Codable, Equatable {
        let time: Date
        let history: [Date]
        let byRoom: [String: Date?]
        let maybe: Date?
    }

    private let wire = "2026-10-05T12:34:56.789Z"
    /// 2026-10-05T12:34:56.789Z, as the formatter reads it (a `Double` literal can differ in the last bit).
    private let instant: Date = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter.date(from: "2026-10-05T12:34:56.789Z")!
    }()
    private let wholeSecond = Date(timeIntervalSince1970: 1_791_203_696)

    private func assertSameInstant(_ date: Date?, _ expected: Date, file: StaticString = #filePath, line: UInt = #line) {
        guard let date else { return XCTFail("Expected \(expected), got nil", file: file, line: line) }
        XCTAssertEqual(date.timeIntervalSince1970, expected.timeIntervalSince1970, accuracy: 0.0005, file: file, line: line)
    }

    private var client: BlocksClient { BlocksClient(url: "http://localhost:3001/aws-blocks/api") }

    private func string(_ data: Data) -> String { String(bytes: data, encoding: .utf8) ?? "" }

    // MARK: - Decoding

    func testDecoderReadsTheServersISOStrings() throws {
        let decoder = client.makeDecoder()
        assertSameInstant(try decoder.decode(Date.self, from: Data("\"\(wire)\"".utf8)), instant)
        // Without fractional seconds, with an offset, and with more than millisecond precision.
        assertSameInstant(try decoder.decode(Date.self, from: Data(#""2026-10-05T12:34:56Z""#.utf8)), wholeSecond)
        assertSameInstant(try decoder.decode(Date.self, from: Data(#""2026-10-05T14:34:56.789+02:00""#.utf8)), instant)
        assertSameInstant(try decoder.decode(Date.self, from: Data(#""2026-10-05T12:34:56.789123Z""#.utf8)), instant)
    }

    func testDecoderReadsDatesInFieldsContainersAndOptionals() throws {
        let json = """
        {"time":"\(wire)","history":["\(wire)","2026-10-05T12:34:56Z"],"byRoom":{"a":"\(wire)","b":null},"maybe":null}
        """
        let event = try client.makeDecoder().decode(Event.self, from: Data(json.utf8))
        assertSameInstant(event.time, instant)
        XCTAssertEqual(event.history.count, 2)
        assertSameInstant(event.history.first, instant)
        assertSameInstant(event.history.last, wholeSecond)
        XCTAssertEqual(event.byRoom.count, 2)
        assertSameInstant(event.byRoom["a"] ?? nil, instant)
        XCTAssertEqual(event.byRoom["b"], .some(nil))
        XCTAssertNil(event.maybe)
    }

    func testDecoderRejectsAStringThatIsntADateTime() {
        XCTAssertThrowsError(try client.makeDecoder().decode(Date.self, from: Data(#""yesterday""#.utf8))) { error in
            guard case DecodingError.dataCorrupted(let context) = error else {
                return XCTFail("Expected dataCorrupted, got \(error)")
            }
            XCTAssertTrue(context.debugDescription.contains("yesterday"), context.debugDescription)
        }
        // A day without a time isn't a date-time.
        XCTAssertThrowsError(try client.makeDecoder().decode(Date.self, from: Data(#""2026-10-05""#.utf8)))
    }

    func testDecoderStillCarriesTheClient() {
        let client = client
        XCTAssertTrue(client.makeDecoder().userInfo[.blocksClient] as? BlocksClient === client)
    }

    // MARK: - Encoding

    func testEncoderWritesWhatTheServerSends() throws {
        let encoder = client.makeEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(string(try encoder.encode(instant)), "\"\(wire)\"")
        let event = Event(time: instant, history: [instant], byRoom: ["a": instant, "b": nil], maybe: nil)
        XCTAssertEqual(
            string(try encoder.encode(event)),
            #"{"byRoom":{"a":"\#(wire)","b":null},"history":["\#(wire)"],"time":"\#(wire)"}"#
        )
        // It round-trips through the decoder.
        XCTAssertEqual(try client.makeDecoder().decode(Event.self, from: try encoder.encode(event)), event)
    }

    /// A parameter that is itself a `Date` used to encode as a number even with a date strategy: the positional
    /// params called the value's `encode(to:)` directly, which bypasses the encoder's strategies.
    func testRequestParamsEncodeDatesAsISOStrings() throws {
        let request = BlocksRequest(method: "api.schedule", params: [instant, [instant], "x"], id: 7)
        let encoder = client.makeEncoder()
        encoder.outputFormatting = [.sortedKeys]
        XCTAssertEqual(
            string(try encoder.encode(request)),
            #"{"id":7,"jsonrpc":"2.0","method":"api.schedule","params":["\#(wire)",["\#(wire)"],"x"]}"#
        )
    }

    func testExecuteSendsDatesAsISOStrings() async throws {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [MockURLProtocol.self]
        var sentBody: String?
        MockURLProtocol.handler = { request in
            sentBody = Self.body(of: request)
            let response = HTTPURLResponse(url: request.url!, statusCode: 200, httpVersion: nil, headerFields: nil)!
            return (response, Data(#"{"jsonrpc":"2.0","result":null,"id":1}"#.utf8))
        }
        defer { MockURLProtocol.handler = nil }
        let client = BlocksClient(url: "http://localhost:3001/aws-blocks/api", session: URLSession(configuration: config))
        _ = try await client.execute(BlocksRequest(method: "api.schedule", params: [instant], id: 1))
        let body = try XCTUnwrap(sentBody)
        XCTAssertTrue(body.contains(#""params":["\#(wire)"]"#), body)
    }

    private static func body(of request: URLRequest) -> String? {
        if let body = request.httpBody { return String(bytes: body, encoding: .utf8) }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4_096)
        while stream.hasBytesAvailable {
            let read = stream.read(&buffer, maxLength: buffer.count)
            guard read > 0 else { break }
            data.append(buffer, count: read)
        }
        return String(bytes: data, encoding: .utf8)
    }

    // MARK: - Channel messages

    private struct Ping: Codable, Equatable {
        let sentAt: Date
    }

    private struct Room: Decodable {
        let feed: RealtimeChannel<Ping>
    }

    /// A channel inside a model decodes its messages with its own decoder, which must read dates the same way.
    func testAChannelInAModelDecodesDatesInItsMessages() throws {
        let json = """
        {"feed":{"__blocks":"realtime/channel","channel":"app/pings","wsUrl":"ws://localhost:3001/ws","token":"tok"}}
        """
        let room = try client.makeDecoder().decode(Room.self, from: Data(json.utf8))
        let ping = try room.feed.deserializer(Data(#"{"sentAt":"\#(wire)"}"#.utf8))
        assertSameInstant(ping.sentAt, instant)
    }
}
