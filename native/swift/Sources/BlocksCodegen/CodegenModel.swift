//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Resolved Codegen Model

/// A fully resolved, language-independent type ready for translation to Swift.
indirect enum ResolvedType {
    case primitive(PrimitiveKind, constraints: Constraints = .empty)
    /// A type whose Swift representation is determined by the JSON Schema
    /// `format` keyword (e.g. `format: "date-time"` → `Date`).
    case formattedType(FormatKind, constraints: Constraints = .empty)
    /// Named record. When `additionalPropertiesType` is non-nil the record is
    /// "open" — the spec declared `T & Record<string, V>`. Codegen emits an
    /// `attributes: [String: V]` field and overrides Codable so that map
    /// flattens at the JSON top level. When `embeddedUnion` is set, the
    /// record carries an inner discriminated union flattened at the same
    /// JSON envelope (one `oneOf` arm holds outer fields + nested oneOf —
    /// see Cognito's regrouped `confirmSignIn` arm).
    case record(name: String, fields: [ResolvedField], additionalPropertiesType: ResolvedType?, embeddedUnion: ResolvedType?)
    case `enum`(name: String, values: [String])
    case list(elementType: ResolvedType, constraints: Constraints = .empty)
    case nullable(inner: ResolvedType)
    case union(name: String, variants: [UnionVariant], discriminator: DiscriminatorInfo?)
    case typeReference(name: String)
    case transferable(blocksType: String, typeArgs: [ResolvedType])
    case map(valueType: ResolvedType)
}

/// Format keyword mappings that produce a non-`String` Swift type.
enum FormatKind {
    case dateTime  // → Foundation.Date
    case date      // → Foundation.Date (via ISO 8601 day-only)
    case time      // → String (Foundation has no time-only type)
    case uuid      // → Foundation.UUID
    case uri       // → Foundation.URL
}

/// JSON Schema constraint annotations carried alongside a primitive / list type.
/// Code generation may emit `precondition` checks at construct time when these
/// are set; today they are decoded but only the `format` field is consumed
/// (mapped into `ResolvedType.formattedType` upstream).
struct Constraints: Equatable {
    let format: String?
    let minLength: Int?
    let maxLength: Int?
    let pattern: String?
    let minimum: Double?
    let maximum: Double?
    let exclusiveMinimum: Double?
    let exclusiveMaximum: Double?
    let multipleOf: Double?
    let minItems: Int?
    let maxItems: Int?

    init(
        format: String? = nil,
        minLength: Int? = nil,
        maxLength: Int? = nil,
        pattern: String? = nil,
        minimum: Double? = nil,
        maximum: Double? = nil,
        exclusiveMinimum: Double? = nil,
        exclusiveMaximum: Double? = nil,
        multipleOf: Double? = nil,
        minItems: Int? = nil,
        maxItems: Int? = nil
    ) {
        self.format = format
        self.minLength = minLength
        self.maxLength = maxLength
        self.pattern = pattern
        self.minimum = minimum
        self.maximum = maximum
        self.exclusiveMinimum = exclusiveMinimum
        self.exclusiveMaximum = exclusiveMaximum
        self.multipleOf = multipleOf
        self.minItems = minItems
        self.maxItems = maxItems
    }

    static let empty = Constraints()

    var isEmpty: Bool { self == Constraints.empty }
}

struct ResolvedField {
    let name: String
    let type: ResolvedType
    let required: Bool
    let description: String?
    /// `default` value from the spec, encoded as raw JSON. Emitted as a Swift
    /// literal default when present (string / number / boolean / null only).
    let defaultValue: String?

    init(name: String, type: ResolvedType, required: Bool, description: String? = nil, defaultValue: String? = nil) {
        self.name = name
        self.type = type
        self.required = required
        self.description = description
        self.defaultValue = defaultValue
    }
}

struct UnionVariant {
    let name: String
    let fields: [ResolvedField]
    let discriminatorValue: String?
    /// Set when the variant payload is an existing named type (e.g. another
    /// union or a typeReference) rather than a fresh inline record. Codegen
    /// uses this to emit `case foo(ExistingType)` instead of synthesizing
    /// a new struct with `fields`.
    let payloadTypeName: String?
    /// Open-shape value type (e.g. `String` for `Record<string, string>`)
    /// when the variant's spec entry carried `additionalProperties`.
    /// Propagates so the synthesized variant struct gets the same
    /// `attributes: [String: V]` treatment as a top-level open record.
    let additionalPropertiesType: ResolvedType?
    /// Inner discriminated alternative whose fields flatten into the same
    /// JSON envelope (regrouped union arm). Codegen emits a merged Codable
    /// for the synthesized variant struct.
    let embeddedUnion: ResolvedType?
    /// Types declared inside this variant's fields that should be scoped
    /// under the variant struct (e.g. `NextStep` inside `IsSignedInFalse`).
    let nestedTypes: [NestedTypeNode]

    init(name: String, fields: [ResolvedField], discriminatorValue: String? = nil, payloadTypeName: String? = nil, additionalPropertiesType: ResolvedType? = nil, embeddedUnion: ResolvedType? = nil, nestedTypes: [NestedTypeNode] = []) {
        self.name = name
        self.fields = fields
        self.discriminatorValue = discriminatorValue
        self.payloadTypeName = payloadTypeName
        self.additionalPropertiesType = additionalPropertiesType
        self.embeddedUnion = embeddedUnion
        self.nestedTypes = nestedTypes
    }
}

struct DiscriminatorInfo {
    let fieldName: String
    let variants: [String: String] // discriminator value → variant name
}

// MARK: - Operations

struct OperationParameter {
    let name: String
    let type: ResolvedType
    let required: Bool
    let description: String?

    init(name: String, type: ResolvedType, required: Bool, description: String? = nil) {
        self.name = name
        self.type = type
        self.required = required
        self.description = description
    }
}

struct OperationResult {
    let type: ResolvedType
    let description: String?

    init(type: ResolvedType, description: String? = nil) {
        self.type = type
        self.description = description
    }
}

struct Operation {
    let name: String
    let parameters: [OperationParameter]
    let result: OperationResult
    let description: String?
    let nestedTypes: [NestedTypeNode]

    init(name: String, parameters: [OperationParameter], result: OperationResult, description: String? = nil, nestedTypes: [NestedTypeNode] = []) {
        self.name = name
        self.parameters = parameters
        self.result = result
        self.description = description
        self.nestedTypes = nestedTypes
    }
}

struct NestedTypeNode {
    let name: String
    let type: ResolvedType
    let children: [NestedTypeNode]

    init(name: String, type: ResolvedType, children: [NestedTypeNode] = []) {
        self.name = name
        self.type = type
        self.children = children
    }
}

struct APINamespace {
    let name: String
    let operations: [Operation]
}

// MARK: - Type Definitions

struct TypeDefinition {
    let name: String
    let type: ResolvedType
    let shortName: String

    init(name: String, type: ResolvedType, shortName: String? = nil) {
        self.name = name
        self.type = type
        self.shortName = shortName ?? name
    }
}

// MARK: - Root Model

public struct CodegenModel {
    let apiNamespaces: [APINamespace]
    let typeDefinitions: [TypeDefinition]
    let servers: [ServerDefinition]
}
