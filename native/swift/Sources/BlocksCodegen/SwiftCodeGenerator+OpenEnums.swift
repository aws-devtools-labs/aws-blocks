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
            names.insert(name)
            fields.forEach { walk($0.type) }
            if let additionalPropertiesType { walk(additionalPropertiesType) }
            if let embeddedUnion { walk(embeddedUnion) }
        case .enum(let name, _):
            names.insert(name)
        case .union(let name, let variants, let discriminator):
            names.insert(name)
            for variant in variants {
                // Without a discriminator the decoder tries each arm in turn, so an enum arm stays closed: open,
                // it would take every string.
                if discriminator == nil, isEnumArm(variant) { continue }
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

    /// Whether a union arm is a bare enum: an enum value arm, or an arm that is an enum schema.
    private func isEnumArm(_ variant: UnionVariant) -> Bool {
        if case .enum? = variant.valueType { return true }
        if let payload = variant.payloadTypeName, case .enum? = typesByName[payload] { return true }
        return false
    }

    /// Emits a union value arm's own type. An enum there stays closed (see `isEnumArm`); any other type keeps the
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
}
