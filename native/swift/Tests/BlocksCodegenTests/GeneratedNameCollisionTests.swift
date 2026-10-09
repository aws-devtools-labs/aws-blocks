//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// The generator declares names of its own next to the spec's: an operation's locals (`_params`, `request`,
/// `result`, `descriptor`), the API class's `client` property, an open record's `attributes`, a hybrid arm's
/// `challenge`, the types a method body spells (`BlocksRequest`, `JSONDecoder`, …), the API classes and the
/// `Servers` enum. A spec name equal to one of them didn't compile: a parameter named `client` hid the property
/// (`value of type 'String' has no member 'execute'`), and an open record's property `attributes` was declared twice.
/// A spec name that isn't a Swift identifier (`back\slash`) was sanitized but spliced unescaped into string literals
/// (`invalid escape sequence in literal`), and two names that sanitize alike (`a.b`, `a_b`) were declared twice.
///
/// Generated names now step aside (`request_2`, `self.client`, `attributes_2`, `Servers_2`), names Swift can't
/// declare are sanitized and kept unique in their scope, and every wire name keeps its spelling through `CodingKeys`
/// and escaped literals. A name that collides with nothing is unchanged.
final class GeneratedNameCollisionTests: XCTestCase {

    private func generate(
        schemas: String = "{}", methods: [String], servers: String? = nil
    ) throws -> GeneratedSources {
        let json = """
        {
            "openrpc": "1.3.2",
            "info": { "title": "test", "version": "1.0.0" },
            \(servers.map { "\"servers\": \($0)," } ?? "")
            "methods": [\(methods.joined(separator: ", "))],
            "components": { "schemas": \(schemas) }
        }
        """
        let rpcModel = try OpenRPCParser().parse(data: Data(json.utf8))
        return SwiftCodeGenerator().generate(from: CodegenModelBuilder().build(from: rpcModel))
    }

    private func method(_ name: String, params: [String] = [], result: String) -> String {
        """
        { "name": "\(name)", "params": [\(params.joined(separator: ", "))], "result": { "name": "R", "schema": \(result) } }
        """
    }

    /// A parameter: `name` is JSON string content (`back\\slash` for `back\slash`).
    private func param(_ name: String, _ schema: String, required: Bool = true) -> String {
        #"{ "name": "\#(name)", "required": \#(required), "schema": \#(schema) }"#
    }

