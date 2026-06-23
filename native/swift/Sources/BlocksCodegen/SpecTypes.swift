//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Spec Parsing Types

struct OpenRPCSpec: Decodable {
    let methods: [Method]
    let components: Components?
    let servers: [Server]?

    struct Server: Decodable {
        let name: String
        let url: String
    }

    struct Method: Decodable {
        let name: String
        let params: [Param]
        let result: Result
    }

    struct Param: Decodable {
        let name: String
        let required: Bool?
        let schema: JSONSchema
    }

    struct Result: Decodable {
        let name: String
        let schema: JSONSchema
    }

    struct Components: Decodable {
        let schemas: [String: JSONSchema]?
    }
}

// MARK: - Codegen Errors

enum CodegenError: Error, CustomStringConvertible {
    case unsupportedSchema(String)

    var description: String {
        switch self {
        case .unsupportedSchema(let detail):
            return "Unsupported schema: \(detail)"
        }
    }
}

// MARK: - JSONSchema

indirect enum JSONSchema: Decodable {
    case object(properties: [String: JSONSchemaWithMeta]?, required: [String]?, title: String?, additionalProperties: JSONSchema?)
    /// Normal array of one item type. `items` may be nil (empty arrays).
    case array(items: JSONSchema?, minItems: Int?, maxItems: Int?)
    /// Tuple-style array (positional types). Produced when the spec uses
    /// `prefixItems: [...]` or array-form `items: [...]`. Codegen renders
    /// these as a fixed-shape inline object with `item0`, `item1`, …
    case tuple(elements: [JSONSchema])
    case string(enumValues: [String]?, format: String?, minLength: Int?, maxLength: Int?, pattern: String?)
    case number(format: String?, minimum: Double?, maximum: Double?, exclusiveMinimum: Double?, exclusiveMaximum: Double?, multipleOf: Double?)
    case integer(format: String?, minimum: Int?, maximum: Int?)
    case boolean
    case null
    case oneOf([JSONSchema])
    case anyOf([JSONSchema])
    /// Hybrid arm: an `object` schema with fixed properties AND a nested
    /// `oneOf` at the same level. Produced by the spec generator's regroup
    /// pass (see `regroupSharedDiscriminator` in `generate-spec.ts`) for
    /// shapes like `{ action: K } & U[K]` where `U[K]` is itself a union
    /// — e.g. Cognito's `confirmSignIn` action with seven distinct
    /// challenge bodies. The outer fields are common across the inner
    /// arms; codegen emits a single named record carrying those fields
    /// plus a flattened embedded union for the inner alternatives.
    case objectWithOneOf(properties: [String: JSONSchemaWithMeta]?, required: [String]?, title: String?, oneOf: [JSONSchema])
    case ref(String)
    /// A transferable type like RealtimeChannel<T>.
    case transferable(kind: String, typeArgs: [JSONSchema])
    /// A record/map type: `z.record(keySchema, valSchema)` → `additionalProperties` with no `properties`
    case record(valueSchema: JSONSchema)
    /// Constant value (`{"const": "foo"}` or `{"const": 5}` from `z.literal`).
    /// Codegen treats these as a single-value enum so they participate in
    /// discriminator detection.
    case constLiteral(String)

    enum CodingKeys: String, CodingKey {
        case type, properties, required, items, title, format
        case enumValues = "enum"
        case oneOf, anyOf
        case ref = "$ref"
        case blocksTransferable = "x-blocks-transferable"
        case blocksTypeArgs = "x-blocks-type-args"
        case additionalProperties
        case minLength, maxLength, pattern
        case minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf
        case minItems, maxItems
        case prefixItems
        case const
        case readOnly
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)

        // const: any single literal — treat as a single-value enum so it can
        // participate in discriminator detection downstream. We accept any
        // primitive shape (string / number / bool / null) and stringify it.
        if container.contains(.const) {
            let constString = try Self.decodeConstAsString(container: container)
            self = .constLiteral(constString)
            return
        }

        // $ref
        if let refStr = try container.decodeIfPresent(String.self, forKey: .ref) {
            self = .ref(refStr)
            return
        }

        // x-blocks-transferable (e.g. "realtime/channel")
        if let transferableKind = try container.decodeIfPresent(String.self, forKey: .blocksTransferable) {
            let typeArgs = try container.decodeIfPresent([JSONSchema].self, forKey: .blocksTypeArgs) ?? []
            self = .transferable(kind: transferableKind, typeArgs: typeArgs)
            return
        }

        // oneOf — but if `type: "object"` is also present, this is a hybrid
        // arm (regrouped union) and we must keep the outer object fields.
        if let schemas = try container.decodeIfPresent([JSONSchema].self, forKey: .oneOf) {
            let outerType = try container.decodeIfPresent(String.self, forKey: .type)
            if outerType == "object" {
                let props = try container.decodeIfPresent([String: JSONSchemaWithMeta].self, forKey: .properties)
                let req = try container.decodeIfPresent([String].self, forKey: .required)
                let title = try container.decodeIfPresent(String.self, forKey: .title)
                self = .objectWithOneOf(properties: props, required: req, title: title, oneOf: schemas)
                return
            }
            self = .oneOf(schemas)
            return
        }

        // anyOf — treat same as oneOf
        if let schemas = try container.decodeIfPresent([JSONSchema].self, forKey: .anyOf) {
            self = .anyOf(schemas)
            return
        }

        // prefixItems (tuple). Multi-element prefixItems map to a tuple
        // inline-object with positional fields (item0, item1, …).
        if let prefixItems = try container.decodeIfPresent([JSONSchema].self, forKey: .prefixItems) {
            if prefixItems.count == 1 {
                self = .array(items: prefixItems[0], minItems: nil, maxItems: nil)
            } else {
                self = .tuple(elements: prefixItems)
            }
            return
        }

        let type = try container.decodeIfPresent(String.self, forKey: .type)

        switch type {
        case "object":
            let props = try container.decodeIfPresent([String: JSONSchemaWithMeta].self, forKey: .properties)
            let req = try container.decodeIfPresent([String].self, forKey: .required)
            let title = try container.decodeIfPresent(String.self, forKey: .title)
            let additionalProps = try container.decodeIfPresent(JSONSchema.self, forKey: .additionalProperties)

            // If no properties but has additionalProperties → it's a record/map type
            if (props == nil || props?.isEmpty == true) && additionalProps != nil {
                self = .record(valueSchema: additionalProps!)
            } else {
                self = .object(properties: props, required: req, title: title, additionalProperties: additionalProps)
            }

        case "array":
            // items can be a single schema (normal array) or an array of schemas (tuple)
            if let single = try? container.decodeIfPresent(JSONSchema.self, forKey: .items) {
                let minItems = try container.decodeIfPresent(Int.self, forKey: .minItems)
                let maxItems = try container.decodeIfPresent(Int.self, forKey: .maxItems)
                self = .array(items: single, minItems: minItems, maxItems: maxItems)
            } else if let arr = try? container.decodeIfPresent([JSONSchema].self, forKey: .items) {
                if arr.count == 1 {
                    let minItems = try container.decodeIfPresent(Int.self, forKey: .minItems)
                    let maxItems = try container.decodeIfPresent(Int.self, forKey: .maxItems)
                    self = .array(items: arr[0], minItems: minItems, maxItems: maxItems)
                } else {
                    self = .tuple(elements: arr)
                }
            } else {
                let minItems = try container.decodeIfPresent(Int.self, forKey: .minItems)
                let maxItems = try container.decodeIfPresent(Int.self, forKey: .maxItems)
                self = .array(items: nil, minItems: minItems, maxItems: maxItems)
            }

        case "string":
            let enumVals = try container.decodeIfPresent([String].self, forKey: .enumValues)
            let format = try container.decodeIfPresent(String.self, forKey: .format)
            let minLength = try container.decodeIfPresent(Int.self, forKey: .minLength)
            let maxLength = try container.decodeIfPresent(Int.self, forKey: .maxLength)
            let pattern = try container.decodeIfPresent(String.self, forKey: .pattern)
            self = .string(enumValues: enumVals, format: format, minLength: minLength, maxLength: maxLength, pattern: pattern)

        case "integer":
            let format = try container.decodeIfPresent(String.self, forKey: .format)
            let minimum = try container.decodeIfPresent(Int.self, forKey: .minimum)
            let maximum = try container.decodeIfPresent(Int.self, forKey: .maximum)
            self = .integer(format: format, minimum: minimum, maximum: maximum)

        case "number":
            let format = try container.decodeIfPresent(String.self, forKey: .format)
            let minimum = try container.decodeIfPresent(Double.self, forKey: .minimum)
            let maximum = try container.decodeIfPresent(Double.self, forKey: .maximum)
            let exclusiveMinimum = try container.decodeIfPresent(Double.self, forKey: .exclusiveMinimum)
            let exclusiveMaximum = try container.decodeIfPresent(Double.self, forKey: .exclusiveMaximum)
            let multipleOf = try container.decodeIfPresent(Double.self, forKey: .multipleOf)
            self = .number(format: format, minimum: minimum, maximum: maximum, exclusiveMinimum: exclusiveMinimum, exclusiveMaximum: exclusiveMaximum, multipleOf: multipleOf)

        case "boolean":
            // Handle boolean enum (e.g. "type": "boolean", "enum": [true]) — used as discriminator
            if let vals = try? container.decodeIfPresent([Bool].self, forKey: .enumValues), !vals.isEmpty {
                self = .constLiteral(vals[0] ? "true" : "false")
            } else {
                self = .boolean
            }

        case "null":
            self = .null

        default:
            self = .object(properties: nil, required: nil, title: nil, additionalProperties: nil)
        }
    }

    /// Decode any `const` value as a string, regardless of underlying JSON
    /// type. Strings are taken verbatim; numbers / booleans / null are
    /// rendered with the same form they would take in the JSON wire payload.
    private static func decodeConstAsString(container: KeyedDecodingContainer<CodingKeys>) throws -> String {
        if let s = try? container.decode(String.self, forKey: .const) { return s }
        if let i = try? container.decode(Int.self, forKey: .const) { return String(i) }
        if let d = try? container.decode(Double.self, forKey: .const) { return String(d) }
        if let b = try? container.decode(Bool.self, forKey: .const) { return String(b) }
        if try container.decodeNil(forKey: .const) { return "null" }
        // Fallback: re-encode the raw JSON value as text for diagnostics.
        let raw = try container.decode(RawJSON.self, forKey: .const)
        return raw.encodedString
    }
}

