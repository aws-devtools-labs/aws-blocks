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
        // `GetEvent.Result` has an arm tagged `unknown`, so the fallback case is `unknownValue`.
        XCTAssertTrue(api.contains("            case unknown(Unknown)"))
        XCTAssertTrue(api.contains("            case unknownValue(JSONValue)"))
        XCTAssertTrue(api.contains("                    self = .unknownValue(try JSONValue(from: decoder))"))
        XCTAssertTrue(api.contains("                case .unknownValue(let value):\n                    try value.encode(to: encoder)"))
        XCTAssertTrue(api.contains("            public var unknownDiscriminator: String? {"))
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

    func testAResultUnionNamedLikeAnEmbeddedUnionIsStillOpen() throws {
        // `Event`'s `step` arm embeds a union named `StepChallenge`; a component of that name is a direct result.
        let challenge = { (tag: String) in
            #"{ "type": "object", "properties": { "challenge": { "type": "string", "enum": ["\#(tag)"] } }, "required": ["challenge"] }"#
        }
        let spec = """
        { "openrpc": "1.3.2", "info": { "title": "t", "version": "1" },
          "methods": [
            { "name": "api.getEvent", "params": [], "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Event" } } },
            { "name": "api.getChallenge", "params": [],
              "result": { "name": "R", "schema": { "$ref": "#/components/schemas/StepChallenge" } } }
          ],
          "components": { "schemas": {
            "Event": { "oneOf": [
              { "type": "object", "properties": { "kind": { "type": "string", "enum": ["step"] }, "id": { "type": "string" } },
                "required": ["kind", "id"], "oneOf": [\(challenge("a")), \(challenge("b"))] },
              { "type": "object", "properties": { "kind": { "type": "string", "enum": ["done"] } }, "required": ["kind"] }
            ] },
            "StepChallenge": { "oneOf": [\(challenge("x")), \(challenge("y"))] }
          } } }
        """
        let output = try SwiftCodeGenerator().generate(
            from: CodegenModelBuilder().build(from: OpenRPCParser().parse(data: Data(spec.utf8)))
        )
        let all = output.models + output.api
        // `Event` and the component `StepChallenge` are open; the union embedded in `step` is not.
        XCTAssertEqual(all.components(separatedBy: "case unknown(JSONValue)").count - 1, 2, all)
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
            case .unknown: return "arm tagged unknown"
            case .unknownValue: return "unknown \(event.unknownDiscriminator ?? "?")"
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
        check(moved.unknownDiscriminator == nil, "no discriminator for a known arm")
        let tagged = try JSONDecoder().decode(Api.GetEvent.Result.self, from: Data(#"{"kind":"unknown","note":"n"}"#.utf8))
        check(label(tagged) == "arm tagged unknown", "arm tagged unknown")
        check(String(decoding: try encoder.encode(moved), as: UTF8.self) == #"{"kind":"moved","to":"done"}"#, "known round trip")
        print("ok")
        """#
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }
        XCTAssertEqual(run.output.trimmingCharacters(in: .whitespacesAndNewlines), "ok", run.output)
    }
    #endif
}
