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

public struct GeneratedSources {
    public let models: String
    public let api: String
    public let warnings: [String]
}

public struct SwiftCodeGenerator {
    /// A component schema's nested types (its inline-object properties), by the schema's type name.
    private(set) var nestedTypesByName: [String: [NestedTypeNode]] = [:]
    /// Component schemas by type name, to follow a `typeReference` when walking a type.
    private(set) var typesByName: [String: ResolvedType] = [:]

    public init() {}

    /// The public types BlocksRuntime declares. `Models.swift` imports BlocksRuntime when it names any of them: a
    /// `JSONValue` (an `unknown` value), a transferable (a model can hold a channel, a file handle or an OIDC client),
    /// or `CodegenError` (a component schema with a constraint throws it from its init). `ModelsRuntimeImportTests`
    /// checks the list against the runtime's sources.
    static let blocksRuntimeTypeNames: Set<String> = [
        "AuthProvider", "BlocksArrayParams", "BlocksClient", "BlocksError", "BlocksRequest", "BlocksServer",
        "BrowserLauncher", "CodegenError", "FileBucketError", "FileDownloadHandle", "FileUploadHandle",
        "InMemoryTokenStore", "JSONValue", "OIDCAuthState", "OIDCClient", "OIDCError", "OIDCProviderConfig", "OIDCUser",
        "RawRouteError", "RealtimeChannel", "RealtimeError", "RPCError", "TokenStore", "UnknownTransferable",
        "WebSocketConnection", "WebSocketDelegate"
    ]

    public func generate(from model: CodegenModel) -> GeneratedSources {
        var generator = self
        generator.nestedTypesByName = Dictionary(
            model.typeDefinitions.map { ($0.name, $0.nestedTypes) },
            uniquingKeysWith: { first, _ in first }
        )
        generator.typesByName = Dictionary(
            model.typeDefinitions.map { ($0.name, $0.type) },
            uniquingKeysWith: { first, _ in first }
        )
        return generator.generateAll(from: model)
    }

    private func generateAll(from model: CodegenModel) -> GeneratedSources {
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
        let classMemberNames = Dictionary(
            model.apiNamespaces.map { ($0.name, apiClassMemberNames($0)) }, uniquingKeysWith: { first, _ in first }
        )
        for namespace in model.apiNamespaces {
            for operation in namespace.operations {
                let opName = classMemberNames[namespace.name]?.enums[operation.name] ?? specTypeName(operation.name)
                let opKey = "\(namespace.name).\(operation.name)"
                // Level by level, and the shallowest type keeps a name: the signature names the operation's
                // own types (`Swap.Item`), not a same-named type nested deeper (`Swap.Result.Item`).
                var nameMap: [String: String] = [:]
                var level = operation.nestedTypes.map { (node: $0, path: "\(opName).\($0.name)") }
                while !level.isEmpty {
                    for entry in level where nameMap[entry.node.name] == nil {
                        nameMap[entry.node.name] = entry.path
                    }
                    level = level.flatMap { entry in
                        entry.node.children.map { (node: $0, path: "\(entry.path).\($0.name)") }
                    }
                }
                operationQualifiedNames[opKey] = nameMap
            }
        }

        // Diagnostics are emitted here (not in the builder) so the model name uses
        // the same `operationQualifiedNames` authority that drives emission.
        var warnings: [String] = []

        // Default server name for init parameter default
        let serverNames = serverPropertyNames(model.servers)
        let defaultServerName = serverNames.first.map { "Servers.\($0)" } ?? "Servers.local"

        // A namespace's class steps aside for a type declared at the top level of Models.swift and for `Servers`.
        var topLevelNames = Set(model.typeDefinitions.map(\.name))
        for typeDef in model.typeDefinitions {
            if case .union(_, let variants, _) = typeDef.type {
                topLevelNames.formUnion(variants.map(\.name))
            }
        }
        let classNames = apiClassNames(model.apiNamespaces, topLevelNames: topLevelNames)

        // Generate one class per namespace
        for (namespace, nsName) in zip(model.apiNamespaces, classNames) {
            let memberNames = classMemberNames[namespace.name] ?? apiClassMemberNames(namespace)
            apiLines.append("public class \(nsName) {")
            apiLines.append("    private let \(memberNames.client): BlocksClient")
            apiLines.append("")
            apiLines.append("    public init(server: BlocksServer = \(defaultServerName)) {")
            apiLines.append("        self.\(memberNames.client) = BlocksClient(server: server)")
            apiLines.append("    }")

            for operation in namespace.operations {
                apiLines.append("")
                let opKey = "\(namespace.name).\(operation.name)"
                let opQualified = operationQualifiedNames[opKey] ?? [:]
                if case .transferable(let blocksType, let typeArgs) = operation.result.type,
                   !knownTransferableTags.contains(blocksType) {
                    let fullOp = namespace.name == "_default" ? operation.name : "\(namespace.name).\(operation.name)"
                    warnings.append(formatUnboundTransferable(
                        operation: fullOp, blocksType: blocksType, typeArgs: typeArgs,
                        className: nsName, qualifiedNames: opQualified
                    ))
                }
                emitOperation(
                    operation, namespace: namespace.name,
                    prefixNamespace: false, lines: &apiLines,
                    emitted: &emittedTypes, modelLines: &modelLines,
                    qualifiedNames: opQualified, classNames: memberNames
                )
            }

            // Emit nested types as operation enums inside the class
            for operation in namespace.operations where !operation.nestedTypes.isEmpty {
                apiLines.append("")
                emitOperationEnum(
                    operation: operation, name: memberNames.enums[operation.name] ?? specTypeName(operation.name),
                    indent: "    ", lines: &apiLines
                )
            }

            apiLines.append("}")
            apiLines.append("")
        }

        // Generate Servers enum
        apiLines.append("")
        apiLines.append("// MARK: - Servers")
        apiLines.append("")
        apiLines.append("public enum Servers {")
        for (server, propertyName) in zip(model.servers, serverNames) {
            let name = swiftStringContent(server.name)
            let url = swiftStringContent(server.url)
            apiLines.append("    public static let \(propertyName) = BlocksServer(name: \"\(name)\", url: \"\(url)\")")
        }
        apiLines.append("}")

        // `JSONValue` (an `unknown` value), the transferable types (a model can hold a channel, a file
        // handle or an OIDC client) and `CodegenError` (a constrained model's init throws it) live in BlocksRuntime,
        // which Models.swift otherwise doesn't need: import it when Models.swift names any runtime type.
        let runtimeTypes = #"\b("# + Self.blocksRuntimeTypeNames.sorted().joined(separator: "|") + #")\b"#
        if modelLines.contains(where: { $0.range(of: runtimeTypes, options: .regularExpression) != nil }) {
            modelLines.insert("import BlocksRuntime", at: 1)
        }

        // Only include models file content if there are actual type definitions
        let hasTypes = !model.typeDefinitions.isEmpty
        let modelsContent = hasTypes ? modelLines.joined(separator: "\n") : ""
        let apiContent = apiLines.joined(separator: "\n")
        return GeneratedSources(models: modelsContent, api: apiContent, warnings: warnings)
    }

