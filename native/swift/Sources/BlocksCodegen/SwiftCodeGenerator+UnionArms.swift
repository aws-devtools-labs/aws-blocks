//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Union value and literal arms

extension SwiftCodeGenerator {
    /// Whether a value arm's JSON is an object (a map, or a transferable's descriptor), which a discriminated
    /// union's object arms share.
    func decodesFromAnObject(_ type: ResolvedType?) -> Bool {
        switch type {
        case .map, .transferable: return true
        case .nullable(let inner): return decodesFromAnObject(inner)
        default: return false
        }
    }

    /// A value or literal arm: encoded as a bare JSON value, not as an object.
    func isBareValue(_ variant: UnionVariant) -> Bool {
        variant.valueType != nil || variant.literal != nil
    }

    /// The types a value arm declares beside its union: the element struct of `[{…}]`, and an enum arm's enum.
    func valueArmTypes(_ variant: UnionVariant) -> [NestedTypeNode] {
        guard case .enum(let name, let values)? = variant.valueType else { return variant.nestedTypes }
        return variant.nestedTypes + [NestedTypeNode(name: name, type: .enum(name: name, values: values))]
    }

    /// The Swift literal for a JSON literal: `"auto"`, `true`, `5`, `1.5`.
    func swiftLiteral(_ literal: LiteralValue) -> String {
        swiftLiteral(literal.text, kind: literal.kind)
    }

    /// The Swift literal for a literal's JSON text of type `kind`; only a string is quoted (and escaped).
    func swiftLiteral(_ text: String, kind: PrimitiveKind) -> String {
        kind == .string ? "\"\(swiftStringContent(text))\"" : text
    }
}
