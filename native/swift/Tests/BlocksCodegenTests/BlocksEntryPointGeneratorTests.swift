//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import XCTest
@testable import BlocksCodegen

/// Inline specs: no shared fixture declares servers or colliding namespace names.
final class BlocksEntryPointGeneratorTests: XCTestCase {
    private var swiftPackageURL: URL {
        URL(fileURLWithPath: #filePath).deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
    }

    private func generate(namespaces: [String] = ["todos", "authCognito"], servers: String? = nil) throws -> GeneratedSources {
        let methods = namespaces.map { namespace in
            let name = namespace.isEmpty ? "ping" : "\(namespace).ping"
            return #"{ "name": "\#(name)", "params": [], "result": { "name": "R", "schema": { "type": "string" } } }"#
        }
        let serversLine = servers.map { #""servers": \#($0),"# } ?? ""
        let json = """
        { "openrpc": "1.3.2", "info": { "title": "test", "version": "1.0.0" }, \(serversLine)
          "methods": [\(methods.joined(separator: ","))] }
        """
        return try generate(json)
    }

    private func generate(_ json: String) throws -> GeneratedSources {
        let model = try CodegenModelBuilder().build(from: OpenRPCParser().parse(data: Data(json.utf8)))
        return SwiftCodeGenerator().generate(from: model)
    }

    func testNamespaceClassTakesTheSharedClient() throws {
        let api = try generate().api
        XCTAssertTrue(api.contains("""
        public final nonisolated class Todos: Sendable {
            private let client: BlocksClient

            public init(client: BlocksClient) {
                self.client = client
            }
        """))
        XCTAssertFalse(api.contains("self.client = BlocksClient(server: server)"))
    }

    func testDeprecatedServerInitTeachesHoldingOneInstance() throws {
        let api = try generate().api
        XCTAssertTrue(api.contains("""
            @available(*, deprecated, message: "Use blocks.todos from one Blocks() or Blocks(server:) you hold")
            public convenience init(server: BlocksServer = Servers.local) {
                self.init(client: BlocksClient(server: server))
            }
        """))
    }

    func testBlocksStoresOnePropertyPerNamespace() throws {
        let api = try generate().api
        XCTAssertEqual(api.components(separatedBy: "public final nonisolated class Blocks: Sendable {").count, 2)
        XCTAssertTrue(api.contains("    public let authCognito: AuthCognito\n    public let todos: Todos\n"))
        XCTAssertTrue(api.contains("        self.authCognito = .init(client: client)\n        self.todos = .init(client: client)\n"))
        XCTAssertTrue(api.contains("    public func close() {\n        client.close()\n    }"))
    }

    func testBlocksQualifiesTheRuntimeTypesItNames() throws {
        let api = try generate().api
        XCTAssertTrue(api.contains("""
            public init(
                server: BlocksRuntime.BlocksServer = Servers.local,
                session: URLSession? = nil,
                tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()
            ) {
                self.server = server
                self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)
        """))
    }

    // Generated code compiles in the app's target, so its top-level types opt out of a MainActor default isolation.
    func testEveryTopLevelTypeIsNonisolated() throws {
        let output = try generate("""
        { "openrpc": "1.3.2", "info": { "title": "test", "version": "1.0.0" },
          "methods": [{ "name": "todos.get", "params": [], "result": { "name": "R", "schema": { "$ref": "#/components/schemas/Todo" } } }],
          "components": { "schemas": {
            "Todo": { "type": "object", "properties": { "status": { "$ref": "#/components/schemas/Status" } }, "required": ["status"] },
            "Status": { "type": "string", "enum": ["open", "done"] }
          } } }
        """)
        let topLevel = (output.api + "\n" + output.models).split(separator: "\n").filter { $0.hasPrefix("public ") }
        XCTAssertEqual(Set(topLevel), [
            "public final nonisolated class Todos: Sendable {",
            "public final nonisolated class Blocks: Sendable {",
            "public nonisolated enum Servers {",
            "public nonisolated struct Todo: Codable {",
            "public nonisolated enum Status: String, Codable {"
        ])
        let members = (output.api + output.models).split(separator: "\n").filter { $0.hasPrefix(" ") && $0.contains("nonisolated") }
        XCTAssertEqual(members, [], "members inherit nonisolated from their type")
    }

    func testDefaultsFollowTheFirstOfSeveralServers() throws {
        let sandbox = #"{ "name": "sandbox", "url": "https://a.example/prod/aws-blocks/api" }"#
        let local = #"{ "name": "local", "url": "http://localhost:3001/aws-blocks/api" }"#
        let sandboxFirst = try generate(servers: "[\(sandbox), \(local)]").api
        XCTAssertTrue(sandboxFirst.contains("        server: BlocksRuntime.BlocksServer = Servers.sandbox,"))
        XCTAssertTrue(sandboxFirst.contains("    public convenience init(server: BlocksServer = Servers.sandbox) {"))
        XCTAssertFalse(sandboxFirst.contains("= Servers.local"))
        let localFirst = try generate(servers: "[\(local), \(sandbox)]").api
        XCTAssertTrue(localFirst.contains("        server: BlocksRuntime.BlocksServer = Servers.local,"))
        XCTAssertFalse(localFirst.contains("= Servers.sandbox"))
    }

    func testWithoutServersTheDefaultIsTheFullLocalRpcUrl() throws {
        let api = try generate().api
        XCTAssertTrue(api.contains(#"public static let local = BlocksServer(name: "local", url: "http://localhost:3001/aws-blocks/api")"#))
    }

    func testServerUrlsAreEmittedVerbatim() throws {
        let api = try generate(servers: #"[{ "name": "sandbox", "url": "https://a.example/prod/aws-blocks/api" }]"#).api
        XCTAssertTrue(api.contains(#"url: "https://a.example/prod/aws-blocks/api")"#))
        XCTAssertFalse(api.contains("/aws-blocks/api/aws-blocks/api"))
    }

    func testServerNamedDefaultIsBacktickedWhereDeclaredAndUsed() throws {
        let api = try generate(servers: #"[{ "name": "default", "url": "https://a.example/aws-blocks/api" }]"#).api
        XCTAssertTrue(api.contains(#"public static let `default` = BlocksServer(name: "default", url: "https://a.example/aws-blocks/api")"#))
        XCTAssertTrue(api.contains("        server: BlocksRuntime.BlocksServer = Servers.`default`,"))
    }

    func testServerNameAndUrlAreEscapedLiterals() throws {
        let api = try generate(servers: #"[{ "name": "q\"b\\", "url": "https://a.example/\"/aws-blocks/api" }]"#).api
        XCTAssertTrue(api.contains(#"BlocksServer(name: "q\"b\\", url: "https://a.example/\"/aws-blocks/api")"#))
    }

    func testNamespacesNamedLikeBlocksMembersAreSuffixed() throws {
        let output = try generate(namespaces: ["client", "clientApi", "server", "close", "self", "init"])
        for line in ["public let clientApiApi: Client", "public let clientApi: ClientApi", "public let serverApi: Server",
                     "public let closeApi: Close", "public let selfApi: SelfApi", "public let initApi: Init"] {
            XCTAssertTrue(output.api.contains("    \(line)\n"), line)
        }
        XCTAssertTrue(output.warnings.contains("swift: namespace 'server' is reached as blocks.serverApi; server is taken."))
        XCTAssertTrue(output.warnings.contains("swift: namespace 'self' generates class SelfApi; Self is reserved."))
        XCTAssertFalse(output.warnings.contains { $0.contains("'clientApi'") })
    }

    func testNamespacesNamedLikeGeneratedTypesGetAnApiSuffix() throws {
        let output = try generate(namespaces: ["blocks", "servers", "blocksRuntime"])
        for className in ["BlocksApi", "ServersApi", "BlocksRuntimeApi"] {
            XCTAssertTrue(output.api.contains("public final nonisolated class \(className): Sendable {"), className)
        }
        let properties = "    public let blocks: BlocksApi\n    public let blocksRuntime: BlocksRuntimeApi\n    public let servers: ServersApi\n"
        XCTAssertTrue(output.api.contains(properties))
        XCTAssertEqual(output.api.components(separatedBy: "public final nonisolated class Blocks: Sendable {").count, 2)
        XCTAssertTrue(output.warnings.contains("swift: namespace 'blocks' generates class BlocksApi; Blocks is reserved."))
    }

    func testNamespaceClassNamesNeverCollide() throws {
        XCTAssertEqual(
            namespaceClassNames(["blocks", "blocksApi", "sendable", "URLSession"]),
            ["blocks": "BlocksApiApi", "blocksApi": "BlocksApi", "sendable": "SendableApi", "URLSession": "URLSessionApi"]
        )
        let output = try generate(namespaces: ["blocks", "blocksApi"])
        XCTAssertEqual(output.api.components(separatedBy: "public final nonisolated class BlocksApi: Sendable {").count, 2)
        XCTAssertTrue(output.warnings.contains("swift: namespace 'blocks' generates class BlocksApiApi; Blocks is reserved."))
    }

    func testDefaultNamespaceIsReachedAsDefault() throws {
        let output = try generate(namespaces: [""])
        XCTAssertTrue(output.api.contains("public final nonisolated class _Default: Sendable {"))
        XCTAssertTrue(output.api.contains("    public let `default`: _Default\n"))
        XCTAssertEqual(output.warnings, [])
    }

    func testAccessorNamesLetUnchangedNamesClaimFirst() {
        XCTAssertEqual(
            namespaceAccessorNames(["_default", "client", "clientApi", "default"]),
            ["_default": "defaultApi", "client": "clientApiApi", "clientApi": "clientApi", "default": "default"]
        )
    }

    func testKeywordNamespacesAreBacktickedOnlyWhereDeclared() throws {
        let api = try generate(namespaces: ["class", "type"]).api
        XCTAssertTrue(api.contains("    public let `class`: Class\n    public let `type`: Type\n"))
        XCTAssertTrue(api.contains("        self.`class` = .init(client: client)"))
        XCTAssertTrue(api.contains(#"message: "Use blocks.class from one Blocks() or Blocks(server:) you hold""#))
    }

    func testBlocksMemberNamesCoverEveryMemberBlocksDeclares() throws {
        let api = try generate(namespaces: ["todos"]).api
        let body = try XCTUnwrap(api.components(separatedBy: "public final nonisolated class Blocks: Sendable {").last?.components(separatedBy: "\n}\n").first)
        let members = Set(matches(#"(?m)^    public (?:nonisolated )?(?:let|var|func) `?(\w+)"#, in: body)).subtracting(["todos"])
        XCTAssertEqual(members, ["server", "client", "close"])
        XCTAssertTrue(members.isSubset(of: blocksMemberNames))
    }

    // A namespace class named like any type the generated files name unqualified would shadow it.
    func testReservedClassNamesCoverEveryTypeGeneratedCodeNamesUnqualified() throws {
        let fixtures = swiftPackageURL.deletingLastPathComponent().appendingPathComponent("codegen-fixtures")
        let specs = try FileManager.default.contentsOfDirectory(at: fixtures, includingPropertiesForKeys: nil)
            .map { $0.appendingPathComponent("spec.json") }
            .filter { FileManager.default.fileExists(atPath: $0.path) }
            .map { try String(contentsOf: $0) }
        XCTAssertGreaterThanOrEqual(specs.count, 27)
        let tags = Array(knownTransferableTags) + ["example/unknown"]
        let methods = tags.enumerated().map { index, tag in
            #"{ "name": "api.get\#(index)", "params": [], "result": { "name": "R", "schema": { "x-blocks-transferable": "\#(tag)" } } }"#
        }
        let transferables = #"{ "openrpc": "1.3.2", "info": { "title": "t", "version": "1" }, "methods": [\#(methods.joined(separator: ","))] }"#

        var named: Set<String> = []
        for spec in specs + [transferables] {
            let output = try generate(spec)
            let code = (output.api + "\n" + output.models).split(separator: "\n")
                .filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }
                .joined(separator: "\n")
                .replacingOccurrences(of: #""(?:\\.|[^"\\])*""#, with: "", options: .regularExpression)
                .replacingOccurrences(of: #"BlocksRuntime\.\w+"#, with: "", options: .regularExpression)
            let declared = Set(matches(#"\b(?:class|struct|enum|actor|protocol|typealias) `?(\w+)"#, in: code))
            named.formUnion(Set(matches(#"(?<![.\w])([A-Z]\w*)\b"#, in: code)).subtracting(declared))
        }
        XCTAssertTrue(named.isSuperset(of: ["BlocksClient", "String", "Date", "JSONDecoder"]))
        XCTAssertEqual(named.subtracting(reservedNamespaceClassNames), [], "add these to reservedNamespaceClassNames")
    }

    // The fixture scan above sees only runtime types; this one also sees Foundation and stdlib names.
    func testEntryPointNamesOnlyReservedTypesUnqualified() {
        let name = EntryPointName(className: "Todos", property: "todos")
        let generator = SwiftCodeGenerator()
        var lines: [String] = []
        generator.emitNamespaceHeader(name, defaultServer: "Servers.local", lines: &lines)
        generator.emitBlocksEntryPoint([name], defaultServer: "Servers.local", lines: &lines)
        generator.emitServers([ServerDefinition(name: "local", url: "http://localhost:3001/aws-blocks/api")], lines: &lines)
        let code = lines.filter { !$0.trimmingCharacters(in: .whitespaces).hasPrefix("//") }.joined(separator: "\n")
            .replacingOccurrences(of: #""[^"]*""#, with: "", options: .regularExpression)
            .replacingOccurrences(of: #"BlocksRuntime\.\w+"#, with: "", options: .regularExpression)
        let named = Set(matches(#"\b([A-Z]\w*)\b"#, in: code)).subtracting(["Todos"])
        XCTAssertTrue(named.isSuperset(of: ["Sendable", "URLSession"]))
        XCTAssertEqual(named.subtracting(reservedNamespaceClassNames), [], "add these to reservedNamespaceClassNames")
    }

    // Keeps the rule of `testNoForceUnwrapsInGeneratedCode` for the new emission.
    func testEntryPointHasNoExclamationMark() throws {
        let api = try generate(namespaces: ["", "client", "class"], servers: #"[{ "name": "default", "url": "https://a.example/aws-blocks/api" }]"#).api
        XCTAssertFalse(api.contains("!"))
    }

    private func matches(_ pattern: String, in text: String) -> [String] {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return [] }
        return regex.matches(in: text, range: NSRange(text.startIndex..., in: text)).compactMap { match in
            Range(match.range(at: 1), in: text).map { String(text[$0]) }
        }
    }
}