    private func object(_ properties: [(String, String)], required: [String]? = nil, extras: String? = nil) -> String {
        let props = properties.map { "\"\($0.0)\": \($0.1)" }.joined(separator: ", ")
        let names = (required ?? properties.map(\.0)).map { "\"\($0)\"" }.joined(separator: ", ")
        let additional = extras.map { #", "additionalProperties": \#($0)"# } ?? ""
        return #"{ "type": "object", "properties": { \#(props) }, "required": [\#(names)]\#(additional) }"#
    }

    private func ref(_ name: String) -> String { ##"{ "$ref": "#/components/schemas/\##(name)" }"## }
    private func channel(_ message: String) -> String {
        #"{ "x-blocks-transferable": "realtime/channel", "x-blocks-type-args": [\#(message)] }"#
    }
    private func strings(_ values: [String]) -> String {
        #"{ "type": "string", "enum": [\#(values.map { "\"\($0)\"" }.joined(separator: ", "))] }"#
    }

    private let string = #"{ "type": "string" }"#
    private let dateTime = #"{ "type": "string", "format": "date-time" }"#

    private func assertContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(haystack.contains(needle), "Expected generated code to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    private func assertNotContains(_ haystack: String, _ needle: String, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertFalse(haystack.contains(needle), "Expected generated code not to contain:\n\(needle)\n--- got ---\n\(haystack)", file: file, line: line)
    }

    // MARK: - An operation's body

    func testParameterNamedClientIsSentAndTheBodyReadsThePropertyThroughSelf() throws {
        let output = try generate(methods: [method("api.relay", params: [param("client", string)], result: string)])
        assertContains(output.api, "public func relay(client: String) async throws -> String {")
        assertContains(output.api, #"let request = BlocksRequest(method: "api.relay", params: [client], id: BlocksRequest.nextId())"#)
        assertContains(output.api, "let result = try await self.client.execute(request)")
        assertNotContains(output.api, "try await client.execute")
    }

    func testParameterNamedClientDoesntHideTheClientsDecoder() throws {
        let event = object([("at", dateTime)])
        let output = try generate(methods: [
            method("api.at", params: [param("client", string)], result: event),
            method("api.feed", params: [param("client", string)], result: channel(event))
        ])
        assertContains(output.api, "return try self.client.makeDecoder().decode(At.Result.self, from: result)")
        assertContains(output.api, "fromJSON(descriptor, baseHost: BlocksClient.baseHost) { [client = self.client] data in")
        assertContains(output.api, "try client.makeDecoder().decode(Feed.ResultMessage.self, from: data)")
    }

    func testLocalsStepAsideForParametersOfTheirName() throws {
        let output = try generate(methods: [method("api.send", params: [
            param("request", string), param("result", string),
            param("_params", string, required: false), param("request_2", string, required: false)
        ], result: string)])
        assertContains(
            output.api,
            "public func send(request: String, result: String, _params: String? = nil, request_2: String? = nil) async throws -> String {"
        )
        assertContains(output.api, "var _params_2: [any Encodable] = [request, result]")
        assertContains(output.api, "if let _params { _params_2.append(_params) }")
        assertContains(output.api, "if let request_2 { _params_2.append(request_2) }")
        assertContains(output.api, #"let request_3 = BlocksRequest(method: "api.send", params: _params_2, id: BlocksRequest.nextId())"#)
        assertContains(output.api, "let result_2 = try await client.execute(request_3)")
        assertContains(output.api, #"guard let result_2 else { throw RPCError(message: "Unexpected null result for api.send") }"#)
        assertContains(output.api, "return try JSONDecoder().decode(String.self, from: result_2)")
    }

    func testDescriptorLocalStepsAsideForAParameterOfItsName() throws {
        let output = try generate(methods: [
            method("api.feed", params: [param("descriptor", string)], result: channel(string)),
            method("api.file", params: [param("descriptor", string)], result: #"{ "x-blocks-transferable": "file-bucket/download" }"#)
        ])
        assertContains(output.api, "guard let descriptor_2 = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {")
        assertContains(output.api, "return RealtimeChannel<String>.fromJSON(descriptor_2, baseHost: BlocksClient.baseHost) { data in")
        assertContains(output.api, "return try FileDownloadHandle.fromJSON(descriptor_2)")
    }

    func testParameterNamedLikeATypeTheBodySpellsKeepsItsLabelAndTakesAnInternalName() throws {
        let profile = object([("a", string)])
        let output = try generate(schemas: #"{ "Profile": \#(profile) }"#, methods: [
            method("api.decode", params: [param("JSONDecoder", string), param("BlocksRequest", string)], result: string),
            method("api.profile", params: [param("Profile", ref("Profile"))], result: ref("Profile"))
        ])
        assertContains(output.api, "public func decode(JSONDecoder JSONDecoder_2: String, BlocksRequest BlocksRequest_2: String) async throws -> String {")
        assertContains(output.api, "params: [JSONDecoder_2, BlocksRequest_2]")
        assertContains(output.api, "public func profile(Profile Profile_2: Profile) async throws -> Profile {")
        assertContains(output.api, "params: [Profile_2]")
        assertContains(output.api, "return try JSONDecoder().decode(Profile.self, from: result)")
    }

    func testNamesThatCollideWithNothingAreUnchanged() throws {
        let output = try generate(methods: [method("api.find", params: [param("id", string), param("name", string, required: false)], result: string)])
        assertContains(output.api, """
            /// Calls `api.find`.
            public func find(id: String, name: String? = nil) async throws -> String {
                var _params: [any Encodable] = [id]
                if let name { _params.append(name) }
                let request = BlocksRequest(method: "api.find", params: _params, id: BlocksRequest.nextId())
                let result = try await client.execute(request)
                guard let result else { throw RPCError(message: "Unexpected null result for api.find") }
                return try JSONDecoder().decode(String.self, from: result)
            }
        """)
        assertContains(output.api, """
            private let client: BlocksClient

            public init(server: BlocksServer = Servers.local) {
                self.client = BlocksClient(server: server)
            }
        """)
    }

    // MARK: - The API class

    func testClientPropertyStepsAsideForAnOperationNamedClient() throws {
        let output = try generate(methods: [
            method("api.client", result: string),
            method("api.relay", params: [param("client_2", string)], result: string)
        ])
        assertContains(output.api, "private let client_2: BlocksClient")
        assertContains(output.api, "self.client_2 = BlocksClient(server: server)")
        assertContains(output.api, "public func client() async throws -> String {")
        assertContains(output.api, "let result = try await client_2.execute(request)")
        // `relay`'s parameter `client_2` hides the property, so its body reads it through `self`.
        assertContains(output.api, "public func relay(client_2: String) async throws -> String {")
        assertContains(output.api, "let result = try await self.client_2.execute(request)")
    }

    func testOperationsThatSanitizeAlikeGetDistinctFunctions() throws {
        let output = try generate(methods: [method("a.b.ping", result: string), method("a.b_ping", result: string)])
        assertContains(output.api, "public func b_ping_2() async throws -> String {")
        assertContains(output.api, #"let request = BlocksRequest(method: "a.b.ping", params: [], id: BlocksRequest.nextId())"#)
        assertContains(output.api, "public func b_ping() async throws -> String {")
        assertContains(output.api, #"let request = BlocksRequest(method: "a.b_ping", params: [], id: BlocksRequest.nextId())"#)
    }

    func testOperationEnumStepsAsideForATypeTheClassSpells() throws {
        let item = object([("a", string)])
        let output = try generate(schemas: #"{ "Item": \#(item) }"#, methods: [
            method("api.item", result: object([("b", string)])),
            method("api.useItem", params: [param("i", ref("Item"))], result: ref("Item")),
            method("api.string", result: object([("c", string)]))
        ])
        assertContains(output.api, "public func item() async throws -> Item_2.Result {")
        assertContains(output.api, "public enum Item_2 {")
        assertContains(output.api, "public func useItem(i: Item) async throws -> Item {")
        assertContains(output.api, "public func string() async throws -> String_2.Result {")
        assertContains(output.api, "public enum String_2 {")
        assertNotContains(output.api, "public enum Item {")
        assertNotContains(output.api, "public enum String {")
    }

    func testNamespaceClassStepsAsideForServersAndForAComponentSchema() throws {
        let output = try generate(schemas: #"{ "Api": \#(object([("a", string)])) }"#, methods: [
            method("servers.list", result: string),
            method("api.get", result: ref("Api"))
        ])
        assertContains(output.api, "public class Servers_2 {")
        assertContains(output.api, "public class Api_2 {")
        assertContains(output.api, "public func get() async throws -> Api {")
        assertContains(output.api, "public enum Servers {")
    }

    func testServerNamesAreSanitizedUniqueAndTheirStringsEscaped() throws {
        let output = try generate(
            methods: [method("api.ping", result: string)],
            servers: #"[{ "name": "default", "url": "http://x/\"q\"" }, { "name": "in-progress", "url": "http://a" }, { "name": "inProgress", "url": "http://b" }]"#
        )
        assertContains(output.api, #"public static let `default` = BlocksServer(name: "default", url: "http://x/\"q\"")"#)
        assertContains(output.api, #"public static let inProgress_2 = BlocksServer(name: "in-progress", url: "http://a")"#)
        assertContains(output.api, #"public static let inProgress = BlocksServer(name: "inProgress", url: "http://b")"#)
        assertContains(output.api, "public init(server: BlocksServer = Servers.`default`) {")
    }

    func testMethodNamesAndValidationMessagesAreEscaped() throws {
        let output = try generate(methods: [
            method(#"api.q\"uote"#, params: [param(#"in\\put"#, object([(#"q\"uote"#, #"{ "type": "string", "minLength": 1 }"#)]))], result: string)
        ])
        assertContains(output.api, "public func q_uote(in_put: Q_Uote.In_Put) async throws -> String {")
        assertContains(output.api, #"let request = BlocksRequest(method: "api.q\"uote", params: [in_put], id: BlocksRequest.nextId())"#)
        assertContains(output.api, #"guard let result else { throw RPCError(message: "Unexpected null result for api.q\"uote") }"#)
        assertContains(output.api, #"guard q_uote.count >= 1 else { throw CodegenError.validation("q\"uote must be at least 1 characters") }"#)
        assertContains(output.api, #"case q_uote = "q\"uote""#)
    }

    // MARK: - Models

    func testKeyThatIsNotAnIdentifierIsSanitizedAndKeepsItsWireName() throws {
        let weird = object([(#"back\\slash"#, string), ("a.b", string), ("a_b", string), ("default", string)])
        let output = try generate(schemas: #"{ "Weird": \#(weird) }"#, methods: [method("api.get", result: ref("Weird"))])
        assertContains(output.models, "public let back_slash: String")
        assertContains(output.models, "public let a_b_2: String")
        assertContains(output.models, "public let a_b: String")
        assertContains(output.models, "public let `default`: String")
        assertContains(output.models, #"case back_slash = "back\\slash""#)
        assertContains(output.models, #"case a_b_2 = "a.b""#)
        assertContains(output.models, "case a_b\n")
        assertContains(output.models, "public init(a_b_2: String, a_b: String, back_slash: String, `default`: String) {")
    }

    func testOpenRecordExtrasStepAsideForAPropertyNamedAttributes() throws {
        let bag = object([("attributes", string), (#"back\\slash"#, string)], required: ["attributes"], extras: string)
        let output = try generate(schemas: #"{ "Bag": \#(bag) }"#, methods: [
            method("api.put", params: [param("bag", ref("Bag"))], result: ref("Bag")),
            method("api.inline", result: object([("attributes", string)], extras: string))
        ])
        for code in [output.models, output.api] {
            assertContains(code, "public let attributes: String")
            assertContains(code, "public let attributes_2: [String: String]")
            assertContains(code, "self.attributes_2 = attributes_2")
            assertContains(code, "for (k, v) in self.attributes_2 where !Self.fixedFieldNames.contains(k) {")
            assertContains(code, "self.attributes_2 = extras")
        }
        assertContains(output.models, "public init(attributes: String, back_slash: String? = nil, attributes_2: [String: String] = [:]) {")
        assertContains(output.models, #"        "back\\slash","#)
        assertContains(output.models, #"try c.encodeIfPresent(self.back_slash, forKey: DynamicKey(stringValue: "back\\slash")!)"#)
        assertContains(output.api, "public init(attributes: String, attributes_2: [String: String] = [:]) {")
    }

    func testOpenRecordWithoutAnAttributesPropertyKeepsAttributes() throws {
        let output = try generate(schemas: #"{ "Bag": \#(object([("label", string)], extras: string)) }"#, methods: [
            method("api.get", result: ref("Bag"))
        ])
        assertContains(output.models, "public let attributes: [String: String]")
        assertContains(output.models, "public init(label: String, attributes: [String: String] = [:]) {")
        assertNotContains(output.models, "attributes_2")
    }

    func testHybridArmsNestedUnionStepsAsideForAPropertyNamedChallenge() throws {
        let code = object([("kind", strings(["code"])), ("code", string)])
        let skip = object([("kind", strings(["skip"]))])
        let confirm = #"""
        { "type": "object", "properties": { "action": \#(strings(["confirm"])), "challenge": \#(string) },
          "required": ["action", "challenge"], "oneOf": [\#(code), \#(skip)] }
        """#
        let other = object([("action", strings(["other"]))])
        let output = try generate(methods: [
            method("api.act", params: [param("input", #"{ "oneOf": [\#(confirm), \#(other)] }"#)], result: string)
        ])
        assertContains(output.api, "public let challenge: String")
        assertContains(output.api, "public let challenge_2: ConfirmKind")
        assertContains(output.api, "public init(challenge: String, challenge_2: ConfirmKind) {")
        assertContains(output.api, "self.challenge_2 = challenge_2")
        assertContains(output.api, "try self.challenge_2.encode(to: encoder)")
        assertContains(output.api, "self.challenge_2 = try ConfirmKind(from: decoder)")
    }

    func testEnumCasesAreSanitizedUniqueAndTheirRawValuesEscaped() throws {
        let output = try generate(schemas: #"{ "E": \#(strings([#"back\\slash"#, #"q\"uote"#, "default", "inProgress", "in-progress"])) }"#,
                                  methods: [method("api.get", result: ref("E"))])
        assertContains(output.models, #"case back_slash = "back\\slash""#)
        assertContains(output.models, #"case q_uote = "q\"uote""#)
        assertContains(output.models, "case `default`\n")
        assertContains(output.models, "case inProgress\n")
        assertContains(output.models, #"case inProgress_2 = "in-progress""#)
    }

    func testDiscriminatorKeyThatIsNotAnIdentifierKeepsItsWireName() throws {
        let first = object([(#"back\\slash"#, #"{ "const": "default" }"#), ("x", string)])
        let second = object([(#"back\\slash"#, #"{ "const": "other" }"#), ("y", string)])
        let union = #"{ "oneOf": [\#(first), \#(second)], "discriminator": { "propertyName": "back\\slash" } }"#
        let output = try generate(schemas: #"{ "U": \#(union) }"#, methods: [method("api.get", result: ref("U"))])
        assertContains(output.models, #"case back_slash = "back\\slash""#)
        assertContains(output.models, "case `default`(Default)")
        assertContains(output.models, "case .`default`(let params):")
        assertContains(output.models, #"case "default": self = .`default`(try Default(from: decoder))"#)
        assertContains(output.models, #"try container.encode("other", forKey: .back_slash)"#)
    }

    func testVariantNamedLikeAKeywordTypeIsPrefixedWithItsDiscriminator() throws {
        let first = object([("kind", #"{ "const": "self" }"#), ("x", string)])
        let second = object([("kind", #"{ "const": "plain" }"#), ("y", string)])
        let union = #"{ "oneOf": [\#(first), \#(second)], "discriminator": { "propertyName": "kind" } }"#
        let output = try generate(schemas: #"{ "U": \#(union) }"#, methods: [method("api.get", result: ref("U"))])
        assertContains(output.models, "public struct KindSelf: Codable {")
        assertContains(output.models, "case kindSelf(KindSelf)")
        assertContains(output.models, "case plain(Plain)")
        assertNotContains(output.models, "struct Self")
    }

    // MARK: - Round trip

    func testCollidingNamesCompileAndKeepTheirWireNamesFromOutsideTheModule() throws {
        #if os(macOS)
        let weird = object([(#"back\\slash"#, string), ("a.b", string), ("a_b", string), ("default", string)])
        let bag = object([("attributes", string), (#"back\\slash"#, string)], required: ["attributes"], extras: string)
        let kind = strings([#"back\\slash"#, "default", "inProgress", "in-progress"])
        let kinds = #"{ "type": "array", "items": \#(ref("Kind")) }"#
        let output = try generate(
            schemas: #"{ "Weird": \#(weird), "Bag": \#(bag), "Kind": \#(kind) }"#,
            methods: [
                method("api.relay", params: [param("client", string), param("result", string), param("request", string, required: false)], result: string),
                method("api.getWeird", params: [param("weird", ref("Weird"))], result: ref("Weird")),
                method("api.putBag", params: [param("bag", ref("Bag"))], result: ref("Bag")),
                method("api.kinds", params: [param("kind", kinds)], result: kinds),
                method("api.decode", params: [param("JSONDecoder", string)], result: string),
                method("api.b.ping", result: string),
                method("other.client", params: [param("client", string)], result: string)
            ]
        )
        let main = ##"""
        import Foundation
        import BlocksRuntime
        import Generated

        \##(Self.jsonRPCServerSource)

        let port = startJSONRPCServer { method, params, body in
            // The parameters as the server reads them, normalized with sorted keys, so the check holds whatever order the encoder writes keys in.
            let sent = (try? JSONSerialization.data(withJSONObject: params, options: [.sortedKeys])).map { String(decoding: $0, as: UTF8.self) }
            print("sent \(method): \(sent ?? body)")
            // Echo the first parameter back: what the client sent is what the server would return.
            guard let first = params.first,
                  let data = try? JSONSerialization.data(withJSONObject: first, options: [.fragmentsAllowed, .sortedKeys])
            else { return #""pong""# }
            return String(decoding: data, as: UTF8.self)
        }
        let server = BlocksServer(name: "local", url: "http://127.0.0.1:\(port)/aws-blocks/api")
        let api = Api(server: server)
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        func json<T: Encodable>(_ value: T) throws -> String { String(decoding: try encoder.encode(value), as: UTF8.self) }
        do {
            print(try await api.relay(client: "c", result: "r", request: "q"))
            print(try await api.relay(client: "c", result: "r"))
            let weird = try await api.getWeird(weird: Weird(a_b_2: "dot", a_b: "under", back_slash: "s", default: "d"))
            print("\(weird.back_slash) \(weird.a_b_2) \(weird.a_b) \(weird.default)")
            let bag = try await api.putBag(bag: Bag(attributes: "typed", back_slash: "s", attributes_2: ["extra": "e", "attributes": "dropped"]))
            print("\(bag.attributes) \(bag.back_slash ?? "nil") \(bag.attributes_2)")
            print(try json(try await api.kinds(kind: [.back_slash, .default, .inProgress, .inProgress_2])))
            print(try await api.decode(JSONDecoder: "j"))
            print(try await api.b_ping())
            print(try await Other(server: server).client(client: "o"))
        } catch {
            print("error: \(error)")
        }
        """##
        guard let run = try runConsumer(models: output.models, api: output.api, main: main) else { return }

        XCTAssertFalse(run.compilerOutput.contains("warning:"), "The generated module compiled with warnings:\n\(run.compilerOutput)")
        XCTAssertEqual(run.output.split(separator: "\n").map(String.init), [
            #"sent api.relay: ["c","r","q"]"#,
            "c",
            #"sent api.relay: ["c","r"]"#,
            "c",
            #"sent api.getWeird: [{"a_b":"under","a.b":"dot","back\\slash":"s","default":"d"}]"#,
            "s dot under d",
            #"sent api.putBag: [{"attributes":"typed","back\\slash":"s","extra":"e"}]"#,
            #"typed s ["extra": "e"]"#,
            #"sent api.kinds: [["back\\slash","default","inProgress","in-progress"]]"#,
            #"["back\\slash","default","inProgress","in-progress"]"#,
            #"sent api.decode: ["j"]"#,
            "j",
            #"sent api.b.ping: []"#,
            "pong",
            #"sent other.client: ["o"]"#,
            "o"
        ])
        #else
        throw XCTSkip("Compiling and running the generated module needs the host toolchain (macOS only).")
        #endif
    }
}
