//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// `Models.swift` imports BlocksRuntime when it names anything declared there. It used to look only for
/// `JSONValue` and the transferable types, but a component schema with a constraint validates in its init and throws
/// `CodegenError`, which is BlocksRuntime's too, so such a schema didn't compile when the generated code is its own
/// module (`cannot find 'CodegenError' in scope`). Fixtures 13–15 put their constraints in operation scope, in
/// `Api.swift`, which always imports the runtime, so no golden showed it.
final class ModelsRuntimeImportTests: XCTestCase {

    private func generate(schemas: String, result: String) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": [{ "name": "api.get", "params": [], "result": { "name": "R", "schema": \(result) } }],
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private let tag = #"""
    { "Tag": { "type": "object", "properties": {
        "name": { "type": "string", "minLength": 1, "maxLength": 3 }, "note": { "type": "string" }
    }, "required": ["name"] } }
    """#
    private let tagRef = ##"{ "$ref": "#/components/schemas/Tag" }"##

    func testComponentSchemaWithAConstraintImportsTheRuntime() throws {
        let output = try generate(schemas: tag, result: tagRef)
        XCTAssertTrue(output.models.contains("throw CodegenError.validation("), output.models)
        XCTAssertTrue(output.models.hasPrefix("import Foundation\nimport BlocksRuntime\n"), output.models)
    }

    func testModelsThatNameNothingFromTheRuntimeDontImportIt() throws {
        let output = try generate(
            schemas: #"{ "Plain": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] } }"#,
            result: ##"{ "$ref": "#/components/schemas/Plain" }"##
        )
        XCTAssertFalse(output.models.contains("import BlocksRuntime"), output.models)
    }

    /// The generator's list of BlocksRuntime's names is every public type the runtime declares, so a type added there
    /// later can't be named in `Models.swift` without the import.
    func testTheRuntimeNameListCoversEveryPublicRuntimeType() throws {
        let runtime = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("Sources/BlocksRuntime")
        guard let files = FileManager.default.enumerator(at: runtime, includingPropertiesForKeys: nil) else {
            throw XCTSkip("Sources/BlocksRuntime isn't next to the tests")
        }
        let declaration = try NSRegularExpression(
            pattern: #"^public\s+(?:final\s+)?(?:class|struct|enum|protocol|actor|typealias)\s+([A-Za-z_][A-Za-z0-9_]*)"#,
            options: [.anchorsMatchLines]
        )
        var declared: Set<String> = []
        for case let file as URL in files where file.pathExtension == "swift" {
            let source = try String(contentsOf: file, encoding: .utf8)
            for match in declaration.matches(in: source, range: NSRange(source.startIndex..., in: source)) {
                if let range = Range(match.range(at: 1), in: source) { declared.insert(String(source[range])) }
            }
        }
        XCTAssertTrue(declared.contains("CodegenError"), "Found: \(declared.sorted())")
        XCTAssertEqual(declared.subtracting(SwiftCodeGenerator.blocksRuntimeTypeNames).sorted(), [])
    }

    /// Builds `Models.swift` and `API.swift` as their own module and uses the constrained model from another one.
    func testComponentSchemaWithAConstraintCompilesAsItsOwnModule() throws {
        #if os(macOS)
        let output = try generate(schemas: tag, result: tagRef)
        let consumer = """
        import Foundation
        import BlocksRuntime
        import Generated

        func check() throws -> String {
            do {
                _ = try Tag(name: "")
                return "accepted"
            } catch let error as CodegenError {
                return error.message
            }
        }
        """
        try typecheckConsumer(models: output.models, api: output.api, consumer: consumer)
        #else
        throw XCTSkip("Compiling the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