    // MARK: - Nested Type Emission

    private func emitOperationEnum(operation: Operation, name opName: String, indent: String, lines: inout [String]) {
        lines.append("\(indent)public enum \(opName) {")
        for node in operation.nestedTypes {
            emitNestedTypeNode(node, indent: indent + "    ", lines: &lines)
        }
        lines.append("\(indent)}")
    }

    private func emitNestedTypeNode(_ node: NestedTypeNode, indent: String, lines: inout [String]) {
        switch node.type {
        case .record(_, let fields, let additionalPropertiesType, let embeddedUnion):
            emitNestedRecordStruct(
                name: node.name, fields: fields,
                additionalPropertiesType: additionalPropertiesType,
                embeddedUnion: embeddedUnion,
                children: node.children, indent: indent, lines: &lines
            )
        case .enum(_, let values):
            lines.append("")
            lines.append("\(indent)public enum \(node.name): String, Codable {")
            lines.append(contentsOf: enumCaseLines(values, indent: indent + "    "))
            lines.append("\(indent)}")
        case .union(_, let variants, let discriminator):
            emitNestedUnion(name: node.name, variants: variants, discriminator: discriminator, children: node.children, indent: indent, lines: &lines)
        default:
            break
        }
    }

    private func emitNestedRecordStruct(
        name: String, fields: [ResolvedField], additionalPropertiesType: ResolvedType?, embeddedUnion: ResolvedType?,
        children: [NestedTypeNode], excludedKeys: [String] = [], indent: String, lines: inout [String]
    ) {
        let fields = fields.filter { !isVoidType($0.type) }
        lines.append("")
        lines.append("\(indent)public struct \(name): Codable {")
        for field in fields {
            let swType = swiftTypeNameNoEmit(field.type)
            let alreadyOptional = swType.hasSuffix("?")
            let optSuffix = (!field.required && !alreadyOptional) ? "?" : ""
            lines.append("\(indent)    public let \(propertyName(field, in: fields)): \(swType)\(optSuffix)")
        }
        if let addPropsType = additionalPropertiesType {
            let valueType = swiftTypeNameNoEmit(addPropsType)
            lines.append("\(indent)    public let \(extrasPropertyName(fields)): [String: \(valueType)]")
        }
        if let embedded = embeddedUnion, case .union(let unionName, _, _) = embedded {
            lines.append("\(indent)    public let \(embeddedPropertyName(fields)): \(unionName)")
        }

        let needsCodingKeys = fields.contains { propertyName($0, in: fields) != $0.name }
        let isOpen = additionalPropertiesType != nil
        let hasEmbedded = embeddedUnion != nil
        let hasOptionalFields = fields.contains { !$0.required || swiftTypeNameNoEmit($0.type).hasSuffix("?") }

        if !isOpen && !hasEmbedded && (needsCodingKeys || hasOptionalFields) {
            lines.append("")
            lines.append("\(indent)    enum CodingKeys: String, CodingKey {")
            for field in fields {
                let safe = propertyName(field, in: fields)
                lines.append("\(indent)        \(codingKeyCase(safe, wireName: field.name))")
            }
            lines.append("\(indent)    }")
        }

        if !isOpen && !hasEmbedded && hasOptionalFields {
            lines.append("")
            lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
            lines.append("\(indent)        var c = encoder.container(keyedBy: CodingKeys.self)")
            for field in fields {
                let safe = propertyName(field, in: fields)
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
            let embeddedName = embeddedPropertyName(fields)
            lines.append("\(indent)    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)), \(embeddedName): \(unionName)) {")
            for field in fields {
                let safe = propertyName(field, in: fields)
                lines.append("\(indent)        self.\(safe) = \(initArgumentName(field, in: fields))")
            }
            lines.append("\(indent)        self.\(embeddedName) = \(embeddedName)")
            lines.append("\(indent)    }")
            lines.append("")
            lines.append("\(indent)    private enum OuterCodingKeys: String, CodingKey {")
            for field in fields {
                let safe = propertyName(field, in: fields)
                lines.append("\(indent)        \(codingKeyCase(safe, wireName: field.name))")
            }
            lines.append("\(indent)    }")
            lines.append("")
            lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
            lines.append("\(indent)        var c = encoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = propertyName(field, in: fields)
                if field.required {
                    lines.append("\(indent)        try c.encode(self.\(safe), forKey: .\(safe))")
                } else {
                    lines.append("\(indent)        try c.encodeIfPresent(self.\(safe), forKey: .\(safe))")
                }
            }
            lines.append("\(indent)        try self.\(embeddedName).encode(to: encoder)")
            lines.append("\(indent)    }")
            lines.append("")
            lines.append("\(indent)    public init(from decoder: Decoder) throws {")
            lines.append("\(indent)        let c = try decoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = propertyName(field, in: fields)
                let swType = swiftTypeNameNoEmit(field.type)
                let alreadyOptional = swType.hasSuffix("?")
                let baseType = alreadyOptional ? String(swType.dropLast()) : swType
                if field.required && !alreadyOptional {
                    lines.append("\(indent)        self.\(safe) = try c.decode(\(baseType).self, forKey: .\(safe))")
                } else {
                    lines.append("\(indent)        self.\(safe) = try c.decodeIfPresent(\(baseType).self, forKey: .\(safe))")
                }
            }
            lines.append("\(indent)        self.\(embeddedName) = try \(unionName)(from: decoder)")
            lines.append("\(indent)    }")
        }

        // An open record writes its attributes flat beside its properties and has a public init, as a component
        // schema's does (synthesized `Codable` would nest them under an `"attributes"` key).
        if isOpen && !hasEmbedded, let additionalPropertiesType {
            let open = openRecordLines(
                fields: fields, additionalPropertiesType: additionalPropertiesType, excludedKeys: excludedKeys
            )
            lines.append(contentsOf: open.map { $0.isEmpty ? $0 : indent + $0 })
        }

        // Emit a public memberwise init (Swift's synthesized one is internal), with validation and defaults
        if !isOpen && !hasEmbedded {
            let hasValidation = fields.contains { !constraintValidationLines(field: $0, accessor: propertyName($0, in: fields)).isEmpty }
            lines.append("")
            lines.append("\(indent)    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)))\(hasValidation ? " throws" : "") {")
            for field in fields {
                let safe = propertyName(field, in: fields)
                let arg = initArgumentName(field, in: fields)
                let validationLines = constraintValidationLines(field: field, accessor: arg)
                for line in validationLines {
                    lines.append("\(indent)        \(line)")
                }
                lines.append("\(indent)        self.\(safe) = \(arg)")
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
            guard !variant.fields.isEmpty
                    || variant.additionalPropertiesType != nil
                    || variant.embeddedUnion != nil
                    || !variant.nestedTypes.isEmpty else { continue }
            if variant.payloadTypeName != nil || variant.valueType != nil { continue }
            emitNestedRecordStruct(
                name: variant.name, fields: variant.fields,
                additionalPropertiesType: variant.additionalPropertiesType,
                embeddedUnion: variant.embeddedUnion,
                children: variant.nestedTypes, excludedKeys: discriminator.map { [$0.fieldName] } ?? [],
                indent: indent, lines: &lines
            )
        }

        // A value arm's own types (the element of `[{…}]`, an enum arm) are declared beside the enum, like the
        // variant structs.
        for variant in variants where variant.valueType != nil {
            for node in valueArmTypes(variant) {
                emitNestedTypeNode(node, indent: indent, lines: &lines)
            }
        }

        lines.append("")
        lines.append("\(indent)public enum \(name): Codable {")
        lines.append(contentsOf: unionCaseLines(variants, indent: indent))
        if let disc = discriminator {
            emitDiscriminatedCoding(name: name, variants: variants, discriminator: disc, indent: indent, lines: &lines)
        } else {
            emitTransparentUnionCoding(name: name, variants: variants, indent: indent, lines: &lines)
        }
        lines.append("\(indent)}")

        // Emit children
        for child in children {
            emitNestedTypeNode(child, indent: indent + "    ", lines: &lines)
        }
    }

    // Internal-discriminator unions only: `emitType` routes the others to `emitTransparentUnionCoding`.
    private func emitDiscriminatedCoding(
        name: String, variants: [UnionVariant], discriminator: DiscriminatorInfo, indent: String = "", lines: inout [String]
    ) {
        let discKey = escapedSwiftName(discriminator.fieldName)
        // A value arm (`string`) or a literal arm has no discriminator and encodes as a bare JSON value, so with
        // one the keyed container is opened per object case, and the value arms decode before the discriminator
        // is read.
        let valueVariants = variants.filter(isBareValue)
        // The discriminator's values keep their JSON type: `isUpdated: true` is a boolean, not `"true"`.
        let tagLiteral = { (tag: String) in swiftLiteral(tag, kind: discriminator.kind) }
        let openContainer = "var container = encoder.container(keyedBy: CodingKeys.self)"
        lines.append("")
        lines.append("\(indent)    enum CodingKeys: String, CodingKey {")
        // A discriminator that isn't an identifier is sanitized and keeps its wire name.
        let discWireName = unescapedSwiftName(discKey) == discriminator.fieldName
            ? "" : " = \"\(swiftStringContent(discriminator.fieldName))\""
        lines.append("\(indent)        case \(discKey)\(discWireName)")
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
        if valueVariants.isEmpty {
            lines.append("\(indent)        \(openContainer)")
        }
        lines.append("\(indent)        switch self {")
        for variant in variants {
            if let discVal = variant.discriminatorValue {
                let hasPayload = unionCasePayload(variant) != nil
                lines.append("\(indent)        case .\(unionCaseName(variant))\(hasPayload ? "(let params)" : ""):")
                if !valueVariants.isEmpty {
                    lines.append("\(indent)            \(openContainer)")
                }
                lines.append("\(indent)            try container.encode(\(tagLiteral(discVal)), forKey: .\(discKey))")
                if hasPayload {
                    lines.append("\(indent)            try params.encode(to: encoder)")
                }
            } else if let literal = variant.literal {
                lines.append("\(indent)        case .\(unionCaseName(variant)):")
                lines.append("\(indent)            var container = encoder.singleValueContainer()")
                lines.append("\(indent)            try container.encode(\(swiftLiteral(literal)))")
            } else if variant.valueType != nil {
                lines.append("\(indent)        case .\(unionCaseName(variant))(let value):")
                lines.append("\(indent)            var container = encoder.singleValueContainer()")
                lines.append("\(indent)            try container.encode(value)")
            }
        }
        lines.append("\(indent)        }")
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    public init(from decoder: Decoder) throws {")
        // A map or a transferable arm decodes from an object too, so it's tried only when the discriminator is
        // missing.
        for variant in valueVariants where !decodesFromAnObject(variant.valueType) {
            emitValueArmDecoding(variant, condition: nil, indent: indent, lines: &lines)
        }
        lines.append("\(indent)        let container = try decoder.container(keyedBy: CodingKeys.self)")
        for variant in valueVariants where decodesFromAnObject(variant.valueType) {
            emitValueArmDecoding(variant, condition: "!container.contains(.\(discKey))", indent: indent, lines: &lines)
        }
        let discType = swiftTypeNameNoEmit(.primitive(discriminator.kind))
        lines.append("\(indent)        let disc = try container.decode(\(discType).self, forKey: .\(discKey))")
        lines.append("\(indent)        switch disc {")
        // Group variants by discriminator value: when multiple variants share
        // a value, the discriminator alone is ambiguous on decode. Try each
        // shape in order and take the first that parses successfully.
        var byTag: [String: [UnionVariant]] = [:]
        var tagOrder: [String] = []
        for variant in variants {
            guard let tag = variant.discriminatorValue else { continue }
            if byTag[tag] == nil { tagOrder.append(tag) }
            byTag[tag, default: []].append(variant)
        }
        for tag in tagOrder {
            let group = byTag[tag] ?? []
            if group.count == 1 {
                let variant = group[0]
                if let payload = unionCasePayload(variant) {
                    lines.append("\(indent)        case \(tagLiteral(tag)): self = .\(unionCaseName(variant))(try \(payload)(from: decoder))")
                } else {
                    lines.append("\(indent)        case \(tagLiteral(tag)): self = .\(unionCaseName(variant))")
                }
            } else {
                lines.append("\(indent)        case \(tagLiteral(tag)):")
                for (idx, variant) in group.enumerated() {
                    let payload = variant.payloadTypeName ?? variant.name
                    let prefix = idx == 0 ? "if" : "} else if"
                    lines.append("\(indent)            \(prefix) let v = try? \(payload)(from: decoder) {")
                    lines.append("\(indent)                self = .\(unionCaseName(variant))(v)")
                    lines.append("\(indent)                return")
                }
                lines.append("\(indent)            } else {")
                let errMsg = "No \(name) variant matched for tag '\\(disc)'"
                lines.append(
                    "\(indent)                throw DecodingError"
                    + ".dataCorruptedError(forKey: .\(discKey),"
                    + " in: container, debugDescription: \"\(errMsg)\")"
                )
                lines.append("\(indent)            }")
            }
        }
        // A boolean discriminator with both values is exhaustive; a `default` would never run (a warning).
        if !(discriminator.kind == .boolean && Set(tagOrder) == ["true", "false"]) {
            let defErr = "Unknown value: \\(disc)"
            lines.append("\(indent)        default:")
            lines.append(
                "\(indent)            throw DecodingError"
                + ".dataCorruptedError(forKey: .\(discKey),"
                + " in: container, debugDescription: \"\(defErr)\")"
            )
        }
        lines.append("\(indent)        }")
        lines.append("\(indent)    }")
    }

    /// For unions whose discriminator lives on a *sibling* argument (not in the
    /// payload), the JSON wire form is the bare payload — no `{caseName: ...}`
    /// envelope. We override Codable so encoding/decoding strips that envelope.
    /// A value arm (`string`, `[Int]`) is the bare JSON value, and a literal arm (`"auto"`, `false`) that value.
    /// A value encodes through a single-value container, so the encoder's strategies apply (a `Date` is an
    /// ISO 8601 string, a `URL` a string); its own `encode(to:)` would bypass them.
    private func emitTransparentUnionCoding(name: String, variants: [UnionVariant], indent: String = "", lines: inout [String]) {
        lines.append("")
        lines.append("\(indent)    public func encode(to encoder: Encoder) throws {")
        lines.append("\(indent)        switch self {")
        for variant in variants {
            let caseName = unionCaseName(variant)
            if let literal = variant.literal {
                lines.append("\(indent)        case .\(caseName):")
                lines.append("\(indent)            var container = encoder.singleValueContainer()")
                lines.append("\(indent)            try container.encode(\(swiftLiteral(literal)))")
            } else if variant.valueType != nil {
                lines.append("\(indent)        case .\(caseName)(let payload):")
                lines.append("\(indent)            var container = encoder.singleValueContainer()")
                lines.append("\(indent)            try container.encode(payload)")
            } else if unionCasePayload(variant) != nil {
                lines.append("\(indent)        case .\(caseName)(let payload):")
                lines.append("\(indent)            try payload.encode(to: encoder)")
            } else {
                lines.append("\(indent)        case .\(caseName):")
                lines.append("\(indent)            _ = encoder.container(keyedBy: EmptyKey.self)")
            }
        }
        lines.append("\(indent)        }")
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    public init(from decoder: Decoder) throws {")
        // A literal arm has no payload but isn't a fallback: it decodes only from its value.
        let fieldless = variants.first { unionCasePayload($0) == nil && $0.literal == nil }
        // With a fieldless fallback, a variant's decoding error is never thrown, so it isn't kept; nor is it when
        // only literal arms are tried, which have no error to keep.
        let keepsLastError = fieldless == nil && variants.contains { unionCasePayload($0) != nil }
        if keepsLastError {
            lines.append("\(indent)        var lastError: Error?")
        }
        for variant in variants {
            let caseName = unionCaseName(variant)
            if variant.literal != nil {
                emitValueArmDecoding(variant, condition: nil, indent: indent, lines: &lines)
                continue
            }
            guard let payload = unionCasePayload(variant) else { continue }
            let decode = variant.valueType != nil
                ? "decoder.singleValueContainer().decode(\(payload).self)"
                : "\(payload)(from: decoder)"
            if fieldless != nil {
                lines.append("\(indent)        if let value = try? \(decode) {")
                lines.append("\(indent)            self = .\(caseName)(value)")
                lines.append("\(indent)            return")
                lines.append("\(indent)        }")
            } else {
                lines.append("\(indent)        do {")
                lines.append("\(indent)            self = .\(caseName)(try \(decode))")
                lines.append("\(indent)            return")
                lines.append("\(indent)        } catch { lastError = error }")
            }
        }
        if let fieldless {
            lines.append("\(indent)        self = .\(unionCaseName(fieldless))")
        } else {
            let errDesc = "No \(name) variant matched"
            lines.append(
                "\(indent)        throw \(keepsLastError ? "lastError ?? " : "")"
                + "DecodingError.dataCorrupted(.init(codingPath:"
                + " decoder.codingPath, debugDescription: \"\(errDesc)\"))"
            )
        }
        lines.append("\(indent)    }")
        lines.append("")
        lines.append("\(indent)    private enum EmptyKey: CodingKey {}")
    }

    /// `if [condition,] let value = try? <decode value arm> { self = .arm(value); return }`. A literal arm:
    /// `if let value = try? <decode its JSON type>, value == <literal> { self = .arm; return }`.
    private func emitValueArmDecoding(_ variant: UnionVariant, condition: String?, indent: String, lines: inout [String]) {
        let guardClause = condition.map { "\($0), " } ?? ""
        if let literal = variant.literal {
            let type = swiftTypeNameNoEmit(.primitive(literal.kind))
            lines.append(
                "\(indent)        if \(guardClause)let value = try? decoder.singleValueContainer().decode(\(type).self),"
                + " value == \(swiftLiteral(literal)) {"
            )
            lines.append("\(indent)            self = .\(unionCaseName(variant))")
            lines.append("\(indent)            return")
            lines.append("\(indent)        }")
            return
        }
        guard let payload = unionCasePayload(variant) else { return }
        lines.append("\(indent)        if \(guardClause)let value = try? decoder.singleValueContainer().decode(\(payload).self) {")
        lines.append("\(indent)            self = .\(unionCaseName(variant))(value)")
        lines.append("\(indent)            return")
        lines.append("\(indent)        }")
    }

    /// Whether a union variant gets a synthesized payload struct named after it.
    private func hasSynthBody(_ variant: UnionVariant) -> Bool {
        !variant.fields.isEmpty || variant.additionalPropertiesType != nil || variant.embeddedUnion != nil
    }

    /// The type a union case carries: an existing named type, the variant's synthesized struct, or the value
    /// of a non-object arm (`String`, `[Int]`). Nil for a payload-less case.
    private func unionCasePayload(_ variant: UnionVariant) -> String? {
        if let name = variant.payloadTypeName { return name }
        if hasSynthBody(variant) { return variant.name }
        return variant.valueType.map { swiftTypeNameNoEmit($0) }
    }

    /// The `case` lines of a union's enum.
    private func unionCaseLines(_ variants: [UnionVariant], indent: String) -> [String] {
        variants.map { variant in
            let caseName = unionCaseName(variant)
            if let payload = unionCasePayload(variant) {
                return "\(indent)    case \(caseName)(\(payload))"
            }
            return "\(indent)    case \(caseName)"
        }
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
            emitRecordStruct(
                name: name, fields: fields, additionalPropertiesType: additionalPropertiesType,
                embeddedUnion: embeddedUnion, children: nestedTypesByName[name] ?? [], lines: &lines
            )

        case .enum(_, let values):
            emitted.insert(name)
            lines.append("")
            lines.append("public enum \(name): String, Codable {")
            lines.append(contentsOf: enumCaseLines(values, indent: "    "))
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
                    children: variant.nestedTypes,
                    excludedKeys: discriminator.map { [$0.fieldName] } ?? [],
                    lines: &lines
                )
            }
            // A value arm's own types (the element of `[{…}]`) are declared beside the enum, like the variant structs.
            for variant in variants {
                guard let valueType = variant.valueType else { continue }
                emitDependentTypes(valueType, emitted: &emitted, lines: &lines)
                for node in variant.nestedTypes {
                    emitSchemaNestedType(node, indent: "", lines: &lines)
                }
            }
            var body: [String] = []
            body.append("")
            body.append("public enum \(name): Codable {")
            body.append(contentsOf: unionCaseLines(variants, indent: ""))
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
    ///
    /// `children` are the types nested inside the struct (a component schema's inline-object
    /// properties); `indent` is the struct's own indentation when it is itself nested. `excludedKeys` are an open
    /// record's keys that aren't attributes besides its properties (a union variant's discriminator).
    ///
    /// `attributes` and `challenge` step aside for a property of their name (`attributes_2`), and each property is
    /// its spec name, sanitized when that isn't an identifier and unique among its siblings (`propertyNames`); a
    /// renamed property keeps its wire name in `CodingKeys`.
    private func emitRecordStruct(
        name: String, fields: [ResolvedField], additionalPropertiesType: ResolvedType?, embeddedUnion: ResolvedType?,
        children: [NestedTypeNode] = [], excludedKeys: [String] = [], indent: String = "", lines: inout [String]
    ) {
        var body = recordStructBody(
            name: name, fields: fields, additionalPropertiesType: additionalPropertiesType, embeddedUnion: embeddedUnion,
            excludedKeys: excludedKeys
        )
        // Nested types go inside the struct, before its closing brace.
        let closingBrace = body.removeLast()
        for child in children {
            emitSchemaNestedType(child, indent: "    ", lines: &body)
        }
        body.append(closingBrace)
        lines.append(contentsOf: body.map { $0.isEmpty ? $0 : indent + $0 })
    }

    /// The lines of a record struct, ending with its closing brace.
    private func recordStructBody(
        name: String, fields: [ResolvedField], additionalPropertiesType: ResolvedType?, embeddedUnion: ResolvedType?,
        excludedKeys: [String] = []
    ) -> [String] {
        let fields = fields.filter { !isVoidType($0.type) }
        var body: [String] = []
        body.append("")
        body.append("public struct \(name): Codable {")
        for field in fields {
            let swType = swiftTypeNameNoEmit(field.type)
            let alreadyOptional = swType.hasSuffix("?")
            let optSuffix = (!field.required && !alreadyOptional) ? "?" : ""
            body.append("    public let \(propertyName(field, in: fields)): \(swType)\(optSuffix)")
        }
        if let addPropsType = additionalPropertiesType {
            let valueType = swiftTypeNameNoEmit(addPropsType)
            body.append("    public let \(extrasPropertyName(fields)): [String: \(valueType)]")
        }
        if let embedded = embeddedUnion, case .union(let unionName, _, _) = embedded {
            body.append("    public let \(embeddedPropertyName(fields)): \(unionName)")
        }

        let needsCodingKeys = fields.contains { propertyName($0, in: fields) != $0.name }
        let isOpen = additionalPropertiesType != nil
        let hasEmbedded = embeddedUnion != nil

        if hasEmbedded, case .union(let unionName, _, _)? = embeddedUnion {
            // Merged Codable: outer fields encode normally, embedded union
            // encodes its discriminator + payload onto the same JSON object.
            body.append("")
            let embeddedName = embeddedPropertyName(fields)
            body.append("    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)), \(embeddedName): \(unionName)) {")
            for field in fields {
                let safe = propertyName(field, in: fields)
                body.append("        self.\(safe) = \(initArgumentName(field, in: fields))")
            }
            body.append("        self.\(embeddedName) = \(embeddedName)")
            body.append("    }")

            body.append("")
            body.append("    private enum OuterCodingKeys: String, CodingKey {")
            for field in fields {
                let safe = propertyName(field, in: fields)
                body.append("        \(codingKeyCase(safe, wireName: field.name))")
            }
            body.append("    }")

            body.append("")
            body.append("    public func encode(to encoder: Encoder) throws {")
            body.append("        var c = encoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = propertyName(field, in: fields)
                if field.required {
                    body.append("        try c.encode(self.\(safe), forKey: .\(safe))")
                } else {
                    body.append("        try c.encodeIfPresent(self.\(safe), forKey: .\(safe))")
                }
            }
            body.append("        try self.\(embeddedName).encode(to: encoder)")
            body.append("    }")

            body.append("")
            body.append("    public init(from decoder: Decoder) throws {")
            body.append("        let c = try decoder.container(keyedBy: OuterCodingKeys.self)")
            for field in fields {
                let safe = propertyName(field, in: fields)
                let swType = swiftTypeNameNoEmit(field.type)
                let alreadyOptional = swType.hasSuffix("?")
                let baseType = alreadyOptional ? String(swType.dropLast()) : swType
                if field.required && !alreadyOptional {
                    body.append("        self.\(safe) = try c.decode(\(baseType).self, forKey: .\(safe))")
                } else {
                    body.append("        self.\(safe) = try c.decodeIfPresent(\(baseType).self, forKey: .\(safe))")
                }
            }
            body.append("        self.\(embeddedName) = try \(unionName)(from: decoder)")
            body.append("    }")
            body.append("}")
            return body
        }

        if isOpen, let additionalPropertiesType {
            body.append(contentsOf: openRecordLines(
                fields: fields, additionalPropertiesType: additionalPropertiesType, excludedKeys: excludedKeys
            ))
        } else {
            let hasOptionals = fields.contains { !$0.required || swiftTypeNameNoEmit($0.type).hasSuffix("?") }
            if needsCodingKeys || hasOptionals {
                body.append("")
                body.append("    enum CodingKeys: String, CodingKey {")
                for field in fields {
                    let safe = propertyName(field, in: fields)
                    body.append("        \(codingKeyCase(safe, wireName: field.name))")
                }
                body.append("    }")
            }
            if hasOptionals {
                body.append("")
                body.append("    public func encode(to encoder: Encoder) throws {")
                body.append("        var c = encoder.container(keyedBy: CodingKeys.self)")
                for field in fields {
                    let safe = propertyName(field, in: fields)
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
        // Emit an explicit `public` memberwise init: Swift's synthesized one
        // is `internal`, so code outside the generated module couldn't
        // construct the struct. It runs validation guards for fields with
        // spec constraints and supplies spec defaults (optional fields
        // default to `nil`). We intentionally do NOT emit when the record
        // already has a custom init above (open shape / embedded union) —
        // those paths emit their own public init.
        if !isOpen && !hasEmbedded {
            let hasValidation = fields.contains { !constraintValidationLines(field: $0, accessor: propertyName($0, in: fields)).isEmpty }
            body.append("")
            body.append("    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: nil)))\(hasValidation ? " throws" : "") {")
            for field in fields {
                let safe = propertyName(field, in: fields)
                let arg = initArgumentName(field, in: fields)
                let validationLines = constraintValidationLines(field: field, accessor: arg)
                for line in validationLines {
                    body.append("        \(line)")
                }
                body.append("        self.\(safe) = \(arg)")
            }
            body.append("    }")
        }
        body.append("}")
        return body
    }

    /// The members of an open record (`T & Record<string, V>`), after its stored properties: a public memberwise
    /// init and a custom `Codable` that writes `attributes` flat at the JSON top level beside the properties and
    /// reads every other key back into it. Lines are indented for the struct's body; the caller adds the struct's
    /// own indentation. Used in every scope (component schemas, operation-scoped records, union variants), so an
    /// open record encodes the same wherever it's declared. `excludedKeys` are keys that aren't attributes
    /// besides the properties (a union variant's discriminator, which the union writes). An attribute named like
    /// a property or an excluded key isn't sent: the typed value wins.
    private func openRecordLines(
        fields: [ResolvedField], additionalPropertiesType: ResolvedType, excludedKeys: [String] = []
    ) -> [String] {
        var body: [String] = []
        // Memberwise init so customers can construct values directly.
        body.append("")
        body.append("    public init(\(memberwiseInitParams(fields: fields, additionalPropertiesType: additionalPropertiesType))) {")
        for field in fields {
            let safe = propertyName(field, in: fields)
            body.append("        self.\(safe) = \(initArgumentName(field, in: fields))")
        }
        let extras = extrasPropertyName(fields)
        body.append("        self.\(extras) = \(extras)")
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
        var fixedNames: [String] = []
        for name in fields.map(\.name) + excludedKeys where !fixedNames.contains(name) {
            fixedNames.append(name)
        }
        for name in fixedNames {
            body.append("        \"\(swiftStringContent(name))\",")
        }
        body.append("    ]")
        body.append("")
        // encode
        body.append("    public func encode(to encoder: Encoder) throws {")
        body.append("        var c = encoder.container(keyedBy: DynamicKey.self)")
        for field in fields {
            let safe = propertyName(field, in: fields)
            let key = swiftStringContent(field.name)
            if field.required {
                body.append("        try c.encode(self.\(safe), forKey: DynamicKey(stringValue: \"\(key)\")!)")
            } else {
                body.append("        try c.encodeIfPresent(self.\(safe), forKey: DynamicKey(stringValue: \"\(key)\")!)")
            }
        }
        body.append("        for (k, v) in self.\(extras) where !Self.fixedFieldNames.contains(k) {")
        body.append("            try c.encode(v, forKey: DynamicKey(stringValue: k)!)")
        body.append("        }")
        body.append("    }")
        // decode
        let valueType = swiftTypeNameNoEmit(additionalPropertiesType)
        body.append("")
        body.append("    public init(from decoder: Decoder) throws {")
        body.append("        let c = try decoder.container(keyedBy: DynamicKey.self)")
        for field in fields {
            let safe = propertyName(field, in: fields)
            let key = swiftStringContent(field.name)
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
        body.append("        self.\(extras) = extras")
        body.append("    }")
        return body
    }

    /// Surface the constraints attached to a `ResolvedType` (only primitive,
    /// formattedType, and list carry them). Walks one level of nullable.
    private func typeConstraints(_ type: ResolvedType) -> Constraints {
        switch type {
        case .primitive(_, let constraints): return constraints
        case .formattedType(_, let constraints): return constraints
        case .list(_, let constraints): return constraints
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

        // The field's wire name, as it goes into a message's string literal.
        let fieldName = swiftStringContent(field.name)
        var checks: [String] = []
        switch field.type {
        case .primitive(.string, _), .formattedType:
            if let min = constraints.minLength {
                let minErr = "\(fieldName) must be at least \(min) characters"
                checks.append(
                    "guard \(valueVar).count >= \(min)"
                    + " else { throw CodegenError.validation(\"\(minErr)\") }"
                )
            }
            if let max = constraints.maxLength {
                let maxErr = "\(fieldName) must be at most \(max) characters"
                checks.append(
                    "guard \(valueVar).count <= \(max)"
                    + " else { throw CodegenError.validation(\"\(maxErr)\") }"
                )
            }
            if let pattern = constraints.pattern {
                // JSON Schema `pattern` uses ECMA-262 semantics (unanchored match).
                // `range(of:options:.regularExpression)` matches this — it succeeds
                // if the pattern matches anywhere in the string, not just the full string.
                // Escaped like every spec string in a literal: `\`, `"`, and line breaks and control characters too.
                let escaped = swiftStringContent(pattern)
                let patternErr = "\(fieldName) must match pattern \(escaped)"
                checks.append(
                    "guard \(valueVar).range(of: \"\(escaped)\","
                    + " options: .regularExpression) != nil"
                    + " else { throw CodegenError.validation(\"\(patternErr)\") }"
                )
            }
        case .primitive(.integer, _), .primitive(.number, _):
            let isInt = { if case .primitive(.integer, _) = field.type { return true } else { return false } }()
            let cast: (Double) -> String = { num in isInt ? String(Int(num)) : String(num) }
            if let limit = constraints.minimum {
                let err = "\(fieldName) must be >= \(cast(limit))"
                checks.append(
                    "guard \(valueVar) >= \(cast(limit))"
                    + " else { throw CodegenError.validation(\"\(err)\") }"
                )
            }
            if let limit = constraints.maximum {
                let err = "\(fieldName) must be <= \(cast(limit))"
                checks.append(
                    "guard \(valueVar) <= \(cast(limit))"
                    + " else { throw CodegenError.validation(\"\(err)\") }"
                )
            }
            if let limit = constraints.exclusiveMinimum {
                let err = "\(fieldName) must be > \(cast(limit))"
                checks.append(
                    "guard \(valueVar) > \(cast(limit))"
                    + " else { throw CodegenError.validation(\"\(err)\") }"
                )
            }
            if let limit = constraints.exclusiveMaximum {
                let err = "\(fieldName) must be < \(cast(limit))"
                checks.append(
                    "guard \(valueVar) < \(cast(limit))"
                    + " else { throw CodegenError.validation(\"\(err)\") }"
                )
            }
            if let limit = constraints.multipleOf {
                let mod = isInt
                    ? "\(valueVar) % \(Int(limit))"
                    : "\(valueVar).truncatingRemainder(dividingBy: \(limit))"
                let err = "\(fieldName) must be a multiple of \(cast(limit))"
                checks.append(
                    "guard \(mod) == 0"
                    + " else { throw CodegenError.validation(\"\(err)\") }"
                )
            }
        case .list:
            if let limit = constraints.minItems {
                let err = "\(fieldName) must have at least \(limit) items"
                checks.append(
                    "guard \(valueVar).count >= \(limit)"
                    + " else { throw CodegenError.validation(\"\(err)\") }"
                )
            }
            if let limit = constraints.maxItems {
                let err = "\(fieldName) must have at most \(limit) items"
                checks.append(
                    "guard \(valueVar).count <= \(limit)"
                    + " else { throw CodegenError.validation(\"\(err)\") }"
                )
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
            let safe = propertyName(field, in: fields)
            let arg = initArgumentName(field, in: fields)
            let label = arg == safe ? safe : "\(safe) \(arg)"
            // Default-value precedence:
            //   1. Spec-provided `default` (rendered as a Swift literal).
            //   2. Optional / nullable field with no spec default → `= nil`.
            //   3. Required field with no default → no default.
            if let raw = field.defaultValue, let literal = swiftLiteralForJSONDefault(raw, type: field.type) {
                parts.append("\(label): \(typeStr) = \(literal)")
            } else if !field.required && !alreadyOptional {
                parts.append("\(label): \(typeStr) = nil")
            } else if alreadyOptional {
                parts.append("\(label): \(typeStr) = nil")
            } else {
                parts.append("\(label): \(typeStr)")
            }
        }
        if let addPropsType = additionalPropertiesType {
            let valueType = swiftTypeNameNoEmit(addPropsType)
            parts.append("\(extrasPropertyName(fields)): [String: \(valueType)] = [:]")
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
        // Strings: JSON renders them with surrounding quotes, but JSON's escapes
        // aren't Swift's (`\/`, `\u0001`; and Swift would interpolate `\(`), so
        // read the string back and escape it as a Swift literal.
        if trimmed.hasPrefix("\"") && trimmed.hasSuffix("\"") {
            guard let value = try? JSONDecoder().decode(String.self, from: Data(trimmed.utf8)) else { return nil }
            return "\"\(swiftStringContent(value))\""
        }
        // Booleans + numbers round-trip as-is.
        if trimmed == "true" || trimmed == "false" || Double(trimmed) != nil || Int(trimmed) != nil {
            return trimmed
        }
        // Arrays / objects: skip — Swift can't initialise arbitrary nested
        // shapes from a JSON literal at compile time.
        return nil
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
        case .transferable(let blocksType, let typeArgs):
            // A channel's message type can be nested in the operation (`GetChannel.ResultMessage`).
            return transferableSwiftTypeName(blocksType, typeArgs: typeArgs) {
                qualifiedSwiftTypeName($0, qualifiedNames: qualifiedNames)
            }
        default:
            return swiftTypeNameNoEmit(type)
        }
    }

    private func emitOperation(
        _ operation: Operation, namespace: String, prefixNamespace: Bool, lines: inout [String],
        emitted: inout Set<String>, modelLines: inout [String], qualifiedNames: [String: String] = [:],
        classNames: APIClassNames
    ) {
        let fullMethodName = namespace == "_default" ? operation.name : "\(namespace).\(operation.name)"
        // The method name as it goes into a string literal.
        let methodLiteral = swiftStringContent(fullMethodName)
        // A direct transferable, or a nullable one with a known binding, is hydrated from its descriptor.
        let transferable = transferableResult(operation.result.type)
        let isTransferable = transferable != nil
        // An unbound result returns UnknownTransferable; its type-arg model is still
        // emitted (unreferenced here) so the AWSBLOCKS-NATIVE-001 diagnostic can name it.
        let unboundTag = unboundTransferableTag(operation.result.type)
        let returnType = unboundTag != nil
            ? "BlocksRuntime.UnknownTransferable"
            : qualifiedSwiftTypeName(operation.result.type, qualifiedNames: qualifiedNames)
        let messageType: String? = {
            guard case .transferable("realtime/channel", let typeArgs)? = transferable?.type else { return nil }
            return typeArgs.first.map { qualifiedSwiftTypeName($0, qualifiedNames: qualifiedNames) } ?? "JSONValue"
        }()
        // Generated locals step aside for parameters of their name; a parameter named like a type the body spells
        // (or `self`) keeps its label and takes an internal name.
        let names = operationNames(
            operation, classNames: classNames,
            bodyTypes: spelledRootIdentifiers(returnType).union(messageType.map(spelledRootIdentifiers) ?? [])
        )
        let client = names.client

        // Build parameter list
        var paramList: [String] = []
        for (index, param) in operation.parameters.enumerated() {
            let swType = qualifiedSwiftTypeName(param.type, qualifiedNames: qualifiedNames)
            let declaration = names.parameterDeclaration(index)
            let alreadyOptional = swType.hasSuffix("?")
            // An optional parameter defaults to `nil`, so a caller can leave it out, whether its schema is nullable
            // (`oneOf [T, null]`, as the spec generator writes every TypeScript `x?: T`) or not. A required one has
            // no default, nullable or not.
            if param.required {
                paramList.append("\(declaration): \(swType)")
            } else if alreadyOptional {
                paramList.append("\(declaration): \(swType) = nil")
            } else {
                paramList.append("\(declaration): \(swType)? = nil")
            }
        }
        let paramStr = paramList.joined(separator: ", ")

        let funcName: String
        if prefixNamespace && namespace != "_default" {
            funcName = escapedSwiftName(swiftIdentifierCandidate("\(namespace)\(pascalCase(operation.name))"))
        } else {
            funcName = classNames.functions[operation.name] ?? escapedSwiftName(operation.name)
        }

        let request = names.request
        let result = names.result
        let docName = fullMethodName.replacingOccurrences(of: "\n", with: "\\n").replacingOccurrences(of: "\r", with: "\\r")
        lines.append("    /// Calls `\(docName)`.")
        lines.append("    public func \(funcName)(\(paramStr)) async throws -> \(returnType) {")

        // Build request
        lines.append(contentsOf: requestLines(operation, names: names, methodLiteral: methodLiteral))

        // Execute and deserialize
        lines.append("        let \(result) = try await \(client).execute(\(request))")

        // An optional (nullable) transferable result returns nil for a null body; every other result throws.
        let nullResult = transferable?.optional == true
            ? "guard let \(result) else { return nil }"
            : "guard let \(result) else { throw RPCError(message: \"Unexpected null result for \(methodLiteral)\") }"
        if isTransferable {
            // Hydrate transferable from the raw JSON descriptor
            if let transferable {
                lines.append(contentsOf: transferableResultLines(
                    transferable.type, operation: operation, names: names, messageType: messageType,
                    nullResult: nullResult, methodLiteral: methodLiteral
                ))
            }
        } else if returnType == "Void" {
            // No return needed
        } else {
            // A result holding an OIDC client or a date at any depth decodes with the client's decoder, which
            // carries the client and reads ISO 8601 dates.
            let decoder = needsClientDecoder(operation.result.type, nestedTypes: operation.nestedTypes)
                ? "\(client).makeDecoder()" : "JSONDecoder()"
            if returnType.hasSuffix("?") {
                let baseType = String(returnType.dropLast())
                lines.append("        guard let \(result) else { return nil }")
                lines.append("        return try \(decoder).decode(\(baseType).self, from: \(result))")
            } else {
                lines.append("        \(nullResult)")
                lines.append("        return try \(decoder).decode(\(returnType).self, from: \(result))")
            }
        }

        lines.append("    }")
    }

    // MARK: - Transferable Helpers

    private func isVoidType(_ type: ResolvedType) -> Bool {
        if case .primitive(let kind, _) = type { return kind == .void }
        if case .nullable(let inner) = type { return isVoidType(inner) }
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
    func swiftTypeNameNoEmit(_ type: ResolvedType) -> String {
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
            // A calendar day (`"2026-10-05"`): Foundation has no day-only type, and a `Date` would be sent as a
            // date-time, which the server rejects.
            case .date:     return "String"
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
            return transferableSwiftTypeName(blocksType, typeArgs: typeArgs) { swiftTypeNameNoEmit($0) }
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
            // A calendar day (`"2026-10-05"`): Foundation has no day-only type, and a `Date` would be sent as a
            // date-time, which the server rejects.
            case .date:     return "String"
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
            return transferableSwiftTypeName(blocksType, typeArgs: typeArgs) {
                swiftTypeName($0, emitted: &emitted, modelLines: &modelLines)
            }
        }
    }
}

// MARK: - Component-schema nested types

private extension SwiftCodeGenerator {
    /// Emit a type nested inside a component schema's struct, with its own nested types inside it.
    func emitSchemaNestedType(_ node: NestedTypeNode, indent: String, lines: inout [String]) {
        switch node.type {
        case .record(_, let fields, let additionalPropertiesType, let embeddedUnion):
            emitRecordStruct(
                name: node.name, fields: fields, additionalPropertiesType: additionalPropertiesType,
                embeddedUnion: embeddedUnion, children: node.children, indent: indent, lines: &lines
            )
        case .union(_, let variants, let discriminator):
            for variant in variants {
                guard !variant.fields.isEmpty
                        || variant.additionalPropertiesType != nil
                        || variant.embeddedUnion != nil else { continue }
                if variant.payloadTypeName != nil { continue }
                emitRecordStruct(
                    name: variant.name, fields: variant.fields,
                    additionalPropertiesType: variant.additionalPropertiesType, embeddedUnion: variant.embeddedUnion,
                    children: variant.nestedTypes, excludedKeys: discriminator.map { [$0.fieldName] } ?? [],
                    indent: indent, lines: &lines
                )
            }
            // A value arm's own types (the element of `[{…}]`, an enum arm's enum) are declared beside the enum,
            // like the variant structs.
            for variant in variants where variant.valueType != nil {
                for node in valueArmTypes(variant) {
                    emitSchemaNestedType(node, indent: indent, lines: &lines)
                }
            }
            lines.append("")
            lines.append("\(indent)public enum \(node.name): Codable {")
            lines.append(contentsOf: unionCaseLines(variants, indent: indent))
            if let disc = discriminator {
                emitDiscriminatedCoding(name: node.name, variants: variants, discriminator: disc, indent: indent, lines: &lines)
            } else {
                emitTransparentUnionCoding(name: node.name, variants: variants, indent: indent, lines: &lines)
            }
            lines.append("\(indent)}")
            for child in node.children {
                emitSchemaNestedType(child, indent: indent, lines: &lines)
            }
        default:
            // Enums print the same at any depth.
            emitNestedTypeNode(node, indent: indent, lines: &lines)
        }
    }
}
