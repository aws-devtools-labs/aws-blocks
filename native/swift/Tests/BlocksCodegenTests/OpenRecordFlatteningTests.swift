//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// An open record (an object schema with `properties` and `additionalProperties`, TypeScript
/// `T & Record<string, V>`) collects its extra keys in `attributes`, and they go on the wire flat, beside the
/// properties. Only component schemas did that. An operation-scoped record (fixture 07's `Api.SignUp.Input`) or a
/// union variant (fixture 18's `AuthApi.SetAuthState.SignUp`, the `Auth` block's `signUp` action) used
/// synthesized `Codable`, which nested the extra keys under an `"attributes"` key, and had no `public init`, so an
/// app couldn't construct one. The server reads sign-up attributes with a rest spread, so it stored one attribute
/// named `attributes` holding an object, and the user had no email.
final class OpenRecordFlatteningTests: XCTestCase {

    private var fixturesURL: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("codegen-fixtures")
    }

    private func spec(_ fixture: String) throws -> [String: Any] {
        let data = try Data(contentsOf: fixturesURL.appendingPathComponent(fixture).appendingPathComponent("spec.json"))
        return try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    /// A union variant with `additionalProperties` and no discriminator, an open record nested in an operation's
    /// inline parameter, an operation-scoped open result whose property is a Swift keyword and whose values are a
    /// component schema, and a component open record.
    private let extraSpec = """
    { "openrpc": "1.3.2", "info": { "title": "t", "version": "1" },
      "methods": [
        { "name": "extra.tag", "params": [{ "name": "input", "required": true, "schema": { "anyOf": [
            { "type": "object", "properties": { "label": { "type": "string" } }, "required": ["label"],
              "additionalProperties": { "type": "integer" } },
            { "type": "string" } ] } }],
          "result": { "name": "R", "schema": { "type": "boolean" } } },
        { "name": "extra.profile", "params": [{ "name": "input", "required": true, "schema": { "type": "object",
            "properties": {
              "name": { "type": "string" },
              "prefs": { "type": "object", "properties": { "theme": { "type": "string" } },
                         "additionalProperties": { "type": "boolean" } } },
            "required": ["name", "prefs"] } }],
          "result": { "name": "R", "schema": { "type": "object", "properties": { "default": { "type": "string" } },
            "additionalProperties": { "$ref": "#/components/schemas/Note" } } } },
        { "name": "extra.directory", "params": [],
          "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Directory" } } }
      ],
      "components": { "schemas": {
        "Note": { "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] },
        "Directory": { "type": "object", "properties": { "owner": { "type": "string" } }, "required": ["owner"],
                       "additionalProperties": { "$ref": "#/components/schemas/Note" } }
      } } }
    """

    private func generate(_ spec: [String: Any]) throws -> GeneratedSources {
        let data = try JSONSerialization.data(withJSONObject: spec)
        let rpcModel = try OpenRPCParser().parse(data: data)
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func generate(fixture: String) throws -> GeneratedSources {
        try generate(spec(fixture))
    }

    /// Fixtures 07 and 18 and `extraSpec` in one spec (their namespaces and schema names don't overlap), so one
    /// module holds every scope.
    private func mergedSpec() throws -> [String: Any] {
        var merged = try spec("07-maps-and-records")
        let parts = [try spec("18-hybrid-arm"), try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(extraSpec.utf8)) as? [String: Any])]
        var methods = merged["methods"] as? [Any] ?? []
        var schemas = (merged["components"] as? [String: Any])?["schemas"] as? [String: Any] ?? [:]
        for part in parts {
            methods += part["methods"] as? [Any] ?? []
            let partSchemas = (part["components"] as? [String: Any])?["schemas"] as? [String: Any] ?? [:]
            schemas.merge(partSchemas) { first, _ in first }
        }
        merged["methods"] = methods
        merged["components"] = ["schemas": schemas]
        return merged
    }

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func occurrences(of needle: String, in haystack: String) -> Int {
        haystack.components(separatedBy: needle).count - 1
    }

    // MARK: - The emitted code

    func testOperationScopedOpenRecordHasAPublicInitAndFlatCoding() throws {
        let output = try generate(fixture: "07-maps-and-records")
        assertContains(output.api, """
                public struct Input: Codable {
                    public let password: String
                    public let username: String
                    public let attributes: [String: String]

                    public init(password: String, username: String, attributes: [String: String] = [:]) {
                        self.password = password
                        self.username = username
                        self.attributes = attributes
                    }
        """)
        assertContains(output.api, """
                    public func encode(to encoder: Encoder) throws {
                        var c = encoder.container(keyedBy: DynamicKey.self)
                        try c.encode(self.password, forKey: DynamicKey(stringValue: "password")!)
                        try c.encode(self.username, forKey: DynamicKey(stringValue: "username")!)
                        for (k, v) in self.attributes where !Self.fixedFieldNames.contains(k) {
                            try c.encode(v, forKey: DynamicKey(stringValue: k)!)
                        }
                    }
        """)
    }

    func testDiscriminatedVariantOpenRecordTreatsTheDiscriminatorAsAFixedKey() throws {
        let output = try generate(fixture: "18-hybrid-arm")
        assertContains(output.api, """
                public struct SignUp: Codable {
                    public let password: String
                    public let username: String
                    public let attributes: [String: String]

                    public init(password: String, username: String, attributes: [String: String] = [:]) {
        """)
        // `action` is written by the union, so it is neither read into `attributes` nor sent from it.
        assertContains(output.api, """
                    private static let fixedFieldNames: Set<String> = [
                        "password",
                        "username",
                        "action",
                    ]
        """)
    }

    func testUnionVariantAndNestedOpenRecordsFlatten() throws {
        let output = try generate(try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(extraSpec.utf8)) as? [String: Any]))
        assertContains(output.api, "            public init(label: String, attributes: [String: Int] = [:]) {")
        assertContains(output.api, "                public init(theme: String? = nil, attributes: [String: Bool] = [:]) {")
        assertContains(output.api, "            public init(`default`: String? = nil, attributes: [String: Note] = [:]) {")
        // Each of the three operation-scoped open records, and the component one, has the flat coding.
        XCTAssertEqual(occurrences(of: "private struct DynamicKey: CodingKey", in: output.api), 3, output.api)
        XCTAssertEqual(occurrences(of: "private struct DynamicKey: CodingKey", in: output.models), 1, output.models)
        // No synthesized `attributes` key: every open record is decoded by its own `init(from:)`.
        XCTAssertEqual(occurrences(of: "public let attributes: [String:", in: output.api), 3)
        XCTAssertEqual(occurrences(of: "self.attributes = extras", in: output.api), 3)
    }

    func testComponentOpenRecordKeepsItsCodingAndSkipsAttributesNamedLikeAProperty() throws {
        let output = try generate(try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(extraSpec.utf8)) as? [String: Any]))
        assertContains(output.models, """
        public struct Directory: Codable {
            public let owner: String
            public let attributes: [String: Note]

            public init(owner: String, attributes: [String: Note] = [:]) {
                self.owner = owner
                self.attributes = attributes
            }
        """)
        assertContains(output.models, """
                try c.encode(self.owner, forKey: DynamicKey(stringValue: "owner")!)
                for (k, v) in self.attributes where !Self.fixedFieldNames.contains(k) {
        """)
        // A component open record isn't a union variant, so nothing but its properties is fixed.
        assertContains(output.models, """
            private static let fixedFieldNames: Set<String> = [
                "owner",
            ]
        """)
    }

    func testEveryPublicStructInEveryScopeHasAPublicInit() throws {
        let output = try generate(try mergedSpec())
        for source in [output.models, output.api] {
            let structs = occurrences(of: "public struct ", in: source)
            XCTAssertGreaterThan(structs, 0)
            // One memberwise init per struct; the other initializers are decoders and the API classes'.
            let inits = occurrences(of: "public init(", in: source)
                - occurrences(of: "public init(from decoder: Decoder)", in: source)
                - occurrences(of: "public init(server: BlocksServer", in: source)
            XCTAssertEqual(inits, structs, source)
        }
    }

    // MARK: - Compiled, from outside the module

    /// Builds fixtures 07 and 18 and `extraSpec` as one module and, from a separate executable, constructs each
    /// open record with its public init, encodes it (flat, the discriminator first-class, an attribute named like
    /// a property or the discriminator dropped), sends it in a request, and decodes it back.
    func testOpenRecordsRoundTripFlatFromOutsideTheModule() throws {
        #if os(macOS)
        let output = try generate(try mergedSpec())
        let main = #"""
        import Foundation
        import BlocksRuntime
        import Generated

        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func encoded<T: Encodable>(_ value: T) throws -> String {
            String(decoding: try encoder.encode(value), as: UTF8.self)
        }
        func decoded<T: Decodable>(_ json: String, as type: T.Type) throws -> T {
            try JSONDecoder().decode(T.self, from: Data(json.utf8))
        }
        func sorted<V>(_ attributes: [String: V]) -> String {
            attributes.keys.sorted().map { "\($0)=\(attributes[$0]!)" }.joined(separator: ",")
        }

        // Fixture 07: an operation's inline parameter.
        let input = Api.SignUp.Input(password: "pw", username: "ada", attributes: ["email": "ada@example.com", "name": "Ada"])
        print(try encoded(input))
        print(try encoded(BlocksRequest(method: "api.signUp", params: [input], id: 1)))
        print(try encoded(Api.SignUp.Input(password: "pw", username: "ada", attributes: ["username": "eve", "x": "y"])))
        let back = try decoded(#"{"custom:team":"engines","password":"pw","username":"ada"}"#, as: Api.SignUp.Input.self)
        print(back.username, back.password, sorted(back.attributes))

        // Fixture 18: the `Auth` block's `signUp` action, a variant of a discriminated union.
        let signUp = AuthApi.SetAuthState.Input.signUp(
            AuthApi.SetAuthState.SignUp(password: "pw", username: "ada", attributes: ["email": "ada@example.com", "name": "Ada"])
        )
        print(try encoded(signUp))
        print(try encoded(BlocksRequest(method: "authApi.setAuthState", params: [signUp], id: 2)))
        let smuggled = AuthApi.SetAuthState.Input.signUp(
            AuthApi.SetAuthState.SignUp(password: "pw", username: "ada", attributes: ["action": "signIn", "email": "e"])
        )
        print(try encoded(smuggled))
        let wire = #"{"action":"signUp","email":"ada@example.com","name":"Ada","password":"pw","username":"ada"}"#
        if case .signUp(let value) = try decoded(wire, as: AuthApi.SetAuthState.Input.self) {
            print(value.username, value.password, sorted(value.attributes))
        }
        print(try encoded(AuthApi.SetAuthState.Input.signIn(AuthApi.SetAuthState.SignIn(password: "pw", username: "ada"))))

        // A union variant without a discriminator, a nested open record, a keyword property, a component.
        print(try encoded(Extra.Tag.Input.input_Variant0(Extra.Tag.Input_Variant0(label: "l", attributes: ["n": 1]))))
        if case .input_Variant0(let tag) = try decoded(#"{"label":"l","n":2}"#, as: Extra.Tag.Input.self) {
            print(tag.label, sorted(tag.attributes))
        }
        if case .input_Variant1(let text) = try decoded(#""plain""#, as: Extra.Tag.Input.self) {
            print(text)
        }
        let profile = Extra.Profile.Input(name: "n", prefs: Extra.Profile.Input.Prefs(theme: nil, attributes: ["dark": true]))
        print(try encoded(profile))
        let result = try decoded(#"{"default":"d","a":{"text":"t"}}"#, as: Extra.Profile.Result.self)
        print(result.default ?? "nil", result.attributes["a"]?.text ?? "nil", try encoded(result))
        print(try encoded(Directory(owner: "o", attributes: ["owner": Note(text: "x"), "a": Note(text: "t")])))
        """#
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"{"email":"ada@example.com","name":"Ada","password":"pw","username":"ada"}"#,
            #"{"id":1,"jsonrpc":"2.0","method":"api.signUp","params":[{"email":"ada@example.com","name":"Ada","password":"pw","username":"ada"}]}"#,
            #"{"password":"pw","username":"ada","x":"y"}"#,
            "ada pw custom:team=engines",
            #"{"action":"signUp","email":"ada@example.com","name":"Ada","password":"pw","username":"ada"}"#,
            #"{"id":2,"jsonrpc":"2.0","method":"authApi.setAuthState","params":"#
                + #"[{"action":"signUp","email":"ada@example.com","name":"Ada","password":"pw","username":"ada"}]}"#,
            #"{"action":"signUp","email":"e","password":"pw","username":"ada"}"#,
            "ada pw email=ada@example.com,name=Ada",
            #"{"action":"signIn","password":"pw","username":"ada"}"#,
            #"{"label":"l","n":1}"#,
            "l n=2",
            "plain",
            #"{"name":"n","prefs":{"dark":true}}"#,
            #"d t {"a":{"text":"t"},"default":"d"}"#,
            #"{"a":{"text":"t"},"owner":"o"}"#
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
