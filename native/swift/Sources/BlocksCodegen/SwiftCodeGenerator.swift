//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Stage 3: Swift Code Generator
//
// Thin translation layer that emits Swift source from a CodegenModel.
// Makes no business logic decisions — only Swift-specific formatting.

public struct SwiftCodeGenerator {
    public init() {}

    public func generate(from model: CodegenModel) -> (models: String, api: String) {
        var modelLines: [String] = ["import Foundation", ""]
        var apiLines: [String] = ["import Foundation", "import BlocksRuntime", ""]
        var emittedTypes: Set<String> = []

        // Generate type definitions (component schemas only — flat in Models.swift)
        for typeDef in model.typeDefinitions {
            emitType(typeDef.type, name: typeDef.name, lines: &modelLines, emitted: &emittedTypes)
        }

        // Build per-operation qualified-name lookup from nested types.
        // Types nest inside operation enums inside the class, so the qualified
        // path is just `OperationName.TypeName` (the class itself is the scope).
        var operationQualifiedNames: [String: [String: String]] = [:]
        for namespace in model.apiNamespaces {
            for operation in namespace.operations {
                let opName = pascalCase(operation.name)
                let opKey = "\(namespace.name).\(operation.name)"
                var nameMap: [String: String] = [:]
                func walkNodes(_ nodes: [NestedTypeNode], parentPath: String) {
                    for node in nodes {
                        let path = "\(parentPath).\(node.name)"
                        nameMap[node.name] = path
                        walkNodes(node.children, parentPath: path)
                    }
                }
                walkNodes(operation.nestedTypes, parentPath: opName)
                operationQualifiedNames[opKey] = nameMap
            }
        }

        // Default server name for init parameter default
        let defaultServerName = model.servers.first.map { "Servers.\(camelCase($0.name))" } ?? "Servers.local"

        // Generate one class per namespace
        for namespace in model.apiNamespaces {
            let nsName = pascalCase(namespace.name)
            apiLines.append("public class \(nsName) {")
            apiLines.append("    private let client: BlocksClient")
            apiLines.append("")
            apiLines.append("    public init(server: BlocksServer = \(defaultServerName)) {")
            apiLines.append("        self.client = BlocksClient(server: server)")
            apiLines.append("    }")

            for operation in namespace.operations {
                apiLines.append("")
                let opKey = "\(namespace.name).\(operation.name)"
                let opQualified = operationQualifiedNames[opKey] ?? [:]
                emitOperation(operation, namespace: namespace.name, prefixNamespace: false, lines: &apiLines, emitted: &emittedTypes, modelLines: &modelLines, qualifiedNames: opQualified)
            }

            // Emit nested types as operation enums inside the class
            for operation in namespace.operations where !operation.nestedTypes.isEmpty {
                apiLines.append("")
                emitOperationEnum(operation: operation, indent: "    ", lines: &apiLines)
            }

            apiLines.append("}")
            apiLines.append("")
        }

        // Generate Servers enum
        apiLines.append("")
        apiLines.append("// MARK: - Servers")
        apiLines.append("")
        apiLines.append("public enum Servers {")
        for server in model.servers {
            let propertyName = camelCase(server.name)
            apiLines.append("    public static let \(propertyName) = BlocksServer(name: \"\(server.name)\", url: \"\(server.url)\")")
        }
        apiLines.append("}")

        // Only include models file content if there are actual type definitions
        let hasTypes = model.typeDefinitions.count > 0
        let modelsContent = hasTypes ? modelLines.joined(separator: "\n") : ""
        let apiContent = apiLines.joined(separator: "\n")
        return (models: modelsContent, api: apiContent)
    }

    // MARK: - Nested Type Emission

    private func emitOperationEnum(operation: Operation, indent: String, lines: inout [String]) {
        let opName = pascalCase(operation.name)
        lines.append("\(indent)public enum \(opName) {")
        for node in operation.nestedTypes {
            emitNestedTypeNode(node, indent: indent + "    ", lines: &lines)
        }
        lines.append("\(indent)}")
    }

    private func emitNestedTypeNode(_ node: NestedTypeNode, indent: String, lines: inout [String]) {
        switch node.type {
        case .record(_, let fields, let additionalPropertiesType, let embeddedUnion):
            emitNestedRecordStruct(name: node.name, fields: fields, additionalPropertiesType: additionalPropertiesType, embeddedUnion: embeddedUnion, children: node.children, indent: indent, lines: &lines)
        case .enum(_, let values):
            lines.append("")
            lines.append("\(indent)public enum \(node.name): String, Codable {")
            for val in values {
                let caseName = camelCase(val)
                if caseName != val {
                    lines.append("\(indent)    case \(caseName) = \"\(val)\"")
                } else {
                    lines.append("\(indent)    case \(caseName)")
                }
            }
            lines.append("\(indent)}")
        case .union(_, let variants, let discriminator):
            emitNestedUnion(name: node.name, variants: variants, discriminator: discriminator, children: node.children, indent: indent, lines: &lines)
        default:
            break
        }
    }

    private func emitNestedRecordStruct(name: String, fields: [ResolvedField], additionalPropertiesType: ResolvedType?, embeddedUnion: ResolvedType?, children: [NestedTypeNode], indent: String, lines: inout [String]) {
        let fields = fields.filter { !isVoidType($0.type) }
        lines.append("")
        lines.append("\(indent)public struct \(name): Codable {")
        for field in fields {
            let swType = swiftTypeNameNoEmit(field.type)
            let alreadyOptional = swType.hasSuffix("?")
            let optSuffix = (!field.required && !alreadyOptional) ? "?" : ""
            lines.append("\(indent)    public let \(escapedSwiftName(field.name)): \(swType)\(optSuffix)")
        }
        if let addPropsType = additionalPropertiesType {
            let valueType = swiftTypeNameNoEmit(addPropsType)
            lines.append("\(indent)    public let attributes: [String: \(valueType)]")
        }
        if let embedded = embeddedUnion, case .union(let unionName, _, _) = embedded {
            lines.append("\(indent)    public let challenge: \(unionName)")
        }

        let needsCodingKeys = fields.contains { escapedSwiftName($0.name) != $0.name }
        let isOpen = additionalPropertiesType != nil
        let hasEmbedded = embeddedUnion != nil
        let hasOptionalFields = fields.contains { !$0.required || swiftTypeNameNoEmit($0.type).hasSuffix("?") }

        if !isOpen && !hasEmbedded && (needsCodingKeys || hasOptionalFields) {
            lines.append("")
            lines.append("\(indent)    enum CodingKeys: String, CodingKey {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                if safe != field.name {
                    lines.append("\(indent)        case \(safe) = \"\(field.name)\"")
                } else {
                    lines.append("\(indent)        case \(safe)")
                }
            }
            lines.append("\(indent)    }")
        }