// MARK: - Schema with field-level metadata

/// `JSONSchema` plus field-level metadata (`description`, `default`) that
/// only makes sense at the property level. Decoded by `JSONSchema`'s
/// `properties` keyed container so individual field defaults survive into
/// the IR.
struct JSONSchemaWithMeta: Decodable {
    let schema: JSONSchema
    let description: String?
    /// Raw JSON for the `default` keyword if present, so codegen can emit
    /// it as a Swift literal default.
    let defaultValue: RawJSON?

    enum CodingKeys: String, CodingKey {
        case description
        case defaultValue = "default"
    }

    init(from decoder: Decoder) throws {
        // The same JSON object IS the schema; metadata fields live alongside
        // the schema-defining keywords.
        self.schema = try JSONSchema(from: decoder)
        let container = try? decoder.container(keyedBy: CodingKeys.self)
        self.description = try container?.decodeIfPresent(String.self, forKey: .description)
        self.defaultValue = try container?.decodeIfPresent(RawJSON.self, forKey: .defaultValue)
    }
}

// MARK: - RawJSON

/// Type-erased JSON value used for `default` and unrecognised `const`
/// payloads. Re-encodes to a stable JSON-literal string so codegen can
/// inline it as a Swift literal default.
struct RawJSON: Decodable {
    let encodedString: String

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if container.decodeNil() {
            self.encodedString = "null"
        } else if let v = try? container.decode(Bool.self) {
            self.encodedString = v ? "true" : "false"
        } else if let v = try? container.decode(Int.self) {
            self.encodedString = String(v)
        } else if let v = try? container.decode(Double.self) {
            self.encodedString = String(v)
        } else if let v = try? container.decode(String.self) {
            // Re-encode as a JSON string literal so callers can inline it.
            let data = try JSONEncoder().encode(v)
            self.encodedString = String(data: data, encoding: .utf8) ?? "\"\(v)\""
        } else if let v = try? container.decode([RawJSON].self) {
            self.encodedString = "[" + v.map { $0.encodedString }.joined(separator: ",") + "]"
        } else if let v = try? container.decode([String: RawJSON].self) {
            let inner = v.map { "\"\($0.key)\":\($0.value.encodedString)" }.joined(separator: ",")
            self.encodedString = "{" + inner + "}"
        } else {
            self.encodedString = "null"
        }
    }
}
