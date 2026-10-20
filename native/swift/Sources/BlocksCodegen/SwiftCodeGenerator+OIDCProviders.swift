//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - OIDC Providers
//
// An operation's `oidc/client` result with a string-enum type argument gets a
// provider enum in its operation enum and a `signIn` overload on `OIDCClient`
// that takes it. `OIDCClient` itself stays untyped.

extension SwiftCodeGenerator {
    /// The provider enum of an operation whose direct or optional result is an `oidc/client` with a string-enum type argument.
    func oidcProviderEnum(_ operation: Operation) -> (name: String, values: [String])? {
        guard let transferable = transferableResult(operation.result.type),
              case .transferable("oidc/client", let typeArgs) = transferable.type,
              case .enum(let name, let values)? = typeArgs.first else { return nil }
        return (name, values)
    }

    func emitOIDCProviderEnum(_ operation: Operation, namespace: String, indent: String, lines: inout [String]) {
        guard let provider = oidcProviderEnum(operation) else { return }
        lines.append("")
        lines.append("\(indent)/// The providers `\(fullMethodName(operation, namespace: namespace))` signs in with.")
        lines.append("\(indent)public enum \(provider.name): String, CaseIterable, Codable, Sendable {")
        for (caseName, value) in providerCases(provider.values) {
            let unescaped = caseName.trimmingCharacters(in: CharacterSet(charactersIn: "`"))
            lines.append(unescaped == value
                ? "\(indent)    case \(caseName)"
                : "\(indent)    case \(caseName) = \(swiftStringLiteral(value))")
        }
        lines.append("\(indent)}")
    }

    /// A `signIn` overload on `OIDCClient` that takes the operation's provider enum. Runtime names are qualified,
    /// since a model or an app type may take them.
    func emitOIDCProviderSignIn(_ operation: Operation, namespace: String, className: String, lines: inout [String]) {
        guard let provider = oidcProviderEnum(operation) else { return }
        let providerType = "\(className).\(pascalCase(operation.name)).\(provider.name)"
        lines.append("extension BlocksRuntime.OIDCClient {")
        lines.append("    /// Signs in with one of the providers `\(fullMethodName(operation, namespace: namespace))` returns a client for.")
        lines.append("    public func signIn(")
        lines.append("        provider: \(providerType),")
        lines.append("        relayTo: String,")
        lines.append("        launcher: any BlocksRuntime.BrowserLauncher")
        lines.append("    ) async throws -> BlocksRuntime.OIDCUser {")
        lines.append("        try await signIn(provider: provider.rawValue, relayTo: relayTo, launcher: launcher)")
        lines.append("    }")
        lines.append("}")
        lines.append("")
    }

    /// Names the enum when it isn't `Provider`, since the operation already declares or uses a type by that name.
    func oidcProviderRenameWarning(_ operation: Operation, namespace: String, className: String) -> String? {
        guard let provider = oidcProviderEnum(operation), provider.name != "Provider" else { return nil }
        let providerType = "\(className).\(pascalCase(operation.name)).\(provider.name)"
        return "swift: \(fullMethodName(operation, namespace: namespace)) names its providers \(providerType),"
            + " since its operation already declares or uses a type named Provider."
    }

    /// Case names and raw values: camelCased, made legal and backticked if a keyword; a repeated
    /// value is dropped and a name another value already took is numbered.
    func providerCases(_ values: [String]) -> [(name: String, value: String)] {
        var seenValues: Set<String> = []
        var takenNames: Set<String> = []
        var cases: [(name: String, value: String)] = []
        for value in values where seenValues.insert(value).inserted {
            let camel = camelCase(value)
            let legal = camel.first?.isNumber == true ? "_" + camel : camel
            let sanitized = escapedSwiftName(legal).trimmingCharacters(in: CharacterSet(charactersIn: "`"))
            // A lone symbol sanitizes to `_`, which can't name a case.
            let base = sanitized == "_" ? "_unnamed" : sanitized
            var name = base
            var suffix = 2
            while !takenNames.insert(name).inserted {
                name = "\(base)\(suffix)"
                suffix += 1
            }
            cases.append((escapedSwiftName(name), value))
        }
        return cases
    }

    private func fullMethodName(_ operation: Operation, namespace: String) -> String {
        namespace == "_default" ? operation.name : "\(namespace).\(operation.name)"
    }
}
