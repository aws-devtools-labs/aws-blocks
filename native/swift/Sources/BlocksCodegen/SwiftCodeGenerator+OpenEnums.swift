//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Open enums
//
// A string enum a response can carry is open: a value the client was generated without decodes to
// `.unknown(String)` instead of failing, and encodes back as that string. An enum only parameters use stays a
// closed `String` enum.

/// Which enums the generator is emitting open. Component schemas are open when an operation's result reaches them;
/// a type nested in an operation's enum is open when it belongs to the result's tree, and one nested in a
/// component inherits the component's.
final class OpenEnumScope {
    /// The component schemas (top-level types) an operation's result reaches.
    var openTypeNames: Set<String> = []
    /// Whether the enums emitted now are open.
    var isOpen = false
    /// The unions embedded in a hybrid arm (they share the arm's JSON object), which stay closed.
    var embeddedUnionNames: Set<String> = []

    /// Runs `body` with `isOpen` set to `open`, then restores it.
    func with(open: Bool, _ body: () -> Void) {
        let saved = isOpen
        isOpen = open
        body()
        isOpen = saved
    }
}

extension SwiftCodeGenerator {
    /// The component schemas every operation's result reaches, at any depth: through records, union arms, lists,
    /// maps, optionals and a transferable's type arguments. An `oidc/client`'s argument names the providers a
    /// caller may pass, so it isn't a response position.
    func openTypeNames(_ model: CodegenModel) -> Set<String> {
        var open: Set<String> = []
        var followed: Set<String> = []
        for namespace in model.apiNamespaces {
            for operation in namespace.operations {
                collectReachableTypeNames(operation.result.type, into: &open, followed: &followed)
            }
        }
        return open.intersection(model.typeDefinitions.map(\.name))
    }

    /// `followed` holds the references already walked, so a recursive schema ends.
    private func collectReachableTypeNames(_ type: ResolvedType, into names: inout Set<String>, followed: inout Set<String>) {
        func walk(_ type: ResolvedType) { collectReachableTypeNames(type, into: &names, followed: &followed) }
        switch type {
        case .record(let name, let fields, let additionalPropertiesType, let embeddedUnion):
            if isDefinition(type, named: name) { names.insert(name) }
            fields.forEach { walk($0.type) }
            if let additionalPropertiesType { walk(additionalPropertiesType) }
            if let embeddedUnion { walk(embeddedUnion) }
        case .enum(let name, _):
            if isDefinition(type, named: name) { names.insert(name) }
        case .union(let name, let variants, _):
            if isDefinition(type, named: name) { names.insert(name) }
            for variant in variants {
                if let payload = variant.payloadTypeName { walk(.typeReference(name: payload)) }
                variant.fields.forEach { walk($0.type) }
                if let extras = variant.additionalPropertiesType { walk(extras) }
                if let embedded = variant.embeddedUnion { walk(embedded) }
                if let value = variant.valueType { walk(value) }
            }
        case .typeReference(let name):
            names.insert(name)
            guard followed.insert(name).inserted, let target = typesByName[name] else { return }
            walk(target)
        case .list(let element, _):
            walk(element)
        case .nullable(let inner):
            walk(inner)
        case .map(let value):
            walk(value)
        case .transferable(let blocksType, let typeArgs):
            guard blocksType != "oidc/client" else { return }
            typeArgs.forEach(walk)
        case .primitive, .formattedType:
            return
        }
    }

    /// Whether `type`, an inline type named `name`, is the component schema of that name and not a type nested
    /// in an operation or another schema that only shares its name (a result's inline `mode` enum beside a
    /// component `Mode` that only a parameter uses). Compared by shape: kind, then values, fields or arms.
    private func isDefinition(_ type: ResolvedType, named name: String) -> Bool {
        switch (type, typesByName[name]) {
        case (.enum(_, let values), .enum(_, let other)?):
            return values == other
        case (.record(_, let fields, _, _), .record(_, let other, _, _)?):
            return fields.map(\.name) == other.map(\.name)
        case (.union(_, let variants, _), .union(_, let other, _)?):
            return variants.map(\.name) == other.map(\.name)
        default:
            return false
        }
    }

    /// The known values of `variant`'s payload when it is an open enum schema (a `$ref` arm), else nil. A union
    /// without a discriminator decodes by trying each arm in turn, and an open enum takes every string, so the
    /// arm accepts only these values; any other string falls through to the next arm.
    func openEnumArmValues(_ variant: UnionVariant) -> [String]? {
        guard let payload = variant.payloadTypeName, openEnums.openTypeNames.contains(payload),
              case .enum(_, let values)? = typesByName[payload] else { return nil }
        return values
    }

