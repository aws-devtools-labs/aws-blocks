//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Parser Output Model

/// A reference to a type as parsed from the spec. Not yet resolved.
indirect enum TypeRef {
    case primitive(kind: PrimitiveKind, constraints: Constraints = .empty)
    /// Object with named fields. When `additionalProperties` is non-nil the
    /// shape is open — the spec declared `T & Record<string, V>` so customers
    /// can pass arbitrary extra string-keyed values (e.g. Cognito custom
    /// attributes on sign-up). The value type is `V`.
    /// `embeddedUnion` carries an inner `oneOf` flattened at the top level —
    /// produced by the spec emitter's regroup pass for `{ action: K } & U[K]`
    /// shapes (e.g. Cognito's `confirmSignIn` with seven challenge bodies).
    /// The inner union shares the JSON envelope with the outer fields; codegen
    /// merges them at encode/decode time.
    case inlineObject(fields: [Field], additionalProperties: TypeRef?, embeddedUnion: TypeRef?)
    case unionLiteral(values: [String])
    case arrayType(elementType: TypeRef, constraints: Constraints = .empty)
    case nullable(inner: TypeRef)
    /// Sum type (`oneOf`). Discriminator detection happens later in the
    /// builder by inspecting members for shared single-literal fields.
    case union(members: [TypeRef])
    case schemaRef(name: String, resolved: TypeRef?)
    case transferable(blocksType: String, typeArgs: [TypeRef])
    /// `Record<string, T>` from JSON Schema's `additionalProperties` with no
    /// fixed properties. Renders as `[String: T]` in Swift.
    case mapType(valueType: TypeRef)
}

/// Native Swift primitives. `format`-specialized types (uuid, dateTime, url)
/// are NOT in this enum — they live as `ResolvedType.formattedType` so they
/// can carry their own constraint set and round-trip through Foundation's
/// dedicated parsers.
enum PrimitiveKind: String {
    case string, boolean, integer, number, void, unknown
}

struct Field {
    let name: String
    let type: TypeRef
    let required: Bool
    let description: String?
    /// `default` value from the spec, encoded as raw JSON.
    let defaultValue: String?

    init(name: String, type: TypeRef, required: Bool, description: String? = nil, defaultValue: String? = nil) {
        self.name = name
        self.type = type
        self.required = required
        self.description = description
        self.defaultValue = defaultValue
    }
}

struct ContentDescriptor {
    let name: String
    let schema: TypeRef
    let required: Bool
    let description: String?

    init(name: String, schema: TypeRef, required: Bool = false, description: String? = nil) {
        self.name = name
        self.schema = schema
        self.required = required
        self.description = description
    }
}

struct RPCMethod {
    let name: String
    let params: [ContentDescriptor]
    let result: ContentDescriptor?
    let description: String?

    init(name: String, params: [ContentDescriptor], result: ContentDescriptor?, description: String? = nil) {
        self.name = name
        self.params = params
        self.result = result
        self.description = description
    }
}

struct ServerDefinition {
    let name: String
    let url: String
}

public struct RPCModel {
    let methods: [RPCMethod]
    let servers: [ServerDefinition]
    let componentSchemas: [String: TypeRef]
}
