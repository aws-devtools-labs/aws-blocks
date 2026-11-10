//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Identifier collisions

extension SwiftCodeGenerator {
    /// Throws when two different names the spec supplies reduce to one identifier in the same
    /// scope: servers, fields of a type, parameters and operations (as methods and as the enums
    /// that hold an operation's nested types), and the cases of an enum. The output would declare
    /// one name twice and not compile, so generation fails and names both.
    ///
    /// An OIDC provider enum is left out: its cases are numbered apart by design.
    func rejectIdentifierCollisions(_ model: CodegenModel) throws {
        try requireDistinct("server", in: "the spec", model.servers.map(\.name), identifier: serverPropertyName)
        for typeDef in model.typeDefinitions {
            try rejectCollisions(in: typeDef.type)
        }
        for namespace in model.apiNamespaces {
            try requireDistinct(
                "operation", in: "namespace '\(namespace.name)'",
                namespace.operations.map(\.name), identifier: escapedSwiftName
            )
            // Only an operation with nested types or a provider enum declares an enum of its own.
            try requireDistinct(
                "operation", in: "namespace '\(namespace.name)'",
                namespace.operations
                    .filter { !$0.nestedTypes.isEmpty || oidcProviderEnum($0) != nil }
                    .map(\.name),
                identifier: pascalCase
            )
            for operation in namespace.operations {
                try requireDistinct(
                    "parameter", in: "operation '\(operation.name)'",
                    operation.parameters.map(\.name), identifier: escapedSwiftName
                )
                for parameter in operation.parameters {
                    try rejectCollisions(in: parameter.type)
                }
                try rejectCollisions(in: operation.result.type)
                for node in operation.nestedTypes {
                    try rejectCollisions(in: node)
                }
            }
        }
    }

    private func rejectCollisions(in node: NestedTypeNode) throws {
        try rejectCollisions(in: node.type)
        for child in node.children {
            try rejectCollisions(in: child)
        }
    }

    private func rejectCollisions(in type: ResolvedType) throws {
        switch type {
        case .record(let name, let fields, let additionalPropertiesType, let embeddedUnion):
            try requireDistinct("field", in: "type '\(name)'", fields.map(\.name), identifier: escapedSwiftName)
            for field in fields {
                try rejectCollisions(in: field.type)
            }
            if let additionalPropertiesType {
                try rejectCollisions(in: additionalPropertiesType)
            }
            if let embeddedUnion {
                try rejectCollisions(in: embeddedUnion)
            }
        case .enum(let name, let values):
            try requireDistinct("enum value", in: "enum '\(name)'", values, identifier: { enumCaseName($0) })
        case .list(let elementType, _):
            try rejectCollisions(in: elementType)
        case .nullable(let inner):
            try rejectCollisions(in: inner)
        case .map(let valueType):
            try rejectCollisions(in: valueType)
        case .union(let name, let variants, _):
            for variant in variants {
                try requireDistinct(
                    "field", in: "variant '\(variant.name)' of '\(name)'",
                    variant.fields.map(\.name), identifier: escapedSwiftName
                )
                for field in variant.fields {
                    try rejectCollisions(in: field.type)
                }
                if let additionalPropertiesType = variant.additionalPropertiesType {
                    try rejectCollisions(in: additionalPropertiesType)
                }
                if let embeddedUnion = variant.embeddedUnion {
                    try rejectCollisions(in: embeddedUnion)
                }
                for node in variant.nestedTypes {
                    try rejectCollisions(in: node)
                }
            }
        case .transferable(_, let typeArgs):
            // A provider enum numbers its cases apart rather than colliding.
            for arg in typeArgs {
                if case .enum = arg { continue }
                try rejectCollisions(in: arg)
            }
        case .primitive, .formattedType, .typeReference:
            break
        }
    }

    /// The case an enum value generates: its camelCase name, with a keyword such as `default`
    /// backticked.
    func enumCaseName(_ value: String) -> String {
        escapedSwiftName(camelCase(value))
    }

    /// The declaration of the case an enum value generates. A value that is not the case's name
    /// as written keeps its wire spelling as the case's escaped raw value.
    func enumCaseDeclaration(_ value: String) -> String {
        let caseName = enumCaseName(value)
        let unescaped = caseName.trimmingCharacters(in: CharacterSet(charactersIn: "`"))
        return unescaped == value ? "case \(caseName)" : "case \(caseName) = \(swiftStringLiteral(value))"
    }

    private func requireDistinct(
        _ kind: String,
        in scope: String,
        _ names: [String],
        identifier: (String) -> String
    ) throws {
        var claimed: [String: String] = [:]
        for name in names {
            let ident = identifier(name)
            if let prior = claimed[ident] {
                guard prior == name else {
                    throw CodegenError.unsupportedSchema(
                        "The \(kind)s '\(escapedForDiagnostic(prior))' and '\(escapedForDiagnostic(name))'"
                            + " in \(escapedForDiagnostic(scope)) both generate the identifier '\(ident)'."
                            + " Rename one in the spec."
                    )
                }
            } else {
                claimed[ident] = name
            }
        }
    }
}
