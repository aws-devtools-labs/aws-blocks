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
// provider enum in its operation enum, and the operation returns an `OIDCClient`
// typed by it, whose `signIn` then takes only those providers.

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
        // A doc comment is one line: a method name's line breaks are written escaped, as in the method's own doc.
        let docName = fullMethodName(operation, namespace: namespace)
            .replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r")
        lines.append("\(indent)/// The providers `\(docName)` signs in with.")
        let conformances = "String, CaseIterable, Codable, BlocksRuntime.OIDCProviderName"
        // `nonisolated`, like `Servers`: in an app module with MainActor default isolation, a main-actor provider
        // type would make `OIDCClient<Provider>`'s nonisolated `Codable` conformance unusable.
        emitDeclaration(
            provider.name, line: "\(indent)public nonisolated enum \(provider.name): \(conformances) {", lines: &lines
        )
        for (caseName, value) in providerCases(provider.values) {
            let unescaped = caseName.trimmingCharacters(in: CharacterSet(charactersIn: "`"))
            lines.append(unescaped == value
                ? "\(indent)    case \(caseName)"
                : "\(indent)    case \(caseName) = \"\(swiftStringContent(value))\"")
        }
        lines.append("\(indent)}")
    }

    /// Names the enum when it isn't `Provider`, since the operation already declares or uses a type by that name.
    /// `enumName` is the operation's enum, which holds the provider enum.
    func oidcProviderRenameWarning(_ operation: Operation, namespace: String, className: String, enumName: String) -> String? {
        guard let provider = oidcProviderEnum(operation), provider.name != "Provider" else { return nil }
        let providerType = "\(className).\(enumName).\(provider.name)"
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