    /// `["a", "b"].contains(value.rawValue)`: the guard for an open enum arm (see `openEnumArmValues`).
    func knownValueCondition(_ values: [String]) -> String {
        "[\(values.map { "\"\(swiftStringContent($0))\"" }.joined(separator: ", "))].contains(value.rawValue)"
    }

    /// Emits a union value arm's own type. An inline enum there stays closed, since the arms are tried in turn; any other type keeps the
    /// enclosing type's openness.
    func emitValueArmType(_ node: NestedTypeNode, _ emit: () -> Void) {
        if case .enum = node.type {
            openEnums.with(open: false, emit)
        } else {
            emit()
        }
    }

    /// The names of the types an operation's result declares directly in its operation enum (`Result`, or an enum
    /// or union the result is a list or optional of). The types nested in them are the result's too.
    func resultRootTypeNames(_ operation: Operation) -> Set<String> {
        var names: Set<String> = []
        func walk(_ type: ResolvedType) {
            switch type {
            case .record(let name, _, _, _), .enum(let name, _), .union(let name, _, _):
                names.insert(name)
            case .list(let element, _):
                walk(element)
            case .nullable(let inner):
                walk(inner)
            case .map(let value):
                walk(value)
            case .transferable(let blocksType, let typeArgs) where blocksType != "oidc/client":
                typeArgs.forEach(walk)
            default:
                return
            }
        }
        walk(operation.result.type)
        return names
    }

    /// A string enum's declaration and body: closed (`enum X: String, Codable`) or, while `openEnums.isOpen`,
    /// open, with an `unknown(String)` case that keeps a value the client was generated without.
    func enumDeclarationLines(name: String, values: [String], declaration: String, indent: String) -> [String] {
        guard openEnums.isOpen else {
            return ["\(indent)\(declaration) \(name): String, Codable {"]
                + enumCaseLines(values, indent: indent + "    ")
                + ["\(indent)}"]
        }
        let values = values.reduce(into: [String]()) { if !$0.contains($1) { $0.append($1) } }
        let names = swiftIdentifiers(for: values, candidate: swiftCamelCaseCandidate)
        let unknown = openEnumUnknownCaseName(taken: Set(names.map(unescapedSwiftName)))
        let body = indent + "    "
        var lines = ["\(indent)\(declaration) \(name): RawRepresentable, Codable, Hashable {"]
        lines += names.map { "\(body)case \($0)" }
        lines.append("\(body)/// A value this client was generated without, as the server sent it.")
        lines.append("\(body)case \(unknown)(String)")
        lines.append("")
        lines.append("\(body)public init(rawValue: String) {")
        lines.append("\(body)    switch rawValue {")
        for (value, caseName) in zip(values, names) {
            lines.append("\(body)    case \"\(swiftStringContent(value))\": self = .\(caseName)")
        }
        lines.append("\(body)    default: self = .\(unknown)(rawValue)")
        lines.append("\(body)    }")
        lines.append("\(body)}")
        lines.append("")
        lines.append("\(body)public var rawValue: String {")
        lines.append("\(body)    switch self {")
        for (value, caseName) in zip(values, names) {
            lines.append("\(body)    case .\(caseName): return \"\(swiftStringContent(value))\"")
        }
        lines.append("\(body)    case .\(unknown)(let value): return value")
        lines.append("\(body)    }")
        lines.append("\(body)}")
        lines.append("\(indent)}")
        return lines
    }

    /// `unknown`, or `unknownValue` (then `unknownValue2`, …) when a spec value already took it.
    private func openEnumUnknownCaseName(taken: Set<String>) -> String {
        guard taken.contains("unknown") else { return "unknown" }
        var candidate = "unknownValue"
        var suffix = 2
        while taken.contains(candidate) {
            candidate = "unknownValue\(suffix)"
            suffix += 1
        }
        return candidate
    }

    // MARK: - Open unions

    /// The names of every union embedded in a hybrid arm, anywhere in the model.
    func embeddedUnionNames(_ model: CodegenModel) -> Set<String> {
        var names: Set<String> = []
        func walk(_ type: ResolvedType) {
            switch type {
            case .record(_, let fields, let extras, let embedded):
                fields.forEach { walk($0.type) }
                if let extras { walk(extras) }
                if let embedded, case .union(let name, _, _) = embedded { names.insert(name) }
                if let embedded { walk(embedded) }
            case .union(_, let variants, _):
                for variant in variants {
                    variant.fields.forEach { walk($0.type) }
                    if let embedded = variant.embeddedUnion, case .union(let name, _, _) = embedded { names.insert(name) }
                    if let embedded = variant.embeddedUnion { walk(embedded) }
                    variant.nestedTypes.forEach { walk($0.type) }
                }
            case .list(let element, _): walk(element)
            case .nullable(let inner): walk(inner)
            case .map(let value): walk(value)
            default: return
            }
        }
        func walkNodes(_ nodes: [NestedTypeNode]) {
            for node in nodes {
                walk(node.type)
                walkNodes(node.children)
            }
        }
        for typeDef in model.typeDefinitions {
            walk(typeDef.type)
            walkNodes(typeDef.nestedTypes)
        }
        for namespace in model.apiNamespaces {
            for operation in namespace.operations {
                walk(operation.result.type)
                operation.parameters.forEach { walk($0.type) }
                walkNodes(operation.nestedTypes)
            }
        }
        return names
    }

    /// The case an open union decodes an unrecognised arm to, or nil when the union is closed. A union is open
    /// while `openEnums.isOpen` (a response carries it), when its discriminator is a string and every arm is an
    /// object; a union embedded in a hybrid arm stays closed. The case is `unknown`, or `unknownValue` when an arm
    /// already has that name.
    func openUnionCaseName(name: String, variants: [UnionVariant], discriminator: DiscriminatorInfo?) -> String? {
        guard openEnums.isOpen, let discriminator, discriminator.kind == .string,
              !variants.contains(where: isBareValue),
              !openEnums.embeddedUnionNames.contains(name) else { return nil }
        let taken = Set(variants.map { unescapedSwiftName(unionCaseName($0)) })
        guard taken.contains("unknown") else { return "unknown" }
        var candidate = "unknownValue"
        var suffix = 2
        while taken.contains(candidate) {
            candidate = "unknownValue\(suffix)"
            suffix += 1
        }
        return candidate
    }
}
