//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Every generated `public struct` carries a `public init`. Swift's synthesized memberwise initializer is
/// `internal`, so without one, code outside the generated module (an app that keeps the generated client in its
/// own Swift package, a test target, a preview) couldn't construct a model, for example to pass it as an RPC
/// parameter. The init takes the properties in declaration order, with the synthesized init's labels, and
/// optional properties default to `nil`.
final class PublicInitTests: XCTestCase {

    private func generate(schemas: String = "{}", methods: String) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            "methods": \(methods),
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func method(_ name: String, params: String = "[]", returning ref: String) -> String {
        """
        { "name": "api.\(name)", "params": \(params),
          "result": { "name": "R", "schema": { "$ref": "#/components/schemas/\(ref)" } } }
        """
    }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func occurrences(of needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    /// Component schemas (`Note`, its inline-object property `Note.Meta`, an empty `Marker`, a `Keyword` whose
    /// properties are Swift keywords) and a union with
    /// inline variants (`Shape`, whose payloads are `Circle` and `Square`), plus an operation with an inline
    /// object parameter (`CreateNote.Input`) and an inline union parameter (`DoAction.Input`).
    private let schemas = """
    {
        "Note": { "type": "object", "properties": {
            "id": { "type": "string" },
            "title": { "type": "string" },
            "body": { "type": "string" },
            "archivedAt": { "oneOf": [{ "type": "string" }, { "type": "null" }] },
            "meta": { "type": "object", "properties": {
                "pinned": { "type": "boolean" },
                "color": { "type": "string" }
            }, "required": ["pinned"] }
        }, "required": ["id", "title", "archivedAt", "meta"] },
        "Marker": { "type": "object", "properties": {} },
        "Keyword": { "type": "object", "properties": {
            "self": { "type": "string" }, "type": { "type": "string" }
        }, "required": ["self"] },
        "Shape": { "oneOf": [
            { "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["circle"] }, "radius": { "type": "number" }
            }, "required": ["kind", "radius"] },
            { "type": "object", "properties": {
                "kind": { "type": "string", "enum": ["square"] }, "side": { "type": "number" }, "label": { "type": "string" }
            }, "required": ["kind", "side"] }
        ] }
    }
    """

    private var methods: String {
        let createNote = """
        { "name": "api.createNote", "params": [{ "name": "input", "required": true, "schema": {
            "type": "object", "properties": {
                "title": { "type": "string" }, "tags": { "type": "array", "items": { "type": "string" } }
            }, "required": ["title"] } }],
          "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Note" } } }
        """
        let doAction = """
        { "name": "api.doAction", "params": [{ "name": "input", "required": true, "schema": { "oneOf": [
            { "type": "object", "properties": {
                "action": { "type": "string", "enum": ["create"] }, "title": { "type": "string" }
            }, "required": ["action", "title"] },
            { "type": "object", "properties": {
                "action": { "type": "string", "enum": ["delete"] }, "id": { "type": "string" }
            }, "required": ["action", "id"] }
        ] } }],
          "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Marker" } } }
        """
        return "[\(createNote), \(doAction), \(method("getShape", returning: "Shape"))]"
    }

    // MARK: - The emitted initializers

    func testComponentSchemaGetsAPublicInitWithOptionalsDefaultingToNil() throws {
        let output = try generate(schemas: schemas, methods: methods)
        // Declaration order (the properties are sorted), the synthesized labels; `body` is optional and
        // `archivedAt` is nullable, so both default to `nil`.
        assertContains(output.models, """
            public init(archivedAt: String? = nil, body: String? = nil, id: String, meta: Meta, title: String) {
                self.archivedAt = archivedAt
                self.body = body
                self.id = id
                self.meta = meta
                self.title = title
            }
        """)
    }

    func testInlineObjectPropertyGetsAPublicInit() throws {
        let output = try generate(schemas: schemas, methods: methods)
        assertContains(output.models, """
            public struct Meta: Codable {
                public let color: String?
                public let pinned: Bool
        """)
        assertContains(output.models, """
                public init(color: String? = nil, pinned: Bool) {
                    self.color = color
                    self.pinned = pinned
                }
            }
        }
        """)
    }

    func testEmptyStructGetsAPublicInit() throws {
        let output = try generate(schemas: schemas, methods: methods)
        assertContains(output.models, """
        public struct Marker: Codable {

            public init() {
            }
        }
        """)
    }

    func testUnionVariantPayloadStructsGetAPublicInit() throws {
        let output = try generate(schemas: schemas, methods: methods)
        assertContains(output.models, "    public init(radius: Double) {")
        assertContains(output.models, "    public init(label: String? = nil, side: Double) {")
    }

    func testOperationInlineParameterGetsAPublicInit() throws {
        let output = try generate(schemas: schemas, methods: methods)
        assertContains(output.api, """
                    public init(tags: [String]? = nil, title: String) {
                        self.tags = tags
                        self.title = title
                    }
        """)
    }

    func testOperationInlineUnionVariantsGetAPublicInit() throws {
        let output = try generate(schemas: schemas, methods: methods)
        assertContains(output.api, "            public init(title: String) {")
        assertContains(output.api, "            public init(id: String) {")
    }

    func testEveryPublicStructHasAPublicInit() throws {
        let output = try generate(schemas: schemas, methods: methods)
        for source in [output.models, output.api] {
            let structs = occurrences(of: "public struct ", in: source)
            XCTAssertGreaterThan(structs, 0)
            // One memberwise init per struct. None of these structs needs a custom decoder, so the other
            // initializers are the unions' decoders and the API class's.
            let inits = occurrences(of: "public init(", in: source)
                - occurrences(of: "public init(from decoder: Decoder)", in: source)
                - occurrences(of: "public init(server: BlocksServer", in: source)
            XCTAssertEqual(inits, structs, source)
        }
    }

    func testPropertyNamedSelfDoesNotShadowTheInstance() throws {
        let output = try generate(schemas: schemas, methods: methods)
        // A parameter named `self` would shadow the instance, so `self.x = x` would assign to the parameter.
        assertContains(output.models, """
            public init(`self` self_: String, `type`: String? = nil) {
                self.`self` = self_
                self.`type` = `type`
            }
        """)
    }

    func testConstrainedStructKeepsASingleThrowingInit() throws {
        let output = try generate(schemas: """
        { "Tag": { "type": "object", "properties": {
            "name": { "type": "string", "minLength": 1 }, "note": { "type": "string" }
        }, "required": ["name"] } }
        """, methods: "[\(method("getTag", returning: "Tag"))]")
        XCTAssertEqual(occurrences(of: "public init(", in: output.models), 1, output.models)
        assertContains(output.models, "    public init(name: String, note: String? = nil) throws {")
    }

    // MARK: - A consumer in another module

    /// Compiles the generated sources as their own module and type-checks a consumer in a second module that
    /// constructs every kind of generated struct, encodes it and decodes it. This is the setup that failed before:
    /// a synthesized memberwise init is `internal`, so the consumer's initializer calls didn't compile.
    func testConsumerInAnotherModuleConstructsModels() throws {
        #if os(macOS)
        let output = try generate(schemas: schemas, methods: methods)
        let consumer = """
        import Foundation
        import Generated

        func makeModels() throws {
            let note = Note(archivedAt: nil, body: "b", id: "n1", meta: Note.Meta(pinned: true), title: "t")
            _ = Note(id: "n2", meta: Note.Meta(color: "red", pinned: false), title: "t")
            let decoded = try JSONDecoder().decode(Note.self, from: try JSONEncoder().encode(note))
            _ = decoded.meta.pinned
            _ = Marker()
            _ = Keyword(self: "s", type: "t")
            _ = Shape.circle(Circle(radius: 1))
            _ = Shape.square(Square(side: 2))
            _ = Shape.square(Square(label: "s", side: 2))
            _ = Api.CreateNote.Input(title: "t")
            _ = Api.CreateNote.Input(tags: ["a"], title: "t")
            _ = Api.DoAction.Input.create(Api.DoAction.Create(title: "t"))
            _ = Api.DoAction.Input.delete(Api.DoAction.Delete(id: "n1"))
        }
        """
        try typecheckConsumer(models: output.models, api: output.api, consumer: consumer)
        #else
        throw XCTSkip("Compiling a second module needs the host toolchain (macOS only).")
        #endif
    }
}
