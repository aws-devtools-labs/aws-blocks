//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

// A string enum a response carries is generated open: a value the client was generated without decodes to
// `.unknown(String)` instead of throwing, and encodes back as that string. An enum only parameters use stays a
// closed `String` enum.
final class OpenEnumTests: XCTestCase {
    private func generate(fixture: String) throws -> GeneratedSources {
        let fixtures = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().appendingPathComponent("codegen-fixtures")
        let spec = try Data(contentsOf: fixtures.appendingPathComponent("\(fixture)/spec.json"))
        return try SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: OpenRPCParser().parse(data: spec)))
    }

    func testResultEnumsAreOpen() throws {
        let output = try generate(fixture: "45-open-enums")
        for name in ["Status", "TaskLabels", "TaskPriority", "TaskSource"] {
            XCTAssertTrue(
                output.models.contains("public nonisolated enum \(name): RawRepresentable, Codable, Hashable, Sendable {"), name
            )
        }
        XCTAssertTrue(output.api.contains("public enum Severity: RawRepresentable, Codable, Hashable, Sendable {"))
        XCTAssertTrue(output.api.contains("public enum Change: RawRepresentable, Codable, Hashable, Sendable {"))
        XCTAssertTrue(output.models.contains("    case \"in-progress\": self = .inProgress"))
        XCTAssertTrue(output.models.contains("    default: self = .unknown(rawValue)"))
    }

    func testParameterOnlyEnumStaysClosed() throws {
        let output = try generate(fixture: "45-open-enums")
        XCTAssertTrue(output.api.contains("public enum Sort: String, Codable, Sendable {"))
        // 05: the parameter's `SetStatus.Status` stays closed, the result's `SetStatus.Result.Status` opens.
        let enums = try generate(fixture: "05-enums").api
        XCTAssertTrue(enums.contains("        public enum Status: String, Codable, Sendable {"))
        XCTAssertTrue(enums.contains("            public enum Status: RawRepresentable, Codable, Hashable, Sendable {"))
    }

    func testOIDCProviderEnumStaysClosed() throws {
        let output = try generate(fixture: "37-oidc-provider-enum")
        XCTAssertFalse(output.api.contains("RawRepresentable"))
        XCTAssertFalse(output.models.contains("RawRepresentable"))
    }

    func testSpecValueNamedUnknownKeepsItsName() throws {
        let output = try generate(fixture: "45-open-enums")
        XCTAssertTrue(output.models.contains("    case unknown\n"))
        XCTAssertTrue(output.models.contains("    case unknownValue(String)"))
        XCTAssertTrue(output.models.contains("    default: self = .unknownValue(rawValue)"))
    }

    func testComponentOnlyAParameterUsesStaysClosedBesideAnInlineResultEnumOfItsName() throws {
        let output = try generate(fixture: "45-open-enums")
        XCTAssertTrue(output.models.contains("public nonisolated enum Mode: String, Codable, Sendable {"))
        XCTAssertTrue(output.api.contains("public enum Mode: RawRepresentable, Codable, Hashable, Sendable {"))
    }

    func testOpenEnumArmOfAUnionWithoutDiscriminatorAcceptsOnlyKnownValues() throws {
        let api = try generate(fixture: "45-open-enums").api
        XCTAssertTrue(api.contains(#"if let value = try? Color(from: decoder), ["red", "blue"].contains(value.rawValue) {"#))
        XCTAssertTrue(api.contains(#"if let value = try? Size(from: decoder), ["small", "large"].contains(value.rawValue) {"#))
    }

    func testEnumsInsideArmsOfAUnionWithoutDiscriminatorStayClosed() throws {
        let spec = #"""
        { "openrpc": "1.3.2", "info": { "title": "t", "version": "1" },
          "methods": [{ "name": "api.getProgress", "params": [], "result": { "name": "R", "schema": { "oneOf": [
            { "type": "object", "properties": { "state": { "type": "string", "enum": ["idle", "loading"] } },
              "required": ["state"] },
            { "type": "object", "properties": { "state": { "type": "string", "enum": ["error"] },
              "message": { "type": "string" } }, "required": ["state", "message"] } ] } } }] }
        """#
        let output = try SwiftCodeGenerator().generate(
            from: CodegenModelBuilder().build(from: OpenRPCParser().parse(data: Data(spec.utf8)))
        )
        XCTAssertFalse(output.api.contains("RawRepresentable"), output.api)
        XCTAssertFalse(output.models.contains("RawRepresentable"), output.models)
        // Fixture 45's `GetJob.Result` arms are components; their enums stay closed.
        let fixture = try generate(fixture: "45-open-enums")
        XCTAssertTrue(fixture.models.contains("public nonisolated enum PendingState: String, Codable, Sendable {"))
        XCTAssertTrue(fixture.models.contains("public nonisolated enum FailedState: String, Codable, Sendable {"))
    }

    /// `[{ state: 'idle' | 'loading' }] | [{ state: 'error'; message: string }]`, as an inline result and inside a
    /// component's nested object.
    private let listArmsSpec = #"""
    { "openrpc": "1.3.2", "info": { "title": "t", "version": "1" },
      "methods": [
        { "name": "api.getProgress", "params": [], "result": { "name": "R", "schema": { "oneOf": [
          { "type": "array", "items": { "type": "object", "properties": { "state": { "type": "string", "enum": ["idle", "loading"] } },
            "required": ["state"] } },
          { "type": "array", "items": { "type": "object", "properties": { "state": { "type": "string", "enum": ["error"] },
            "message": { "type": "string" } }, "required": ["state", "message"] } } ] } } },
        { "name": "api.getSteps", "params": [], "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Steps" } } }
      ],
      "components": { "schemas": { "Steps": { "type": "object", "properties": { "detail": { "type": "object",
        "properties": { "progress": { "oneOf": [
        { "type": "array", "items": { "type": "object", "properties": { "state": { "type": "string", "enum": ["idle", "loading"] } },
          "required": ["state"] } },
        { "type": "array", "items": { "type": "object", "properties": { "state": { "type": "string", "enum": ["error"] },
          "message": { "type": "string" } }, "required": ["state", "message"] } } ] } }, "required": ["progress"] } },
        "required": ["detail"] } } } }
    """#

    func testEnumsInsideListArmsOfAUnionWithoutDiscriminatorStayClosed() throws {
        let output = try SwiftCodeGenerator().generate(
            from: CodegenModelBuilder().build(from: OpenRPCParser().parse(data: Data(listArmsSpec.utf8)))
        )
        XCTAssertFalse(output.api.contains("RawRepresentable"), output.api)
        XCTAssertFalse(output.models.contains("RawRepresentable"), output.models)
    }

    #if os(macOS)
    func testUnknownValuesDecodeAndRoundTrip() throws {
        let output = try generate(fixture: "45-open-enums")
        let auth = try generate(fixture: "18-hybrid-arm")
        // Each fixture builds as its own module, since their type names would clash in one.
        let main = #"""
        import Foundation
        import Generated

        func check(_ ok: Bool, _ what: String) { if !ok { print("failed: \(what)"); exit(1) } }

        func label(_ status: Status) -> String {
            switch status {
            case .todo: return "todo"
            case .inProgress: return "in progress"
            case .done: return "done"
            case .unknown(let value): return "unknown \(value)"
            }
        }

        let wire = #"{"history":["todo","in-progress","blocked"],"id":"t1","labels":{"a":"red","b":"purple"},"#
            + #""priority":"urgent","source":"unknown","status":"archived"}"#
        let task = try JSONDecoder().decode(Task.self, from: Data(wire.utf8))
        check(task.status == .unknown("archived"), "status")
        check(label(task.status) == "unknown archived", "switch")
        check(task.history == [.todo, .inProgress, .unknown("blocked")], "list")
        check(task.labels["b"] == .unknown("purple"), "map")
        check(task.priority == .unknown("urgent"), "optional")
        check(task.source == .unknown, "spec value named unknown")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        check(String(decoding: try encoder.encode(task), as: UTF8.self) == wire, "round trip")
        check(Status(rawValue: "done") == .done, "known raw value")
        // Equality and hashing follow the cases, as `switch` does, not the raw value.
        let handBuilt = Status.unknown("done")
        check(handBuilt != .done, "a hand-built unknown isn't the known case")
        check(Set([handBuilt, Status.done]).count == 2, "set keeps both")
        check(Set([Status.unknown("x"), Status.unknown("x")]).count == 1, "equal unknowns hash alike")
        check(Status.unknown("x") == Status(rawValue: "x"), "decoded and hand-built unknowns are equal")
        switch handBuilt {
        case .done: check(false, "switch took the known case")
        case .unknown(let value): check(value == "done", "switch value")
        default: check(false, "switch fell through")
        }
        // `GetJob.Result` is `Pending | Failed` with no discriminator: an object for `Failed` decodes to it.
        func job(_ text: String) throws -> Api.GetJob.Result {
            try JSONDecoder().decode(Api.GetJob.Result.self, from: Data(text.utf8))
        }
        if case .failed(let failed) = try job(#"{"message":"boom","state":"error"}"#) {
            check(failed.message == "boom", "failed message")
        } else {
            check(false, "failed arm")
        }
        if case .pending(let pending) = try job(#"{"state":"loading","steps":["fetch"]}"#) {
            check(pending.steps == [.fetch], "pending steps")
        } else {
            check(false, "pending arm")
        }
        check((try? job(#"{"state":"paused"}"#)) == nil, "a value neither arm declares")
        // `Color` is open (a direct result), and also an arm of `getSwatch`'s union without a discriminator:
        // `"small"` is a `Size`, not an unknown `Color`.
        func swatch(_ text: String) throws -> Api.GetSwatch.Result {
            try JSONDecoder().decode(Api.GetSwatch.Result.self, from: Data(text.utf8))
        }
        if case .size(.small) = try swatch(#""small""#) {} else { check(false, "size arm") }
        if case .color(.red) = try swatch(#""red""#) {} else { check(false, "color arm") }
        check((try? swatch(#""green""#)) == nil, "a value no arm knows")
        print("ok")
        """#
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }
        XCTAssertEqual(run.output.trimmingCharacters(in: .whitespacesAndNewlines), "ok", run.output)

        let authMain = #"""
        import Foundation
        import Generated

        func check(_ ok: Bool, _ what: String) { if !ok { print("failed: \(what)"); exit(1) } }

        let wire = #"{"actions":[{"capability":"webauthn-future","fields":[{"label":"Code","name":"otp","required":true,"#
            + #""type":"otp"}],"label":"Verify","name":"verifyTotp"}],"state":"enrollingTotp"}"#
        let state = try JSONDecoder().decode(AuthState.self, from: Data(wire.utf8))
        check(state.state == .unknown("enrollingTotp"), "auth state")
        check(state.actions[0].fields[0].type == .unknown("otp"), "field type")
        check(state.actions[0].capability == .unknown("webauthn-future"), "capability")
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        check(String(decoding: try encoder.encode(state), as: UTF8.self) == wire, "round trip")
        print("ok")
        """#
        guard let authRun = try runConsumer(models: auth.models, api: auth.api, main: authMain) else { return }
        XCTAssertEqual(authRun.output.trimmingCharacters(in: .whitespacesAndNewlines), "ok", authRun.output)
    }

    func testListArmsOfAUnionWithoutDiscriminatorDecodeTheRightArm() throws {
        let output = try SwiftCodeGenerator().generate(
            from: CodegenModelBuilder().build(from: OpenRPCParser().parse(data: Data(listArmsSpec.utf8)))
        )
        let main = #"""
        import Foundation
        import Generated

        func check(_ ok: Bool, _ what: String) { if !ok { print("failed: \(what)"); exit(1) } }

        let wire = #"[{"message":"boom","state":"error"}]"#
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        let progress = try JSONDecoder().decode(Api.GetProgress.Result.self, from: Data(wire.utf8))
        if case .result_Variant1(let items) = progress {
            check(items.first?.message == "boom", "inline message")
        } else {
            check(false, "inline arm")
        }
        check(String(decoding: try encoder.encode(progress), as: UTF8.self) == wire, "inline round trip")
        let nested = #"{"detail":{"progress":[{"message":"boom","state":"error"}]}}"#
        let steps = try JSONDecoder().decode(Steps.self, from: Data(nested.utf8))
        if case .progress_Variant1(let items) = steps.detail.progress {
            check(items.first?.message == "boom", "component message")
        } else {
            check(false, "component arm")
        }
        check(String(decoding: try encoder.encode(steps), as: UTF8.self) == nested, "component round trip")
        print("ok")
        """#
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }
        XCTAssertEqual(run.output.trimmingCharacters(in: .whitespacesAndNewlines), "ok", run.output)
    }
    #endif
}
