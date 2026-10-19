//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Spec diagnostics

extension SwiftCodeGenerator {
    /// One `swift:` line per spec shape the generated code can't express as written.
    func specWarnings(for model: CodegenModel) -> [String] {
        var warnings: [String] = []
        for namespace in model.apiNamespaces {
            for operation in namespace.operations where containsNestedOIDCClient(operation.result.type, atTop: true) {
                let fullOp = namespace.name == "_default" ? operation.name : "\(namespace.name).\(operation.name)"
                warnings.append(
                    "swift: \(fullOp) returns an oidc/client below the top level, which decodes as JSONValue;"
                    + " return it directly to get an OIDCClient."
                )
            }
        }
        for typeDef in model.typeDefinitions where containsNestedOIDCClient(typeDef.type, atTop: false) {
            warnings.append("swift: model '\(typeDef.name)' holds an oidc/client, which decodes as JSONValue; return it directly to get an OIDCClient.")
        }
        for typeDef in model.typeDefinitions where reservedModelNames.contains(typeDef.name) {
            warnings.append(
                "swift: model '\(typeDef.name)' takes a name the generated API file declares or qualifies with,"
                + " so the output won't compile; rename the schema."
            )
        }
        return warnings
    }

    /// Whether an `oidc/client` sits below the top of `type`, where generated code decodes it as `JSONValue`.
    func containsNestedOIDCClient(_ type: ResolvedType, atTop: Bool) -> Bool {
        switch type {
        case .transferable(let blocksType, let typeArgs):
            return (blocksType == "oidc/client" && !atTop) || typeArgs.contains { containsNestedOIDCClient($0, atTop: false) }
        case .nullable(let inner):
            return containsNestedOIDCClient(inner, atTop: atTop)
        case .list(let elementType, _):
            return containsNestedOIDCClient(elementType, atTop: false)
        case .map(let valueType):
            return containsNestedOIDCClient(valueType, atTop: false)
        case .record(_, let fields, let additionalPropertiesType, let embeddedUnion):
            return fields.contains { containsNestedOIDCClient($0.type, atTop: false) }
                || [additionalPropertiesType, embeddedUnion].contains { $0.map { containsNestedOIDCClient($0, atTop: false) } == true }
        case .union(_, let variants, _):
            return variants.contains { variant in
                variant.fields.contains { containsNestedOIDCClient($0.type, atTop: false) }
                    || [variant.additionalPropertiesType, variant.embeddedUnion].contains { $0.map { containsNestedOIDCClient($0, atTop: false) } == true }
            }
        default:
            return false
        }
    }
}