        if !isOpen && !hasEmbedded && hasOptionalFields {
            lines.append("")
            lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
            lines.append("\(indent)        var c = encoder.container(keyedBy: CodingKeys.self)")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                let swType = swiftTypeNameNoEmit(field.type)
                let alreadyOptional = swType.hasSuffix("?")
                if field.required && !alreadyOptional {
                    lines.append("\(indent)        try c.encode(self.\(safe), forKey: .\(safe))")
                } else {
                    lines.append("\(indent)        try c.encodeIfPresent(self.\(safe), forKey: .\(safe))")
                }
            }
            lines.append("\(indent)    }")
        }

        // Emit embedded union as a nested type
        if let embedded = embeddedUnion, case .union(let unionName, let variants, let disc) = embedded {
            emitNestedUnion(name: unionName, variants: variants, discriminator: disc, children: [], indent: indent + "    ", lines: &lines)
            // Emit merged Codable for embedded union support
            lines.append("")
            lines.append("\(indent)    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)), challenge: \(unionName)) {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                lines.append("\(indent)        self.\(safe) = \(safe)")
            }
            lines.append("\(indent)        self.challenge = challenge")
            lines.append("\(indent)    }")
            lines.append("")
            lines.append("\(indent)    private enum OuterCodingKeys: String, CodingKey {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                if safe != field.name {
                    lines.append("\(indent)        case \(safe) = \"\(field.name)\"")
                } else {
                    lines.append("\(indent)        case \(safe)")
                }
            }
            lines.append("\(indent)    }")
            lines.append("")
            lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
            lines.append("\(indent)        var c = encoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                if field.required {
                    lines.append("\(indent)        try c.encode(self.\(safe), forKey: .\(safe))")
                } else {
                    lines.append("\(indent)        try c.encodeIfPresent(self.\(safe), forKey: .\(safe))")
                }
            }
            lines.append("\(indent)        try self.challenge.encode(to: encoder)")
            lines.append("\(indent)    }")
            lines.append("")
            lines.append("\(indent)    public init(from decoder: Decoder) throws {")
            lines.append("\(indent)        let c = try decoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                let swType = swiftTypeNameNoEmit(field.type)
                let alreadyOptional = swType.hasSuffix("?")
                let baseType = alreadyOptional ? String(swType.dropLast()) : swType
                if field.required && !alreadyOptional {
                    lines.append("\(indent)        self.\(safe) = try c.decode(\(baseType).self, forKey: .\(safe))")
                } else {
                    lines.append("\(indent)        self.\(safe) = try c.decodeIfPresent(\(baseType).self, forKey: .\(safe))")
                }
            }
            lines.append("\(indent)        self.challenge = try \(unionName)(from: decoder)")
            lines.append("\(indent)    }")
        }

        // Emit explicit init if any field needs validation or has defaults
        let needsExplicitInit = !isOpen && !hasEmbedded
            && fields.contains(where: { fieldNeedsExplicitInit($0) })
        if needsExplicitInit {
            let hasValidation = fields.contains { !constraintValidationLines(field: $0, accessor: escapedSwiftName($0.name)).isEmpty }
            lines.append("")
            lines.append("\(indent)    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)))\(hasValidation ? " throws" : "") {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                let validationLines = constraintValidationLines(field: field, accessor: safe)
                for line in validationLines {
                    lines.append("\(indent)        \(line)")
                }
                lines.append("\(indent)        self.\(safe) = \(safe)")
            }
            lines.append("\(indent)    }")
        }

        // Emit children as nested types inside this struct
        for child in children {
            emitNestedTypeNode(child, indent: indent + "    ", lines: &lines)
        }

        lines.append("\(indent)}")
    }

    private func emitNestedUnion(name: String, variants: [UnionVariant], discriminator: DiscriminatorInfo?, children: [NestedTypeNode], indent: String, lines: inout [String]) {
        // Emit variant structs before the enum
        for variant in variants {
            guard !variant.fields.isEmpty || variant.additionalPropertiesType != nil || variant.embeddedUnion != nil || !variant.nestedTypes.isEmpty else { continue }
            if variant.payloadTypeName != nil { continue }
            emitNestedRecordStruct(name: variant.name, fields: variant.fields, additionalPropertiesType: variant.additionalPropertiesType, embeddedUnion: variant.embeddedUnion, children: variant.nestedTypes, indent: indent, lines: &lines)
        }

        lines.append("")
        lines.append("\(indent)public enum \(name): Codable {")
        for variant in variants {
            let caseName = camelCase(variant.name)
            let hasSynthBody = !variant.fields.isEmpty || variant.additionalPropertiesType != nil || variant.embeddedUnion != nil
            let payloadType = variant.payloadTypeName ?? (hasSynthBody ? variant.name : nil)
            if let payload = payloadType {
                lines.append("\(indent)    case \(caseName)(\(payload))")
            } else {
                lines.append("\(indent)    case \(caseName)")
            }
        }
        // TODO: Full Codable emission for nested unions (discriminated + transparent)
        // For now, emit a minimal stub — the full logic from emitDiscriminatedCoding/emitTransparentUnionCoding
        // will be needed for complete correctness.
        if let disc = discriminator {
            emitDiscriminatedCodingNested(name: name, variants: variants, discriminator: disc, indent: indent, lines: &lines)
        } else {
            emitTransparentUnionCodingNested(name: name, variants: variants, indent: indent, lines: &lines)
        }
        lines.append("\(indent)}")

        // Emit children
        for child in children {
            emitNestedTypeNode(child, indent: indent + "    ", lines: &lines)
        }
    }

    private func emitDiscriminatedCodingNested(name: String, variants: [UnionVariant], discriminator: DiscriminatorInfo, indent: String, lines: inout [String]) {
        lines.append("")
        lines.append("\(indent)    enum CodingKeys: String, CodingKey {")
        lines.append("\(indent)        case \(escapedSwiftName(discriminator.fieldName))")
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
        lines.append("\(indent)        var container = encoder.container(keyedBy: CodingKeys.self)")
        lines.append("\(indent)        switch self {")
        for variant in variants {
            if let discVal = variant.discriminatorValue {
                let hasSynthBody = !variant.fields.isEmpty || variant.additionalPropertiesType != nil || variant.embeddedUnion != nil
                let hasPayload = variant.payloadTypeName != nil || hasSynthBody
                if !hasPayload {
                    lines.append("\(indent)        case .\(camelCase(variant.name)):")
                    lines.append("\(indent)            try container.encode(\"\(discVal)\", forKey: .\(escapedSwiftName(discriminator.fieldName)))")
                } else {
                    lines.append("\(indent)        case .\(camelCase(variant.name))(let params):")
                    lines.append("\(indent)            try container.encode(\"\(discVal)\", forKey: .\(escapedSwiftName(discriminator.fieldName)))")
                    lines.append("\(indent)            try params.encode(to: encoder)")
                }
            }
        }
        lines.append("\(indent)        }")
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    public init(from decoder: Decoder) throws {")
        lines.append("\(indent)        let container = try decoder.container(keyedBy: CodingKeys.self)")
        lines.append("\(indent)        let disc = try container.decode(String.self, forKey: .\(escapedSwiftName(discriminator.fieldName)))")
        lines.append("\(indent)        switch disc {")
        var byTag: [String: [UnionVariant]] = [:]
        var tagOrder: [String] = []
        for v in variants {
            guard let tag = v.discriminatorValue else { continue }
            if byTag[tag] == nil { tagOrder.append(tag) }
            byTag[tag, default: []].append(v)
        }
        for tag in tagOrder {
            let group = byTag[tag] ?? []
            if group.count == 1 {
                let variant = group[0]
                let hasSynthBody = !variant.fields.isEmpty || variant.additionalPropertiesType != nil || variant.embeddedUnion != nil
                if !hasSynthBody && variant.payloadTypeName == nil {
                    lines.append("\(indent)        case \"\(tag)\": self = .\(camelCase(variant.name))")
                } else {
                    let payload = variant.payloadTypeName ?? variant.name
                    lines.append("\(indent)        case \"\(tag)\": self = .\(camelCase(variant.name))(try \(payload)(from: decoder))")
                }
            } else {
                lines.append("\(indent)        case \"\(tag)\":")
                for (idx, variant) in group.enumerated() {
                    let payload = variant.payloadTypeName ?? variant.name
                    let prefix = idx == 0 ? "if" : "} else if"
                    lines.append("\(indent)            \(prefix) let v = try? \(payload)(from: decoder) {")
                    lines.append("\(indent)                self = .\(camelCase(variant.name))(v)")
                    lines.append("\(indent)                return")
                }
                lines.append("\(indent)            } else {")
                lines.append("\(indent)                throw DecodingError.dataCorruptedError(forKey: .\(escapedSwiftName(discriminator.fieldName)), in: container, debugDescription: \"No \(name) variant matched for tag '\\(disc)'\")")
                lines.append("\(indent)            }")
            }
        }
        lines.append("\(indent)        default:")
        lines.append("\(indent)            throw DecodingError.dataCorruptedError(forKey: .\(escapedSwiftName(discriminator.fieldName)), in: container, debugDescription: \"Unknown value: \\(disc)\")")
        lines.append("\(indent)        }")
        lines.append("\(indent)    }")
    }

    private func emitTransparentUnionCodingNested(name: String, variants: [UnionVariant], indent: String, lines: inout [String]) {
        lines.append("")
        lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
        lines.append("\(indent)        switch self {")
        for variant in variants {
            let caseName = camelCase(variant.name)
            let hasSynthBody = !variant.fields.isEmpty || variant.additionalPropertiesType != nil || variant.embeddedUnion != nil
            if variant.payloadTypeName != nil || hasSynthBody {
                lines.append("\(indent)        case .\(caseName)(let payload):")
                lines.append("\(indent)            try payload.encode(to: encoder)")
            } else {
                lines.append("\(indent)        case .\(caseName):")
                lines.append("\(indent)            var c = encoder.container(keyedBy: EmptyKey.self)")
                lines.append("\(indent)            _ = c")
            }
        }
        lines.append("\(indent)        }")
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    public init(from decoder: Decoder) throws {")
        lines.append("\(indent)        var lastError: Error?")
        for variant in variants {
            let caseName = camelCase(variant.name)
            let hasSynthBody = !variant.fields.isEmpty || variant.additionalPropertiesType != nil || variant.embeddedUnion != nil
            if let payload = variant.payloadTypeName ?? (hasSynthBody ? variant.name : nil) {
                lines.append("\(indent)        do {")
                lines.append("\(indent)            self = .\(caseName)(try \(payload)(from: decoder))")
                lines.append("\(indent)            return")
                lines.append("\(indent)        } catch { lastError = error }")
            }
        }
        if let fieldlessFirst = variants.first(where: { $0.fields.isEmpty && $0.payloadTypeName == nil && $0.additionalPropertiesType == nil && $0.embeddedUnion == nil }) {
            lines.append("\(indent)        self = .\(camelCase(fieldlessFirst.name))")
        } else {
            lines.append("\(indent)        throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: \"No \(name) variant matched\"))")
        }
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    private enum EmptyKey: CodingKey {}")
    }

    // MARK: - Type Emission

    private func emitType(_ type: ResolvedType, name: String, lines: inout [String], emitted: inout Set<String>) {
        guard !emitted.contains(name) else { return }

        switch type {
        case .record(_, let fields, let additionalPropertiesType, let embeddedUnion):
            emitted.insert(name)
            // Pre-emit dependent types BEFORE this struct (flat, not nested).
            // Don't append to `lines` mid-struct — the body must be contiguous.
            // We pre-emit dependents, then build the body in a local buffer
            // using `swiftTypeNameNoEmit` (which never recurses into emit).
            for field in fields {
                emitDependentTypes(field.type, emitted: &emitted, lines: &lines)
            }
            if let addPropsType = additionalPropertiesType {
                emitDependentTypes(addPropsType, emitted: &emitted, lines: &lines)
            }
            if let embedded = embeddedUnion {
                emitDependentTypes(embedded, emitted: &emitted, lines: &lines)
            }
            emitRecordStruct(name: name, fields: fields, additionalPropertiesType: additionalPropertiesType, embeddedUnion: embeddedUnion, lines: &lines)

        case .enum(_, let values):
            emitted.insert(name)
            lines.append("")
            lines.append("public enum \(name): String, Codable {")
            for val in values {
                let caseName = camelCase(val)
                if caseName != val {
                    lines.append("    case \(caseName) = \"\(val)\"")
                } else {
                    lines.append("    case \(caseName)")
                }
            }
            lines.append("}")

        case .union(_, let variants, let discriminator):
            emitted.insert(name)
            // Emit variant structs BEFORE the enum (flat, not nested). When
            // the variant name is already a known type (because the spec
            // referenced an existing component schema for that variant), we
            // reuse that type directly instead of synthesizing a new one.
            for variant in variants {
                // A variant needs a synthesized struct when it has fields,
                // additionalProperties, OR an embeddedUnion (regrouped arm
                // with an inner discriminated alternative).
                guard !variant.fields.isEmpty
                        || variant.additionalPropertiesType != nil
                        || variant.embeddedUnion != nil else { continue }
                if variant.payloadTypeName != nil { continue }
                if emitted.contains(variant.name) { continue }
                for field in variant.fields {
                    emitDependentTypes(field.type, emitted: &emitted, lines: &lines)
                }
                if let addPropsType = variant.additionalPropertiesType {
                    emitDependentTypes(addPropsType, emitted: &emitted, lines: &lines)
                }
                if let embedded = variant.embeddedUnion {
                    emitDependentTypes(embedded, emitted: &emitted, lines: &lines)
                }
                emitted.insert(variant.name)
                emitRecordStruct(
                    name: variant.name,
                    fields: variant.fields,
                    additionalPropertiesType: variant.additionalPropertiesType,
                    embeddedUnion: variant.embeddedUnion,
                    lines: &lines
                )
            }
            var body: [String] = []
            body.append("")
            body.append("public enum \(name): Codable {")
            for variant in variants {
                let caseName = camelCase(variant.name)
                let hasSynthBody = !variant.fields.isEmpty
                    || variant.additionalPropertiesType != nil
                    || variant.embeddedUnion != nil
                let payloadType = variant.payloadTypeName ?? (hasSynthBody ? variant.name : nil)
                if let payload = payloadType {
                    body.append("    case \(caseName)(\(payload))")
                } else {
                    body.append("    case \(caseName)")
                }
            }
            // Internal-discriminator union: write the discriminator at JSON
            // top level alongside the payload.
            // Discriminator-less anonymous oneOf: encode/decode transparently
            // (no envelope) — try each variant in order on decode.
            if let disc = discriminator {
                emitDiscriminatedCoding(name: name, variants: variants, discriminator: disc, lines: &body)
            } else {
                emitTransparentUnionCoding(name: name, variants: variants, lines: &body)
            }
            body.append("}")
            lines.append(contentsOf: body)

        default:
            break
        }
    }

    /// Emit a `struct {Name}: Codable` body. When `additionalPropertiesType`
    /// is set the struct exposes an extra `let attributes: [String: V]`
    /// property with a custom Codable that flattens at the JSON top level —
    /// matches `T & Record<string, V>` shapes from TypeScript like Cognito's
    /// `signUp` payload. When `embeddedUnion` is non-nil the struct carries
    /// a `let challenge: <Union>` field that flattens its inner variant's
    /// fields into the same JSON envelope — matches the regrouped
    /// `confirmSignIn` arm.
    private func emitRecordStruct(name: String, fields: [ResolvedField], additionalPropertiesType: ResolvedType?, embeddedUnion: ResolvedType?, lines: inout [String]) {
        let fields = fields.filter { !isVoidType($0.type) }
        var body: [String] = []
        body.append("")
        body.append("public struct \(name): Codable {")
        for field in fields {
            let swType = swiftTypeNameNoEmit(field.type)
            let alreadyOptional = swType.hasSuffix("?")
            let optSuffix = (!field.required && !alreadyOptional) ? "?" : ""
            body.append("    public let \(escapedSwiftName(field.name)): \(swType)\(optSuffix)")
        }
        if let addPropsType = additionalPropertiesType {
            let valueType = swiftTypeNameNoEmit(addPropsType)
            body.append("    public let attributes: [String: \(valueType)]")
        }
        if let embedded = embeddedUnion, case .union(let unionName, _, _) = embedded {
            body.append("    public let challenge: \(unionName)")
        }

        let needsCodingKeys = fields.contains { escapedSwiftName($0.name) != $0.name }
        let isOpen = additionalPropertiesType != nil
        let hasEmbedded = embeddedUnion != nil

        if hasEmbedded, case .union(let unionName, _, _)? = embeddedUnion {
            // Merged Codable: outer fields encode normally, embedded union
            // encodes its discriminator + payload onto the same JSON object.
            body.append("")
            body.append("    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)), challenge: \(unionName)) {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                body.append("        self.\(safe) = \(safe)")
            }
            body.append("        self.challenge = challenge")
            body.append("    }")

            body.append("")
            body.append("    private enum OuterCodingKeys: String, CodingKey {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                if safe != field.name {
                    body.append("        case \(safe) = \"\(field.name)\"")
                } else {
                    body.append("        case \(safe)")
                }
            }
            body.append("    }")

            body.append("")
            body.append("    public func encode(to encoder: Encoder) throws {")
            body.append("        var c = encoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                if field.required {
                    body.append("        try c.encode(self.\(safe), forKey: .\(safe))")
                } else {
                    body.append("        try c.encodeIfPresent(self.\(safe), forKey: .\(safe))")
                }
            }
            body.append("        try self.challenge.encode(to: encoder)")
            body.append("    }")

            body.append("")
            body.append("    public init(from decoder: Decoder) throws {")
            body.append("        let c = try decoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                let swType = swiftTypeNameNoEmit(field.type)
                let alreadyOptional = swType.hasSuffix("?")
                let baseType = alreadyOptional ? String(swType.dropLast()) : swType
                if field.required && !alreadyOptional {
                    body.append("        self.\(safe) = try c.decode(\(baseType).self, forKey: .\(safe))")
                } else {
                    body.append("        self.\(safe) = try c.decodeIfPresent(\(baseType).self, forKey: .\(safe))")
                }
            }
            body.append("        self.challenge = try \(unionName)(from: decoder)")
            body.append("    }")
            body.append("}")
            lines.append(contentsOf: body)
            return
        }

        if isOpen {
            // Memberwise init so customers can construct values directly.
            body.append("")
            body.append("    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: additionalPropertiesType))) {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                body.append("        self.\(safe) = \(safe)")
            }
            body.append("        self.attributes = attributes")
            body.append("    }")

            // Custom Codable: flatten attributes onto the top-level JSON object.
            body.append("")
            body.append("    private struct DynamicKey: CodingKey {")
            body.append("        var stringValue: String")
            body.append("        var intValue: Int? { nil }")
            body.append("        init?(stringValue: String) { self.stringValue = stringValue }")
            body.append("        init?(intValue: Int) { return nil }")
            body.append("    }")
            body.append("")
            body.append("    private static let fixedFieldNames: Set<String> = [")
            for field in fields {
                body.append("        \"\(field.name)\",")
            }
            body.append("    ]")
            body.append("")
            // encode
            body.append("    public func encode(to encoder: Encoder) throws {")
            body.append("        var c = encoder.container(keyedBy: DynamicKey.self)")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                let key = field.name
                if field.required {
                    body.append("        try c.encode(self.\(safe), forKey: DynamicKey(stringValue: \"\(key)\")!)")
                } else {
                    body.append("        try c.encodeIfPresent(self.\(safe), forKey: DynamicKey(stringValue: \"\(key)\")!)")
                }
            }
            body.append("        for (k, v) in self.attributes {")
            body.append("            try c.encode(v, forKey: DynamicKey(stringValue: k)!)")
            body.append("        }")
            body.append("    }")
            // decode
            let valueType = swiftTypeNameNoEmit(additionalPropertiesType!)
            body.append("")
            body.append("    public init(from decoder: Decoder) throws {")
            body.append("        let c = try decoder.container(keyedBy: DynamicKey.self)")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                let key = field.name
                let swType = swiftTypeNameNoEmit(field.type)
                let alreadyOptional = swType.hasSuffix("?")
                let baseType = alreadyOptional ? String(swType.dropLast()) : swType
                if field.required && !alreadyOptional {
                    body.append("        self.\(safe) = try c.decode(\(baseType).self, forKey: DynamicKey(stringValue: \"\(key)\")!)")
                } else {
                    body.append("        self.\(safe) = try c.decodeIfPresent(\(baseType).self, forKey: DynamicKey(stringValue: \"\(key)\")!)")
                }
            }
            body.append("        var extras: [String: \(valueType)] = [:]")
            body.append("        for key in c.allKeys where !Self.fixedFieldNames.contains(key.stringValue) {")
            body.append("            extras[key.stringValue] = try c.decode(\(valueType).self, forKey: key)")
            body.append("        }")
            body.append("        self.attributes = extras")
            body.append("    }")
        } else {
            let hasOptionals = fields.contains { !$0.required || swiftTypeNameNoEmit($0.type).hasSuffix("?") }
            if needsCodingKeys || hasOptionals {
                body.append("")
                body.append("    enum CodingKeys: String, CodingKey {")
                for field in fields {
                    let safe = escapedSwiftName(field.name)
                    if safe != field.name {
                        body.append("        case \(safe) = \"\(field.name)\"")
                    } else {
                        body.append("        case \(safe)")
                    }
                }
                body.append("    }")
            }
            if hasOptionals {
                body.append("")
                body.append("    public func encode(to encoder: Encoder) throws {")
                body.append("        var c = encoder.container(keyedBy: CodingKeys.self)")
                for field in fields {
                    let safe = escapedSwiftName(field.name)
                    let swType = swiftTypeNameNoEmit(field.type)
                    let alreadyOptional = swType.hasSuffix("?")
                    if field.required && !alreadyOptional {
                        body.append("        try c.encode(self.\(safe), forKey: .\(safe))")
                    } else {
                        body.append("        try c.encodeIfPresent(self.\(safe), forKey: .\(safe))")
                    }
                }
                body.append("    }")
            }
        }
        // If any field carries spec constraints OR has a spec-provided
        // default value, emit an explicit memberwise init that runs
        // validation guards and supplies defaults. We intentionally do
        // NOT emit when the record already has a custom init above (open
        // shape / embedded union) — those paths handle defaults themselves.
        let needsExplicitInit = !isOpen && !hasEmbedded
            && fields.contains(where: { fieldNeedsExplicitInit($0) })
        if needsExplicitInit {
            let hasValidation = fields.contains { !constraintValidationLines(field: $0, accessor: escapedSwiftName($0.name)).isEmpty }
            body.append("")
            body.append("    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)))\(hasValidation ? " throws" : "") {")
            for field in fields {
                let safe = escapedSwiftName(field.name)
                let validationLines = constraintValidationLines(field: field, accessor: safe)
                for line in validationLines {
                    body.append("        \(line)")
                }
                body.append("        self.\(safe) = \(safe)")
            }
            body.append("    }")
        }
        body.append("}")
        lines.append(contentsOf: body)
    }

    /// True when the field's type carries non-empty constraints OR the field
    /// has a spec-provided `default` value — both demand an explicit memberwise
    /// init (Swift's auto-derived init can't run validation or accept a
    /// default for a non-Optional property).
    private func fieldNeedsExplicitInit(_ field: ResolvedField) -> Bool {
        if field.defaultValue != nil { return true }
        return !typeConstraints(field.type).isEmpty
    }

    /// Surface the constraints attached to a `ResolvedType` (only primitive,
    /// formattedType, and list carry them). Walks one level of nullable.
    private func typeConstraints(_ type: ResolvedType) -> Constraints {
        switch type {
        case .primitive(_, let c): return c
        case .formattedType(_, let c): return c
        case .list(_, let c): return c
        case .nullable(let inner): return typeConstraints(inner)
        default: return .empty
        }
    }

    /// Emit `guard ... else { throw CodegenError.validation(...) }` lines for the
    /// constraints carried on a field's type. The accessor names a parameter
    /// (in an init body) holding the value to validate. Optional fields produce
    /// an `if let` block that runs the checks against the unwrapped value.
    private func constraintValidationLines(field: ResolvedField, accessor: String) -> [String] {
        let constraints = typeConstraints(field.type)
        if constraints.isEmpty { return [] }

        let swType = swiftTypeNameNoEmit(field.type)
        let isOptional = swType.hasSuffix("?") || !field.required
        let valueVar = isOptional ? "v" : accessor

        var checks: [String] = []
        switch field.type {
        case .primitive(.string, _), .formattedType:
            if let min = constraints.minLength {
                checks.append("guard \(valueVar).count >= \(min) else { throw CodegenError.validation(\"\(field.name) must be at least \(min) characters\") }")
            }
            if let max = constraints.maxLength {
                checks.append("guard \(valueVar).count <= \(max) else { throw CodegenError.validation(\"\(field.name) must be at most \(max) characters\") }")
            }
            if let pattern = constraints.pattern {
                // JSON Schema `pattern` uses ECMA-262 semantics (unanchored match).
                // `range(of:options:.regularExpression)` matches this — it succeeds
                // if the pattern matches anywhere in the string, not just the full string.
                let escaped = pattern.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "\"", with: "\\\"")
                checks.append("guard \(valueVar).range(of: \"\(escaped)\", options: .regularExpression) != nil else { throw CodegenError.validation(\"\(field.name) must match pattern \(escaped)\") }")
            }
        case .primitive(.integer, _), .primitive(.number, _):
            let isInt = { if case .primitive(.integer, _) = field.type { return true } else { return false } }()
            let cast: (Double) -> String = { v in isInt ? String(Int(v)) : String(v) }
            if let v = constraints.minimum {
                checks.append("guard \(valueVar) >= \(cast(v)) else { throw CodegenError.validation(\"\(field.name) must be >= \(cast(v))\") }")
            }
            if let v = constraints.maximum {
                checks.append("guard \(valueVar) <= \(cast(v)) else { throw CodegenError.validation(\"\(field.name) must be <= \(cast(v))\") }")
            }
            if let v = constraints.exclusiveMinimum {
                checks.append("guard \(valueVar) > \(cast(v)) else { throw CodegenError.validation(\"\(field.name) must be > \(cast(v))\") }")
            }
            if let v = constraints.exclusiveMaximum {
                checks.append("guard \(valueVar) < \(cast(v)) else { throw CodegenError.validation(\"\(field.name) must be < \(cast(v))\") }")
            }
            if let v = constraints.multipleOf {
                let mod = isInt ? "\(valueVar) % \(Int(v))" : "\(valueVar).truncatingRemainder(dividingBy: \(v))"
                checks.append("guard \(mod) == 0 else { throw CodegenError.validation(\"\(field.name) must be a multiple of \(cast(v))\") }")
            }
        case .list(_, _):
            if let v = constraints.minItems {
                checks.append("guard \(valueVar).count >= \(v) else { throw CodegenError.validation(\"\(field.name) must have at least \(v) items\") }")
            }
            if let v = constraints.maxItems {
                checks.append("guard \(valueVar).count <= \(v) else { throw CodegenError.validation(\"\(field.name) must have at most \(v) items\") }")
            }
        default:
            break
        }

        if checks.isEmpty { return [] }

        if isOptional {
            var out = ["if let v = \(accessor) {"]
            out.append(contentsOf: checks.map { "    \($0)" })
            out.append("}")
            return out
        }
        return checks
    }

    private func memberwiseInitParams(fields: [ResolvedField], additionalPropertiesType: ResolvedType?) -> String {
        var parts: [String] = []
        for field in fields {
            let swType = swiftTypeNameNoEmit(field.type)
            let alreadyOptional = swType.hasSuffix("?")
            let typeStr = (!field.required && !alreadyOptional) ? "\(swType)?" : swType
            let safe = escapedSwiftName(field.name)
            // Default-value precedence:
            //   1. Spec-provided `default` (rendered as a Swift literal).
            //   2. Optional / nullable field with no spec default → `= nil`.
            //   3. Required field with no default → no default.
            if let raw = field.defaultValue, let literal = swiftLiteralForJSONDefault(raw, type: field.type) {
                parts.append("\(safe): \(typeStr) = \(literal)")
            } else if !field.required && !alreadyOptional {
                parts.append("\(safe): \(typeStr) = nil")
            } else if alreadyOptional {
                parts.append("\(safe): \(typeStr) = nil")
            } else {
                parts.append("\(safe): \(typeStr)")
            }
        }
        if let addPropsType = additionalPropertiesType {
            let valueType = swiftTypeNameNoEmit(addPropsType)
            parts.append("attributes: [String: \(valueType)] = [:]")
        }
        return parts.joined(separator: ", ")
    }

    /// Convert a spec `default` value (carried as a re-encoded JSON literal
    /// string) into a Swift expression that can be used as an initializer
    /// default. Returns `nil` when the value's shape isn't safely
    /// representable as a literal (e.g. JSON object or array of records).
    private func swiftLiteralForJSONDefault(_ raw: String, type: ResolvedType) -> String? {
        // String / number / boolean / null literals round-trip directly:
        // the parser's `RawJSON` re-encodes them in their JSON form which is
        // also a valid Swift literal (for the common cases).
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed == "null" {
            // Nullable target: emit `nil`. Non-nullable target: drop default.
            switch type {
            case .nullable: return "nil"
            default: return nil
            }
        }
        // Strings: JSON renders them with surrounding quotes — that's a Swift
        // string literal too.
        if trimmed.hasPrefix("\"") && trimmed.hasSuffix("\"") {
            return trimmed
        }
        // Booleans + numbers round-trip as-is.
        if trimmed == "true" || trimmed == "false" || Double(trimmed) != nil || Int(trimmed) != nil {
            return trimmed
        }
        // Arrays / objects: skip — Swift can't initialise arbitrary nested
        // shapes from a JSON literal at compile time.
        return nil
    }

    private func emitDiscriminatedCoding(name: String, variants: [UnionVariant], discriminator: DiscriminatorInfo, lines: inout [String]) {
        // Caller (`emitType` for `.union`) has already routed external
        // discriminators to `emitTransparentUnionCoding`. Here we only handle
        // internal-discriminator unions.
        lines.append("")
        lines.append("    enum CodingKeys: String, CodingKey {")
        lines.append("        case \(escapedSwiftName(discriminator.fieldName))")
        lines.append("    }")
        lines.append("")
        lines.append("    public func encode(to encoder: Encoder) throws {")
        lines.append("        var container = encoder.container(keyedBy: CodingKeys.self)")
        lines.append("        switch self {")
        for variant in variants {
            if let discVal = variant.discriminatorValue {
                let hasSynthBody = !variant.fields.isEmpty
                    || variant.additionalPropertiesType != nil
                    || variant.embeddedUnion != nil
                let hasPayload = variant.payloadTypeName != nil || hasSynthBody
                if !hasPayload {
                    lines.append("        case .\(camelCase(variant.name)):")
                    lines.append("            try container.encode(\"\(discVal)\", forKey: .\(escapedSwiftName(discriminator.fieldName)))")
                } else {
                    lines.append("        case .\(camelCase(variant.name))(let params):")
                    lines.append("            try container.encode(\"\(discVal)\", forKey: .\(escapedSwiftName(discriminator.fieldName)))")
                    lines.append("            try params.encode(to: encoder)")
                }
            }
        }
        lines.append("        }")
        lines.append("    }")
        lines.append("")
        lines.append("    public init(from decoder: Decoder) throws {")
        lines.append("        let container = try decoder.container(keyedBy: CodingKeys.self)")
        lines.append("        let disc = try container.decode(String.self, forKey: .\(escapedSwiftName(discriminator.fieldName)))")
        lines.append("        switch disc {")
        // Group variants by discriminator value: when multiple variants share
        // a value, the discriminator alone is ambiguous on decode. Try each
        // shape in order and take the first that parses successfully.
        var byTag: [String: [UnionVariant]] = [:]
        var tagOrder: [String] = []
        for v in variants {
            guard let tag = v.discriminatorValue else { continue }
            if byTag[tag] == nil { tagOrder.append(tag) }
            byTag[tag, default: []].append(v)
        }
        for tag in tagOrder {
            let group = byTag[tag] ?? []
            if group.count == 1 {
                let variant = group[0]
                let hasSynthBody = !variant.fields.isEmpty
                    || variant.additionalPropertiesType != nil
                    || variant.embeddedUnion != nil
                if !hasSynthBody && variant.payloadTypeName == nil {
                    lines.append("        case \"\(tag)\": self = .\(camelCase(variant.name))")
                } else {
                    let payload = variant.payloadTypeName ?? variant.name
                    lines.append("        case \"\(tag)\": self = .\(camelCase(variant.name))(try \(payload)(from: decoder))")
                }
            } else {
                lines.append("        case \"\(tag)\":")
                for (idx, variant) in group.enumerated() {
                    let payload = variant.payloadTypeName ?? variant.name
                    let prefix = idx == 0 ? "if" : "} else if"
                    lines.append("            \(prefix) let v = try? \(payload)(from: decoder) {")
                    lines.append("                self = .\(camelCase(variant.name))(v)")
                    lines.append("                return")
                }
                lines.append("            } else {")
                lines.append("                throw DecodingError.dataCorruptedError(forKey: .\(escapedSwiftName(discriminator.fieldName)), in: container, debugDescription: \"No \(name) variant matched for tag '\\(disc)'\")")
                lines.append("            }")
            }
        }
        lines.append("        default:")
        lines.append("            throw DecodingError.dataCorruptedError(forKey: .\(escapedSwiftName(discriminator.fieldName)), in: container, debugDescription: \"Unknown value: \\(disc)\")")
        lines.append("        }")
        lines.append("    }")
    }

    /// For unions whose discriminator lives on a *sibling* argument (not in the
    /// payload), the JSON wire form is the bare payload — no `{caseName: ...}`
    /// envelope. We override Codable so encoding/decoding strips that envelope.
    private func emitTransparentUnionCoding(name: String, variants: [UnionVariant], lines: inout [String]) {
        lines.append("")
        lines.append("    public func encode(to encoder: Encoder) throws {")
        lines.append("        switch self {")
        for variant in variants {
            let caseName = camelCase(variant.name)
            let hasSynthBody = !variant.fields.isEmpty
                || variant.additionalPropertiesType != nil
                || variant.embeddedUnion != nil
            if variant.payloadTypeName != nil || hasSynthBody {
                lines.append("        case .\(caseName)(let payload):")
                lines.append("            try payload.encode(to: encoder)")
            } else {
                lines.append("        case .\(caseName):")
                lines.append("            var c = encoder.container(keyedBy: EmptyKey.self)")
                lines.append("            _ = c")
            }
        }
        lines.append("        }")
        lines.append("    }")
        lines.append("")
        lines.append("    public init(from decoder: Decoder) throws {")
        lines.append("        var lastError: Error?")
        for variant in variants {
            let caseName = camelCase(variant.name)
            let hasSynthBody = !variant.fields.isEmpty
                || variant.additionalPropertiesType != nil
                || variant.embeddedUnion != nil
            if let payload = variant.payloadTypeName ?? (hasSynthBody ? variant.name : nil) {
                lines.append("        do {")
                lines.append("            self = .\(caseName)(try \(payload)(from: decoder))")
                lines.append("            return")
                lines.append("        } catch { lastError = error }")
            }
        }
        if let fieldlessFirst = variants.first(where: { $0.fields.isEmpty && $0.payloadTypeName == nil && $0.additionalPropertiesType == nil && $0.embeddedUnion == nil }) {
            lines.append("        self = .\(camelCase(fieldlessFirst.name))")
        } else {
            lines.append("        throw lastError ?? DecodingError.dataCorrupted(.init(codingPath: decoder.codingPath, debugDescription: \"No \(name) variant matched\"))")
        }
        lines.append("    }")
        lines.append("")
        lines.append("    private enum EmptyKey: CodingKey {}")
    }

    // MARK: - Operation Emission

    private func qualifiedSwiftTypeName(_ type: ResolvedType, qualifiedNames: [String: String]) -> String {
        switch type {
        case .record(let name, _, _, _), .enum(let name, _), .union(let name, _, _):
            return qualifiedNames[name] ?? name
        case .list(let elementType, _):
            return "[\(qualifiedSwiftTypeName(elementType, qualifiedNames: qualifiedNames))]"
        case .map(let valueType):
            return "[String: \(qualifiedSwiftTypeName(valueType, qualifiedNames: qualifiedNames))]"
        case .nullable(let inner):
            return "\(qualifiedSwiftTypeName(inner, qualifiedNames: qualifiedNames))?"
        case .typeReference(let name):
            return qualifiedNames[name] ?? name
        default:
            return swiftTypeNameNoEmit(type)
        }
    }

    private func emitOperation(_ op: Operation, namespace: String, prefixNamespace: Bool, lines: inout [String], emitted: inout Set<String>, modelLines: inout [String], qualifiedNames: [String: String] = [:]) {
        let fullMethodName = namespace == "_default" ? op.name : "\(namespace).\(op.name)"
        let returnType = qualifiedSwiftTypeName(op.result.type, qualifiedNames: qualifiedNames)
        let isTransferable = isTransferableType(op.result.type)

        // Build parameter list
        var paramList: [String] = []
        for param in op.parameters {
            let swType = qualifiedSwiftTypeName(param.type, qualifiedNames: qualifiedNames)
            let safeName = escapedSwiftName(param.name)
            let alreadyOptional = swType.hasSuffix("?")
            if param.required || alreadyOptional {
                paramList.append("\(safeName): \(swType)")
            } else {
                paramList.append("\(safeName): \(swType)? = nil")
            }
        }
        let paramStr = paramList.joined(separator: ", ")

        let funcName: String
        if prefixNamespace && namespace != "_default" {
            funcName = escapedSwiftName("\(namespace)\(pascalCase(op.name))")
        } else {
            funcName = escapedSwiftName(op.name)
        }

        lines.append("    /// Calls `\(fullMethodName)`.")
        lines.append("    public func \(funcName)(\(paramStr)) async throws -> \(returnType) {")

        // Build request
        if op.parameters.isEmpty {
            lines.append("        let request = BlocksRequest(method: \"\(fullMethodName)\", params: [], id: BlocksRequest.nextId())")
        } else {
            let hasTrailingOptionals = !op.parameters.last!.required
            if hasTrailingOptionals {
                // Find the boundary: required params come first, then optional trailing ones
                let lastRequiredIdx = op.parameters.lastIndex(where: { $0.required }) ?? -1
                let requiredParams = op.parameters.prefix(through: max(lastRequiredIdx, -1))
                let optionalParams = op.parameters.suffix(from: lastRequiredIdx + 1)

                if requiredParams.isEmpty {
                    lines.append("        var _params: [any Encodable] = []")
                } else {
                    let reqElems = requiredParams.map { escapedSwiftName($0.name) }.joined(separator: ", ")
                    lines.append("        var _params: [any Encodable] = [\(reqElems)]")
                }
                // Append optional params in order, stopping at the first nil from the end
                // We must append in order (can't skip a middle one), so append all non-nil
                // trailing params up to the last non-nil one.
                for param in optionalParams {
                    let safe = escapedSwiftName(param.name)
                    lines.append("        if let \(safe) { _params.append(\(safe)) }")
                }
                lines.append("        let request = BlocksRequest(method: \"\(fullMethodName)\", params: _params, id: BlocksRequest.nextId())")
            } else {
                let arrayElements = op.parameters.map { escapedSwiftName($0.name) }.joined(separator: ", ")
                lines.append("        let request = BlocksRequest(method: \"\(fullMethodName)\", params: [\(arrayElements)], id: BlocksRequest.nextId())")
            }
        }

        // Execute and deserialize
        lines.append("        let result = try await client.execute(request)")

        if isTransferable {
            // Hydrate transferable from the raw JSON descriptor
            if case .transferable(let blocksType, let typeArgs) = op.result.type {
                switch blocksType {
                case "realtime/channel":
                    let messageType = typeArgs.first.map { qualifiedSwiftTypeName($0, qualifiedNames: qualifiedNames) } ?? "JSONValue"
                    lines.append("        guard let result else { throw RPCError(message: \"Unexpected null result for \(fullMethodName)\") }")
                    lines.append("        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {")
                    lines.append("            throw RPCError(message: \"Invalid channel descriptor for \(fullMethodName)\")")
                    lines.append("        }")
                    lines.append("        return RealtimeChannel<\(messageType)>.fromJSON(descriptor, baseHost: BlocksClient.baseHost) { data in")
                    lines.append("            try JSONDecoder().decode(\(messageType).self, from: data)")
                    lines.append("        }")
                case "file-bucket/download":
                    lines.append("        guard let result else { throw RPCError(message: \"Unexpected null result for \(fullMethodName)\") }")
                    lines.append("        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {")
                    lines.append("            throw RPCError(message: \"Invalid file descriptor for \(fullMethodName)\")")
                    lines.append("        }")
                    lines.append("        return try FileDownloadHandle.fromJSON(descriptor)")
                case "file-bucket/upload":
                    lines.append("        guard let result else { throw RPCError(message: \"Unexpected null result for \(fullMethodName)\") }")
                    lines.append("        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {")
                    lines.append("            throw RPCError(message: \"Invalid file descriptor for \(fullMethodName)\")")
                    lines.append("        }")
                    lines.append("        return try FileUploadHandle.fromJSON(descriptor)")
                case "oidc/client":
                    lines.append("        guard let result else { throw RPCError(message: \"Unexpected null result for \(fullMethodName)\") }")
                    lines.append("        guard let descriptor = try JSONSerialization.jsonObject(with: result) as? [String: Any] else {")
                    lines.append("            throw RPCError(message: \"Invalid OIDC client descriptor for \(fullMethodName)\")")
                    lines.append("        }")
                    lines.append("        return try OIDCClient.fromJSON(descriptor, baseUrl: self.client.baseUrl, client: self.client)")
                default:
                    lines.append("        return result")
                }
            }
        } else if returnType == "Void" {
            // No return needed
        } else if returnType.hasSuffix("?") {
            let baseType = String(returnType.dropLast())
            lines.append("        guard let result else { return nil }")
            lines.append("        return try JSONDecoder().decode(\(baseType).self, from: result)")
        } else {
            lines.append("        guard let result else { throw RPCError(message: \"Unexpected null result for \(fullMethodName)\") }")
            lines.append("        return try JSONDecoder().decode(\(returnType).self, from: result)")
        }

        lines.append("    }")
    }

    // MARK: - Transferable Helpers

    private func isVoidType(_ type: ResolvedType) -> Bool {
        if case .primitive(let kind, _) = type { return kind == .void }
        if case .nullable(let inner) = type { return isVoidType(inner) }
        return false
    }

    private func isTransferableType(_ type: ResolvedType) -> Bool {
        if case .transferable = type { return true }
        return false
    }

    private func isPrimitiveSwiftType(_ type: String) -> Bool {
        switch type {
        case "String", "Double", "Int", "Bool":
            return true
        default:
            return false
        }
    }

    // MARK: - Swift Type Name Resolution

    /// Pre-emits any types that a given type depends on (ensures they're defined before use).
    private func emitDependentTypes(_ type: ResolvedType, emitted: inout Set<String>, lines: inout [String]) {
        switch type {
        case .record(let name, _, _, let embeddedUnion):
            if !emitted.contains(name) {
                emitType(type, name: name, lines: &lines, emitted: &emitted)
            }
            if let embedded = embeddedUnion {
                emitDependentTypes(embedded, emitted: &emitted, lines: &lines)
            }
        case .enum(let name, _):
            if !emitted.contains(name) {
                emitType(type, name: name, lines: &lines, emitted: &emitted)
            }
        case .union(let name, _, _):
            if !emitted.contains(name) {
                emitType(type, name: name, lines: &lines, emitted: &emitted)
            }
        case .list(let elementType, _):
            emitDependentTypes(elementType, emitted: &emitted, lines: &lines)
        case .map(let valueType):
            emitDependentTypes(valueType, emitted: &emitted, lines: &lines)
        case .nullable(let inner):
            emitDependentTypes(inner, emitted: &emitted, lines: &lines)
        case .transferable(_, let typeArgs):
            for arg in typeArgs {
                emitDependentTypes(arg, emitted: &emitted, lines: &lines)
            }
        case .primitive, .formattedType, .typeReference:
            break
        }
    }

    /// Pure Swift type-name resolver. Does NOT emit any types — assumes the
    /// caller has already pre-emitted dependents (via `emitDependentTypes`).
    private func swiftTypeNameNoEmit(_ type: ResolvedType) -> String {
        switch type {
        case .primitive(let kind, _):
            switch kind {
            case .string: return "String"
            case .boolean: return "Bool"
            case .integer: return "Int"
            case .number: return "Double"
            case .void: return "Void"
            case .unknown: return "JSONValue"
            }
        case .formattedType(let format, _):
            switch format {
            case .uuid:     return "UUID"
            case .dateTime: return "Date"
            case .date:     return "Date"
            case .time:     return "String"
            case .uri:      return "URL"
            }
        case .record(let name, _, _, _):
            return name
        case .enum(let name, _):
            return name
        case .list(let elementType, _):
            return "[\(swiftTypeNameNoEmit(elementType))]"
        case .map(let valueType):
            return "[String: \(swiftTypeNameNoEmit(valueType))]"
        case .nullable(let inner):
            return "\(swiftTypeNameNoEmit(inner))?"
        case .union(let name, _, _):
            return name
        case .typeReference(let name):
            return name
        case .transferable(let blocksType, let typeArgs):
            switch blocksType {
            case "realtime/channel":
                let argType = typeArgs.first.map { swiftTypeNameNoEmit($0) } ?? "JSONValue"
                return "RealtimeChannel<\(argType)>"
            case "file-bucket/download":
                return "FileDownloadHandle"
            case "file-bucket/upload":
                return "FileUploadHandle"
            case "oidc/client":
                return "OIDCClient"
            default:
                return "JSONValue"
            }
        }
    }

    private func swiftTypeName(_ type: ResolvedType, emitted: inout Set<String>, modelLines: inout [String]) -> String {
        switch type {
        case .primitive(let kind, _):
            switch kind {
            case .string: return "String"
            case .boolean: return "Bool"
            case .integer: return "Int"
            case .number: return "Double"
            case .void: return "Void"
            case .unknown: return "JSONValue"
            }
        case .formattedType(let format, _):
            switch format {
            case .uuid:     return "UUID"
            case .dateTime: return "Date"
            case .date:     return "Date"
            case .time:     return "String"
            case .uri:      return "URL"
            }
        case .record(let name, _, _, _):
            emitType(type, name: name, lines: &modelLines, emitted: &emitted)
            return name
        case .enum(let name, _):
            emitType(type, name: name, lines: &modelLines, emitted: &emitted)
            return name
        case .list(let elementType, _):
            return "[\(swiftTypeName(elementType, emitted: &emitted, modelLines: &modelLines))]"
        case .map(let valueType):
            return "[String: \(swiftTypeName(valueType, emitted: &emitted, modelLines: &modelLines))]"
        case .nullable(let inner):
            return "\(swiftTypeName(inner, emitted: &emitted, modelLines: &modelLines))?"
        case .union(let name, _, _):
            emitType(type, name: name, lines: &modelLines, emitted: &emitted)
            return name
        case .typeReference(let name):
            return name
        case .transferable(let blocksType, let typeArgs):
            switch blocksType {
            case "realtime/channel":
                let argType = typeArgs.first.map { swiftTypeName($0, emitted: &emitted, modelLines: &modelLines) } ?? "JSONValue"
                return "RealtimeChannel<\(argType)>"
            case "file-bucket/download":
                return "FileDownloadHandle"
            case "file-bucket/upload":
                return "FileUploadHandle"
            case "oidc/client":
                return "OIDCClient"
            default:
                return "JSONValue"
            }
        }
    }
}
