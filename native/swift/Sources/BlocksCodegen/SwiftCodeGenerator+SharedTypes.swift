//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Shared parameter types
//
// A union parameter the spec names (`x-blocks-type-name`) is declared once at the top level (`AuthActionInput`), and
// each operation that takes it keeps the names its enum declared before as deprecated typealiases.

extension SwiftCodeGenerator {
    /// Whether a union variant gets a struct of its own (rather than a payload-less case, or a case carrying an
    /// existing type or a value).
    func declaresVariantStruct(_ variant: UnionVariant) -> Bool {
        guard !variant.fields.isEmpty
            || variant.additionalPropertiesType != nil
            || variant.embeddedUnion != nil
            || !variant.nestedTypes.isEmpty else { return false }
        return variant.payloadTypeName == nil && variant.valueType == nil
    }

    /// The names a union's node declares in the scope it's declared in, after the union itself: its variant
    /// structs, a value arm's own types and the union's children. Nested inside a shared union, the same list is
    /// its members.
    private func declaredMemberNames(_ node: NestedTypeNode) -> [String] {
        guard case .union(_, let variants, _) = node.type else { return [] }
        return variants.filter(declaresVariantStruct).map(\.name)
            + variants.filter { $0.valueType != nil }.flatMap { valueArmTypes($0).map(\.name) }
            + node.children.map(\.name)
    }

    /// The deprecated typealiases that keep a shared parameter type's old names in its operation's enum:
    /// `Input` for `AuthActionInput`, `SignIn` for `AuthActionInput.SignIn`. A member is aliased to the shared
    /// type's member of the same name, and an old name that would alias itself is skipped. The message names the
    /// replacement in full, since a `renamed:` fix-it would replace only the alias's last component.
    func emitSharedTypeAliases(
        _ operation: Operation, shared: [String: NestedTypeNode], indent: String, lines: inout [String]
    ) {
        var aliased: Set<String> = []
        for alias in operation.sharedTypeAliases {
            guard let target = shared[alias.target] else { continue }
            let members = Set(declaredMemberNames(target))
            let pairs = [(alias.old.name, target.name)]
                + declaredMemberNames(alias.old).filter(members.contains).map { ($0, "\(target.name).\($0)") }
            for (old, qualified) in pairs where old != qualified && old != target.name && aliased.insert(old).inserted {
                lines.append("")
                lines.append("\(indent)@available(*, deprecated, message: \"Use \(swiftStringContent(qualified))\")")
                emitDeclaration(old, line: "\(indent)public typealias \(old) = \(qualified)", lines: &lines)
            }
        }
    }

    /// Declares the shared parameter unions (`AuthActionInput`) at the top level, with their variants nested inside,
    /// and returns them by name.
    func emitSharedTypes(_ model: CodegenModel, lines: inout [String]) -> [String: NestedTypeNode] {
        for node in model.sharedTypes {
            guard case .union(_, let variants, let discriminator) = node.type else { continue }
            emitNestedUnion(
                name: node.name, variants: variants, discriminator: discriminator, children: node.children,
                indent: "", lines: &lines, sharedTopLevel: true
            )
        }
        return Dictionary(model.sharedTypes.map { ($0.name, $0) }, uniquingKeysWith: { first, _ in first })
    }

    // MARK: - Operation enums

    func emitOperationEnum(
        operation: Operation, name opName: String, namespace: String, shared: [String: NestedTypeNode],
        indent: String, lines: inout [String]
    ) {
        emitDeclaration(opName, line: "\(indent)public enum \(opName) {", lines: &lines)
        emissionScope.current = Self.sendableScope(namespace: namespace, operation: operation.name)
        defer { emissionScope.current = "" }
        let resultRoots = resultRootTypeNames(operation)
        for node in operation.nestedTypes {
            openEnums.with(open: resultRoots.contains(node.name)) {
                emitNestedTypeNode(node, indent: indent + "    ", lines: &lines)
            }
        }
        emitSharedTypeAliases(operation, shared: shared, indent: indent + "    ", lines: &lines)
        emitOIDCProviderEnum(operation, namespace: namespace, indent: indent + "    ", lines: &lines)
        lines.append("\(indent)}")
    }
}
