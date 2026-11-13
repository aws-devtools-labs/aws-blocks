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
// are `Sendable` themselves. A type that stores a `RealtimeChannel` (a class with mutable state) or a declared
// native binding (a package's type, whose conformance codegen can't see), directly or through another generated
// type, isn't. So an actor can keep or return an `AuthState`, and Swift 6 checks the rest as it does any type.
//
// Names are looked up across every scope: a name that is not `Sendable` in one scope (`Item` in one operation) is
// treated as not `Sendable` in all of them. That only ever drops a conformance, never claims a wrong one.

extension SwiftCodeGenerator {
    /// The names of the generated types that aren't `Sendable`.
    static func nonSendableTypeNames(in model: CodegenModel) -> Set<String> {
        var declarations: [(name: String, stored: [ResolvedType])] = []
        var visited: Set<String> = []

        func collect(_ type: ResolvedType, name: String? = nil) {
            switch type {
            case .record(let recordName, let fields, let additionalPropertiesType, let embeddedUnion):
                let declared = name ?? recordName
                guard visited.insert("record:\(declared)").inserted else { return }
                let stored = fields.map(\.type) + [additionalPropertiesType, embeddedUnion].compactMap { $0 }
                declarations.append((declared, stored))
                stored.forEach { collect($0) }
            case .union(let unionName, let variants, _):
                let declared = name ?? unionName
                guard visited.insert("union:\(declared)").inserted else { return }
                declarations.append((declared, [.union(name: declared, variants: variants, discriminator: nil)]))
                for variant in variants {
                    let stored = variant.fields.map(\.type)
                        + [variant.additionalPropertiesType, variant.embeddedUnion].compactMap { $0 }
                    declarations.append((variant.name, stored))
                    stored.forEach { collect($0) }
                    variant.valueType.map { collect($0) }
                    variant.nestedTypes.forEach(collect)
                }
            case .list(let element, _): collect(element)
            case .nullable(let inner): collect(inner)
            case .map(let value): collect(value)
            case .transferable(_, let typeArgs): typeArgs.forEach { collect($0) }
            case .primitive, .formattedType, .enum, .typeReference: break
            }
        }
        func collect(_ node: NestedTypeNode) {
            collect(node.type, name: node.name)
            node.children.forEach(collect)
        }

        for typeDef in model.typeDefinitions {
            collect(typeDef.type, name: typeDef.name)
            typeDef.nestedTypes.forEach(collect)
        }
        model.sharedTypes.forEach(collect)
        for namespace in model.apiNamespaces {
            for operation in namespace.operations {
                operation.nestedTypes.forEach(collect)
                operation.parameters.forEach { collect($0.type) }
                collect(operation.result.type)
            }
        }

        // To a fixed point: a type is not Sendable once something it stores isn't.
        var names: Set<String> = []
        var changed = true
        while changed {
            changed = false
            for declaration in declarations where !names.contains(declaration.name) {
                if declaration.stored.contains(where: { storesNonSendable($0, names: names, bindings: model.declaredTransferableBindings) }) {
                    names.insert(declaration.name)
                    changed = true
                }
            }
        }
        return names
    }

    private static func storesNonSendable(
        _ type: ResolvedType, names: Set<String>, bindings: [String: DeclaredTransferableBinding]
    ) -> Bool {
        func check(_ type: ResolvedType) -> Bool {
            switch type {
            case .primitive, .formattedType, .enum: return false
            case .typeReference(let name): return names.contains(name)
            case .record(let name, let fields, let additionalPropertiesType, let embeddedUnion):
                return names.contains(name) || fields.contains { check($0.type) }
                    || additionalPropertiesType.map(check) == true || embeddedUnion.map(check) == true
            case .union(let name, let variants, _):
                return names.contains(name) || variants.contains { variant in
                    names.contains(variant.name) || variant.payloadTypeName.map(names.contains) == true
                        || variant.valueType.map(check) == true
                }
            case .list(let element, _): return check(element)
            case .nullable(let inner): return check(inner)
            case .map(let value): return check(value)
            case .transferable(let blocksType, _):
                // A declared binding is a package's type; an unbound tag decodes as `UnknownTransferable`.
                return blocksType == "realtime/channel" || bindings[blocksType] != nil
            }
        }
        return check(type)
    }

    /// The conformances of a generated record or union that stores `stored`.
    func valueConformances(_ stored: [ResolvedType]) -> String {
        stored.contains { Self.storesNonSendable($0, names: nonSendableNames, bindings: declaredBindings) }
            ? "Codable" : "Codable, Sendable"
    }

    /// What a record stores: its fields, its open-record attributes and its embedded union.
    func recordStored(_ fields: [ResolvedField], _ additionalPropertiesType: ResolvedType?, _ embeddedUnion: ResolvedType?) -> [ResolvedType] {
        fields.map(\.type) + [additionalPropertiesType, embeddedUnion].compactMap { $0 }
    }
}
