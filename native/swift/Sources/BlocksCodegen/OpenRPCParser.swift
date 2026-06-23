//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Stage 1: OpenRPC Parser
//
// Stateless parser that deserializes JSON into an RPCModel.
// Handles: method extraction, $ref resolution, type mapping, constraint
// extraction, transferable detection, nullability, enum / const detection,
// and tuple-form arrays.

public struct OpenRPCParser {
    public init() {}

    public func parse(data: Data) throws -> RPCModel {
        let spec = try JSONDecoder().decode(OpenRPCSpec.self, from: data)

        // Resolve component schemas
        var componentSchemas: [String: TypeRef] = [:]
        if let schemas = spec.components?.schemas {
            for (name, jsonSchema) in schemas {
                componentSchemas[name] = mapTypeRef(jsonSchema)
            }
        }

        // Parse methods
        let methods = spec.methods.map { method -> RPCMethod in
            let params = method.params.map { param -> ContentDescriptor in
                ContentDescriptor(
                    name: param.name,
                    schema: mapTypeRef(param.schema),
                    required: param.required ?? false
                )
            }

            let result = ContentDescriptor(
                name: method.result.name,
                schema: mapTypeRef(method.result.schema),
                required: true
            )

            return RPCMethod(name: method.name, params: params, result: result)
        }

        let servers = (spec.servers ?? []).map { ServerDefinition(name: $0.name, url: $0.url) }

        return RPCModel(methods: methods, servers: servers, componentSchemas: componentSchemas)
    }

    // MARK: - TypeRef Mapping

    private func mapTypeRef(_ schema: JSONSchema) -> TypeRef {
        switch schema {
        case .string(let enumValues, let format, let minLength, let maxLength, let pattern):
            if let vals = enumValues, !vals.isEmpty {
                return .unionLiteral(values: vals)
            }
            let constraints = Constraints(
                format: format,
                minLength: minLength,
                maxLength: maxLength,
                pattern: pattern
            )
            return .primitive(kind: .string, constraints: constraints)

        case .number(let format, let minimum, let maximum, let exclusiveMinimum, let exclusiveMaximum, let multipleOf):
            let constraints = Constraints(
                format: format,
                minimum: minimum,
                maximum: maximum,
                exclusiveMinimum: exclusiveMinimum,
                exclusiveMaximum: exclusiveMaximum,
                multipleOf: multipleOf
            )
            return .primitive(kind: .number, constraints: constraints)

        case .integer(let format, let minimum, let maximum):
            let constraints = Constraints(
                format: format,
                minimum: minimum.map { Double($0) },
                maximum: maximum.map { Double($0) }
            )
            return .primitive(kind: .integer, constraints: constraints)

        case .boolean:
            return .primitive(kind: .boolean)

        case .null:
            return .primitive(kind: .void)

        case .constLiteral(let value):
            // `z.literal("foo")` collapses to a single-value enum so it can
            // participate in discriminator detection downstream.
            return .unionLiteral(values: [value])

        case .array(let items, let minItems, let maxItems):
            let elementType = items.map { mapTypeRef($0) } ?? .primitive(kind: .unknown)
            let constraints = Constraints(minItems: minItems, maxItems: maxItems)
            return .arrayType(elementType: elementType, constraints: constraints)

        case .tuple(let elements):
            // Multi-element tuples render as a positional inline-object with
            // synthesized fields `item0`, `item1`, … .
            let fields = elements.enumerated().map { idx, element -> Field in
                Field(name: "item\(idx)", type: mapTypeRef(element), required: true)
            }
            return .inlineObject(fields: fields, additionalProperties: nil, embeddedUnion: nil)

        case .object(let properties, let required, _, let additionalProperties):
            let fields = (properties ?? [:]).map { name, prop -> Field in
                let isRequired = (required ?? []).contains(name)
                return Field(
                    name: name,
                    type: mapTypeRef(prop.schema),
                    required: isRequired,
                    description: prop.description,
                    defaultValue: prop.defaultValue?.encodedString
                )
            }.sorted { $0.name < $1.name }
            // Mixed shape: fixed fields + additionalProperties (e.g. Cognito
            // sign-up's `{username, password} & Record<string, string>`).
            let addProps = additionalProperties.map { mapTypeRef($0) }
            return .inlineObject(fields: fields, additionalProperties: addProps, embeddedUnion: nil)

        case .objectWithOneOf(let properties, let required, _, let schemas):
            // Hybrid arm: outer object fields + nested oneOf flattened at the
            // same JSON level. Surfaced as an inline object whose
            // `embeddedUnion` carries the inner alternatives. Codegen merges
            // them into a single Codable struct with discriminator-driven
            // encode/decode of the embedded variants.
            let outerFields = (properties ?? [:]).map { name, prop -> Field in
                let isRequired = (required ?? []).contains(name)
                return Field(
                    name: name,
                    type: mapTypeRef(prop.schema),
                    required: isRequired,
                    description: prop.description,
                    defaultValue: prop.defaultValue?.encodedString
                )
            }.sorted { $0.name < $1.name }
            let innerMembers = schemas.map { mapTypeRef($0) }
            let embedded: TypeRef = .union(members: innerMembers)
            return .inlineObject(fields: outerFields, additionalProperties: nil, embeddedUnion: embedded)

        case .record(let valueSchema):
            return .mapType(valueType: mapTypeRef(valueSchema))

        case .oneOf(let schemas):
            // Detect nullable pattern: oneOf [T, null]
            let nonNull = schemas.filter { if case .null = $0 { return false }
            return true
            }
            if nonNull.count == 1, schemas.count == 2 {
                return .nullable(inner: mapTypeRef(nonNull[0]))
            }
            return .union(members: schemas.map { mapTypeRef($0) })

        case .anyOf(let schemas):
            // Treat anyOf same as oneOf.
            let nonNull = schemas.filter { if case .null = $0 { return false }
            return true
            }
            if nonNull.count == 1, schemas.count == 2 {
                return .nullable(inner: mapTypeRef(nonNull[0]))
            }
            return .union(members: schemas.map { mapTypeRef($0) })

        case .ref(let refStr):
            let name = refStr.components(separatedBy: "/").last ?? "Unknown"
            return .schemaRef(name: name, resolved: nil)

        case .transferable(let kind, let typeArgs):
            return .transferable(blocksType: kind, typeArgs: typeArgs.map { mapTypeRef($0) })
        }
    }
}
