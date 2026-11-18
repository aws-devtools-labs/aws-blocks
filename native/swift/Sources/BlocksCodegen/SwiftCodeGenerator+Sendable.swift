//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Sendable
//
// A generated value type is `Sendable` when everything it stores is: strings, numbers, `Date`, `URL`, `UUID`,
// `JSONValue`, the file handles, an `OIDCClient` (an actor), `UnknownTransferable`, and other generated types that
// are `Sendable` themselves. A type that stores a `RealtimeChannel` (a class with mutable state), directly or
// through another generated type, isn't. A declared native binding is never stored: below an operation's direct
// result it's a `JSONValue`. So an actor can keep or return an `AuthState`, and Swift 6 checks the rest as it does
// any type.
//
// Names are looked up the way Swift looks them up: each operation's enum is a scope of its own, and a name the
// enum declares (`Result`) means that declaration there, while any other name means the top-level one. Two types
// of one name in one scope (`Item` and `Result.Item`) share an answer, which only ever drops a conformance, never
// claims a wrong one.

/// The generated types that aren't `Sendable`, by scope: `""` is the top level of the generated files, and an
/// operation's enum is `"<namespace>.<operation>"`.
struct SendableAnalysis {
    var declared: [String: Set<String>] = [:]
    var nonSendable: [String: Set<String>] = [:]

    /// Whether the type `name` means in `scope` is not `Sendable`.
    func isNonSendable(_ name: String, in scope: String) -> Bool {
        let owner = declared[scope]?.contains(name) == true ? scope : ""
        return nonSendable[owner]?.contains(name) == true
    }

    /// Whether the generated files declare a type named `Sendable`, which hides the protocol from the types in
    /// its scope.
    var declaresSendable: Bool { declared.values.contains { $0.contains("Sendable") } }
}

/// The scope the generator is emitting declarations in (see `SendableAnalysis`).
final class EmissionScope {
    var current = ""
}

extension SwiftCodeGenerator {
    /// The scope key of an operation's enum.
    static func sendableScope(namespace: String, operation: String) -> String { "\(namespace).\(operation)" }

    /// Which generated types aren't `Sendable`, in each scope.
    static func sendableAnalysis(in model: CodegenModel) -> SendableAnalysis {
        struct Declaration {
            let scope: String
            let name: String
            let stored: [ResolvedType]
        }
        var declarations: [Declaration] = []

        func collect(_ type: ResolvedType, name: String? = nil, scope: String) {
            switch type {
            case .record(let recordName, let fields, let additionalPropertiesType, let embeddedUnion):
                let stored = fields.map(\.type) + [additionalPropertiesType, embeddedUnion].compactMap { $0 }
                declarations.append(Declaration(scope: scope, name: name ?? recordName, stored: stored))
                stored.forEach { collect($0, scope: scope) }
            case .union(let unionName, let variants, _):
                let declared = name ?? unionName
                declarations.append(Declaration(scope: scope, name: declared, stored: [.union(name: declared, variants: variants, discriminator: nil)]))
                // An arm that carries a named type (`$ref Joined`) declares nothing here; it stores that type.
                for variant in variants where variant.payloadTypeName == nil {
                    let stored = variant.fields.map(\.type)
                        + [variant.additionalPropertiesType, variant.embeddedUnion].compactMap { $0 }
                    declarations.append(Declaration(scope: scope, name: variant.name, stored: stored))
                    stored.forEach { collect($0, scope: scope) }
                    variant.valueType.map { collect($0, scope: scope) }
                    variant.nestedTypes.forEach { collect($0, scope: scope) }
                }
            case .list(let element, _): collect(element, scope: scope)
            case .nullable(let inner): collect(inner, scope: scope)
            case .map(let value): collect(value, scope: scope)
            case .transferable(_, let typeArgs): typeArgs.forEach { collect($0, scope: scope) }
            case .primitive, .formattedType, .typeReference: break
            case .enum(let enumName, _): declarations.append(Declaration(scope: scope, name: name ?? enumName, stored: []))
            }
        }
        func collect(_ node: NestedTypeNode, scope: String) {
            collect(node.type, name: node.name, scope: scope)
            node.children.forEach { collect($0, scope: scope) }
        }

        for typeDef in model.typeDefinitions {
            collect(typeDef.type, name: typeDef.name, scope: "")
            typeDef.nestedTypes.forEach { collect($0, scope: "") }
        }
        model.sharedTypes.forEach { collect($0, scope: "") }
        for namespace in model.apiNamespaces {
            for operation in namespace.operations {
                let scope = sendableScope(namespace: namespace.name, operation: operation.name)
                operation.nestedTypes.forEach { collect($0, scope: scope) }
                operation.parameters.forEach { collect($0.type, scope: scope) }
                collect(operation.result.type, scope: scope)
            }
        }

        var analysis = SendableAnalysis()
        for declaration in declarations {
            analysis.declared[declaration.scope, default: []].insert(declaration.name)
        }
        // To a fixed point: a type is not Sendable once something it stores isn't.
        var changed = true
        while changed {
            changed = false
            for declaration in declarations
            where analysis.nonSendable[declaration.scope]?.contains(declaration.name) != true {
                let stores = declaration.stored.contains {
                    storesNonSendable($0, scope: declaration.scope, analysis: analysis)
                }
                if stores {
                    analysis.nonSendable[declaration.scope, default: []].insert(declaration.name)
                    changed = true
                }
            }
        }
        return analysis
    }

    private static func storesNonSendable(_ type: ResolvedType, scope: String, analysis: SendableAnalysis) -> Bool {
        let names = { (name: String) in analysis.isNonSendable(name, in: scope) }
        func check(_ type: ResolvedType) -> Bool {
            switch type {
            case .primitive, .formattedType, .enum: return false
            case .typeReference(let name): return names(name)
            case .record(let name, let fields, let additionalPropertiesType, let embeddedUnion):
                return names(name) || fields.contains { check($0.type) }
                    || additionalPropertiesType.map(check) == true || embeddedUnion.map(check) == true
            case .union(let name, let variants, _):
                return names(name) || variants.contains { variant in
                    variant.payloadTypeName.map(names) ?? names(variant.name)
                        || variant.valueType.map(check) == true
                }
            case .list(let element, _): return check(element)
            case .nullable(let inner): return check(inner)
            case .map(let value): return check(value)
            case .transferable(let blocksType, _):
                // Every other stored tag is a `Sendable` runtime type or, declared or unbound, a `JSONValue`.
                return blocksType == "realtime/channel"
            }
        }
        return check(type)
    }

    /// The conformances of a generated record or union that stores `stored`.
    func valueConformances(_ stored: [ResolvedType]) -> String {
        stored.contains {
            Self.storesNonSendable($0, scope: emissionScope.current, analysis: sendable)
        } ? "Codable" : "Codable, \(sendableProtocol)"
    }

    /// `Sendable`, qualified as `Swift.Sendable` when a generated type takes that name.
    var sendableProtocol: String { sendable.declaresSendable ? "Swift.Sendable" : "Sendable" }

    /// What a record stores: its fields, its open-record attributes and its embedded union.
    func recordStored(_ fields: [ResolvedField], _ additionalPropertiesType: ResolvedType?, _ embeddedUnion: ResolvedType?) -> [ResolvedType] {
        fields.map(\.type) + [additionalPropertiesType, embeddedUnion].compactMap { $0 }
    }
}
