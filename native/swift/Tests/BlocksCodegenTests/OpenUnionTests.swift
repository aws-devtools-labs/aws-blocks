//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

// A union with a string discriminator that a response carries is generated open: an object whose discriminator
// names no arm decodes to `.unknown(JSONValue)` instead of throwing, and encodes back as that object. A union only
// parameters use stays closed, and so does one with a boolean discriminator.
final class OpenUnionTests: XCTestCase {
    private func generate(fixture: String) throws -> GeneratedSources {
        let fixtures = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("codegen-fixtures")
        let spec = try Data(contentsOf: fixtures.appendingPathComponent("\(fixture)/spec.json"))
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: OpenRPCParser().parse(data: spec)))
    }

    func testResultUnionHasAnUnknownCase() throws {
        let api = try generate(fixture: "45-open-enums").api
        XCTAssertTrue(api.contains("            case unknown(JSONValue)"))
        XCTAssertTrue(api.contains("                    self = .unknown(try JSONValue(from: decoder))"))
        XCTAssertTrue(api.contains("                case .unknown(let value):\n                    try value.encode(to: encoder)"))
    }

    func testParameterOnlyUnionStaysClosed() throws {
        let output = try generate(fixture: "18-hybrid-arm")
        XCTAssertFalse(output.api.contains("JSONValue)"))
        XCTAssertFalse(output.models.contains("case unknown(JSONValue)"))
    }

    func testBooleanDiscriminatedUnionStaysClosed() throws {
        let api = try generate(fixture: "24-nullable-discriminated-union").api
        // One union in 24 is discriminated by the string `type` (open); `UpdateAttributes.Result` by `isUpdated`.
        XCTAssertEqual(api.components(separatedBy: "case unknown(JSONValue)").count - 1, 1)
    }

    #if os(macOS)
    func testUnknownArmDecodesAndRoundTrips() throws {
        let output = try generate(fixture: "45-open-enums")
        let main = #"""
        import Foundation
        import BlocksRuntime
        import Generated

        func check(_ ok: Bool, _ what: String) { if !ok { print("failed: \(what)"); exit(1) } }

        func label(_ event: Api.GetEvent.Result) -> String {
            switch event {
            case .moved: return "moved"
            case .flagged: return "flagged"
            case .unknown(let value):
                if case .dictionary(let object) = value, case .string(let kind)? = object["kind"] { return "unknown \(kind)" }
                return "unknown"
            }
        }

        let wire = #"{"at":{"day":3},"by":"someone","kind":"archived"}"#
        let event = try JSONDecoder().decode(Api.GetEvent.Result.self, from: Data(wire.utf8))
        check(label(event) == "unknown archived", "unknown arm")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        check(String(decoding: try encoder.encode(event), as: UTF8.self) == wire, "round trip")
        let moved = try JSONDecoder().decode(Api.GetEvent.Result.self, from: Data(#"{"kind":"moved","to":"done"}"#.utf8))
        check(label(moved) == "moved", "known arm")
        check(String(decoding: try encoder.encode(moved), as: UTF8.self) == #"{"kind":"moved","to":"done"}"#, "known round trip")
        print("ok")
        """#
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }
        XCTAssertEqual(run.output.trimmingCharacters(in: .whitespacesAndNewlines), "ok", run.output)
    }
    #endif
}
