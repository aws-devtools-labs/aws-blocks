//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Blocks entry point

/// The names one namespace gets in the generated API file.
struct EntryPointName {
    /// Namespace class, e.g. `Users`.
    let className: String
    /// Unescaped `Blocks` property, e.g. `users`.
    let property: String
}

extension SwiftCodeGenerator {
    /// Class and `Blocks` property per namespace, with one warning per rename.
    func entryPointNames(for namespaces: [APINamespace]) -> (names: [EntryPointName], warnings: [String]) {
        let classes = namespaceClassNames(namespaces.map(\.name))
        let properties = namespaceAccessorNames(namespaces.map(\.name))
        var warnings: [String] = []
        let names = namespaces.map { namespace -> EntryPointName in
            let name = EntryPointName(
                className: classes[namespace.name] ?? pascalCase(namespace.name),
                property: properties[namespace.name] ?? naturalAccessorName(namespace.name)
            )
            let naturalClass = pascalCase(namespace.name)
            if name.className != naturalClass {
                let reason = reservedNamespaceClassNames.contains(naturalClass) ? "reserved" : "taken"
                warnings.append("swift: namespace '\(namespace.name)' generates class \(name.className); \(naturalClass) is \(reason).")
            }
            let naturalProperty = naturalAccessorName(namespace.name)
            if name.property != naturalProperty {
                warnings.append("swift: namespace '\(namespace.name)' is reached as blocks.\(name.property); \(naturalProperty) is taken.")
            }
            return name
        }
        return (names, warnings)
    }

    /// Opens a namespace class that runs on the client its `Blocks` owns. Every top-level generated type is
    /// `nonisolated`: it compiles in the app's target and must not inherit a `MainActor` default isolation.
    func emitNamespaceHeader(_ name: EntryPointName, defaultServer: String, lines: inout [String]) {
        lines.append("public final nonisolated class \(name.className): Sendable {")
        lines.append("    private let client: BlocksClient")
        lines.append("")
        lines.append("    public init(client: BlocksClient) {")
        lines.append("        self.client = client")
        lines.append("    }")
        lines.append("")
        lines.append("    @available(*, deprecated, message: \"Use blocks.\(name.property) from one Blocks() or Blocks(server:) you hold\")")
        lines.append("    public convenience init(server: BlocksServer = \(defaultServer)) {")
        lines.append("        self.init(client: BlocksClient(server: server))")
        lines.append("    }")
    }

    /// Emits `Blocks`: one client, one stored property per namespace, and `close()`.
    func emitBlocksEntryPoint(_ names: [EntryPointName], defaultServer: String, lines: inout [String]) {
        lines.append("")
        lines.append("// MARK: - Blocks")
        lines.append("")
        lines.append("/// One BlocksClient, so one URLSession (RPC and OIDC calls) and one token store, for every namespace in this spec;")
        lines.append("/// file transfers and realtime use the shared runtime session. Hold one while the backend is in use: `let blocks = Blocks()`.")
        lines.append("public final nonisolated class Blocks: Sendable {")
        lines.append("    /// The server every API calls.")
        lines.append("    public let server: BlocksRuntime.BlocksServer")
        lines.append("    /// The client every API runs on.")
        lines.append("    public let client: BlocksRuntime.BlocksClient")
        if !names.isEmpty {
            lines.append("")
        }
        for name in names {
            lines.append("    public let \(escapedSwiftName(name.property)): \(name.className)")
        }
        lines.append("")
        lines.append("    /// Defaults to the spec's first server; a `session` you pass stays yours.")
        lines.append("    public init(")
        lines.append("        server: BlocksRuntime.BlocksServer = \(defaultServer),")
        lines.append("        session: URLSession? = nil,")
        lines.append("        tokenStore: any BlocksRuntime.TokenStore = BlocksRuntime.InMemoryTokenStore()")
        lines.append("    ) {")
        lines.append("        self.server = server")
        lines.append("        self.client = BlocksRuntime.BlocksClient(server: server, session: session, tokenStore: tokenStore)")
        for name in names {
            lines.append("        self.\(escapedSwiftName(name.property)) = .init(client: client)")
        }
        lines.append("    }")
        lines.append("")
        lines.append("    /// Later calls throw ClientClosedError; calls in flight finish, then the session this instance created is released.")
        lines.append("    public func close() {")
        lines.append("        client.close()")
        lines.append("    }")
        lines.append("}")
    }

    /// Emits `Servers`; a keyword name such as `default` is backticked.
    func emitServers(_ servers: [ServerDefinition], lines: inout [String]) {
        lines.append("")
        lines.append("// MARK: - Servers")
        lines.append("")
        lines.append("public nonisolated enum Servers {")
        for server in servers {
            let name = swiftStringLiteral(server.name)
            let url = swiftStringLiteral(server.url)
            lines.append("    public static let \(serverPropertyName(server.name)) = BlocksServer(name: \(name), url: \(url))")
        }
        lines.append("}")
    }
}
