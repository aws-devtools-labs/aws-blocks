//
// Copyright Amazon.com Inc. or its affiliates.
// All Rights Reserved.
//
// SPDX-License-Identifier: Apache-2.0
//

import Foundation

// MARK: - Stage 2: Codegen Model Builder
//
// Transforms RPCModel → CodegenModel. Inline types are scoped inside their
// owning operation as NestedTypeNode trees (emitted as nested Swift enums/
// structs). Component schemas ($ref) remain as flat TypeDefinitions in
// Models.swift.

public struct CodegenModelBuilder {
    public init() {}

    // MARK: - Nesting Tracker

    private struct InlineTypeEntry {
        let id: String
        let shortName: String
        let type: ResolvedType
        let parentId: String?
    }

    public func build(from rpcModel: RPCModel) -> CodegenModel {
        var typeDefinitions: [TypeDefinition] = []
        var declaredNames: Set<String> = []

        // Step 1: Resolve component schemas with their declared names.
        for (schemaName, typeRef) in rpcModel.componentSchemas.sorted(by: { $0.key < $1.key }) {
            let resolved = resolveType(
                typeRef,
                name: schemaName,
                parentSchemaName: schemaName,
                componentSchemas: rpcModel.componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames
            )
            if !declaredNames.contains(schemaName) {
                typeDefinitions.append(TypeDefinition(name: schemaName, type: resolved))
                declaredNames.insert(schemaName)
            }
        }

        // Step 2: Walk each method, resolving params and result.
        // Inline types use short names and are tracked for nesting.
        var namespaceMap: [String: [Operation]] = [:]

        for method in rpcModel.methods {
            let parts = method.name.split(separator: ".", maxSplits: 1)
            let namespaceName = parts.count > 1 ? String(parts[0]) : "_default"
            let opName = parts.count > 1 ? String(parts[1]) : method.name

            // Inline types for this operation are collected separately
            var inlineTypes: [InlineTypeEntry] = []

            let parameters = method.params.map { param -> OperationParameter in
                let shortName = pascalCase(param.name)
                let resolved = resolveType(
                    param.schema,
                    name: shortName,
                    parentSchemaName: nil,
                    componentSchemas: rpcModel.componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    inlineTypes: &inlineTypes,
                    currentParentId: nil
                )
                return OperationParameter(name: param.name, type: resolved, required: param.required)
            }

            let resultType: ResolvedType
            if let result = method.result {
                let resultName = "Result"
                let resolved = resolveType(
                    result.schema,
                    name: resultName,
                    parentSchemaName: nil,
                    componentSchemas: rpcModel.componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    inlineTypes: &inlineTypes,
                    currentParentId: nil
                )
                resultType = resolved
            } else {
                resultType = .primitive(.void)
            }

            let nestedTypes = buildNestedTypeNodes(from: inlineTypes)

            namespaceMap[namespaceName, default: []].append(Operation(
                name: opName,
                parameters: parameters,
                result: OperationResult(type: resultType),
                nestedTypes: nestedTypes
            ))
        }

        let apiNamespaces = namespaceMap.sorted { $0.key < $1.key }
            .map { APINamespace(name: $0.key, operations: $0.value) }

        let servers = rpcModel.servers.isEmpty
            ? [ServerDefinition(name: "local", url: "http://localhost:3001/aws-blocks/api")]
            : rpcModel.servers

        return CodegenModel(
            apiNamespaces: apiNamespaces,
            typeDefinitions: typeDefinitions,
            servers: servers
        )
    }

    // MARK: - Nested Type Node Construction

    private func buildNestedTypeNodes(from entries: [InlineTypeEntry]) -> [NestedTypeNode] {
        let roots = entries.filter { $0.parentId == nil }
        return roots.map { buildNode($0, allEntries: entries) }
    }

    private func buildNode(_ entry: InlineTypeEntry, allEntries: [InlineTypeEntry]) -> NestedTypeNode {
        let children = allEntries.filter { $0.parentId == entry.id }
        let childNodes = children.map { buildNode($0, allEntries: allEntries) }

        // If this entry is a union, distribute variant-scoped children into variants' nestedTypes
        let finalType: ResolvedType
        if case .union(let unionName, let variants, let disc) = entry.type {
            let variantPrefix = "\(entry.id):variant:"
            let variantChildEntries = allEntries.filter { item in
                guard let pid = item.parentId else { return false }
                return pid.hasPrefix(variantPrefix)
            }
            if !variantChildEntries.isEmpty {
                // Group entries by variant name
                var variantChildrenMap: [String: [NestedTypeNode]] = [:]
                for childEntry in variantChildEntries {
                    let variantName = String(childEntry.parentId!.dropFirst(variantPrefix.count))
                    let node = buildNode(childEntry, allEntries: allEntries)
                    variantChildrenMap[variantName, default: []].append(node)
                }
                let updatedVariants = variants.map { variant -> UnionVariant in
                    let variantChildren = variantChildrenMap[variant.name] ?? []
                    if !variantChildren.isEmpty {
                        return UnionVariant(
                            name: variant.name,
                            fields: variant.fields,
                            discriminatorValue: variant.discriminatorValue,
                            payloadTypeName: variant.payloadTypeName,
                            additionalPropertiesType: variant.additionalPropertiesType,
                            embeddedUnion: variant.embeddedUnion,
                            nestedTypes: variantChildren
                        )
                    }
                    return variant
                }
                finalType = .union(name: unionName, variants: updatedVariants, discriminator: disc)
            } else {
                finalType = entry.type
            }
        } else {
            finalType = entry.type
        }

        return NestedTypeNode(name: entry.shortName, type: finalType, children: childNodes)
    }

    // MARK: - Type Resolution

    private func resolveType(
        _ typeRef: TypeRef,
        name: String,
        parentSchemaName: String?,
        componentSchemas: [String: TypeRef],
        typeDefinitions: inout [TypeDefinition],
        declaredNames: inout Set<String>,
        parentName: String? = nil,
        asUnionVariant: Bool = false,
        skipFieldNames: Set<String> = [],
        inlineTypes: inout [InlineTypeEntry],
        currentParentId: String?
    ) -> ResolvedType {
        switch typeRef {
        case .primitive(let kind, let constraints):
            if kind == .string, let format = constraints.format {
                switch format {
                case "uuid":      return .formattedType(.uuid, constraints: constraints)
                case "date-time": return .formattedType(.dateTime, constraints: constraints)
                case "date":      return .formattedType(.date, constraints: constraints)
                case "time":      return .formattedType(.time, constraints: constraints)
                case "uri":       return .formattedType(.uri, constraints: constraints)
                default:          break
                }
            }
            return .primitive(kind, constraints: constraints)

        case .inlineObject(let fields, let addProps, let embeddedUnion):
            let recordName = pascalCase(name)
            let myId = "\(currentParentId ?? "root").\(recordName)"
            // When resolving as a union variant, this object won't be added to
            // inlineTypes, so its children should be parented directly to the
            // variant-scoped parent ID (currentParentId) rather than myId.
            let childParentId: String? = parentSchemaName != nil ? nil : (asUnionVariant ? currentParentId : myId)
            let resolvedFields = fields.compactMap { field -> ResolvedField? in
                if skipFieldNames.contains(field.name) { return nil }
                let fieldTypeName = pascalCase(field.name)
                let fieldType = resolveType(
                    field.type,
                    name: fieldTypeName,
                    parentSchemaName: parentSchemaName,
                    componentSchemas: componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    parentName: recordName,
                    asUnionVariant: false,
                    inlineTypes: &inlineTypes,
                    currentParentId: childParentId
                )
                return ResolvedField(
                    name: field.name,
                    type: fieldType,
                    required: field.required,
                    description: field.description,
                    defaultValue: field.defaultValue
                )
            }
            let resolvedAddProps = addProps.map {
                resolveType(
                    $0,
                    name: "\(recordName)Value",
                    parentSchemaName: parentSchemaName,
                    componentSchemas: componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    asUnionVariant: false,
                    inlineTypes: &inlineTypes,
                    currentParentId: childParentId
                )
            }
            let resolvedEmbedded = embeddedUnion.map {
                resolveType(
                    $0,
                    name: recordName,
                    parentSchemaName: parentSchemaName,
                    componentSchemas: componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    parentName: recordName,
                    asUnionVariant: true,
                    inlineTypes: &inlineTypes,
                    currentParentId: childParentId
                )
            }
            let record: ResolvedType = .record(
                name: recordName,
                fields: resolvedFields,
                additionalPropertiesType: resolvedAddProps,
                embeddedUnion: resolvedEmbedded
            )
            if !asUnionVariant {
                if parentSchemaName != nil {
                    registerTopLevel(name: recordName, type: record, into: &typeDefinitions, declaredNames: &declaredNames)
                } else {
                    inlineTypes.append(InlineTypeEntry(
                        id: myId,
                        shortName: recordName,
                        type: record,
                        parentId: currentParentId
                    ))
                }
            }
            return record

        case .unionLiteral(let values):
            let enumName = safeTypeName(pascalCase(name), parentName: parentName)
            let resolved: ResolvedType = .enum(name: enumName, values: values)
            if !asUnionVariant {
                if parentSchemaName != nil {
                    registerTopLevel(name: enumName, type: resolved, into: &typeDefinitions, declaredNames: &declaredNames)
                } else {
                    inlineTypes.append(InlineTypeEntry(
                        id: "\(currentParentId ?? "root").\(enumName)",
                        shortName: enumName,
                        type: resolved,
                        parentId: currentParentId
                    ))
                }
            }
            return resolved

        case .arrayType(let elementType, let constraints):
            let inner = resolveType(
                elementType,
                name: singularize(name),
                parentSchemaName: parentSchemaName,
                componentSchemas: componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames,
                inlineTypes: &inlineTypes,
                currentParentId: currentParentId
            )
            return .list(elementType: inner, constraints: constraints)

        case .mapType(let valueType):
            let inner = resolveType(
                valueType,
                name: "\(name)Value",
                parentSchemaName: parentSchemaName,
                componentSchemas: componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames,
                inlineTypes: &inlineTypes,
                currentParentId: currentParentId
            )
            return .map(valueType: inner)

        case .nullable(let inner):
            let innerResolved = resolveType(
                inner,
                name: name,
                parentSchemaName: parentSchemaName,
                componentSchemas: componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames,
                parentName: parentName,
                inlineTypes: &inlineTypes,
                currentParentId: currentParentId
            )
            return .nullable(inner: innerResolved)

        case .union(let members):
            let unionName = pascalCase(name)
            let myId = "\(currentParentId ?? "root").\(unionName)"
            let hasNullMember = members.contains { if case .primitive(kind: .void, _) = $0 { return true }
            return false
            }
            let resolved = resolveUnion(
                members: members,
                unionName: unionName,
                parentSchemaName: parentSchemaName,
                componentSchemas: componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames,
                inlineTypes: &inlineTypes,
                currentParentId: parentSchemaName != nil ? nil : myId
            )
            if !asUnionVariant {
                // Structural dedup: reuse existing union with same shape
                if case .union(_, let variants, let disc) = resolved {
                    let key = structuralKeyOfUnion(variants: variants, discriminator: disc)
                    for existing in typeDefinitions {
                        if case .union(_, let ev, let ed) = existing.type,
                           structuralKeyOfUnion(variants: ev, discriminator: ed) == key {
                            let ref: ResolvedType = .typeReference(name: existing.name)
                            return hasNullMember ? .nullable(inner: ref) : ref
                        }
                    }
                    // Also check inline types for structural dedup
                    for existing in inlineTypes {
                        if case .union(_, let ev, let ed) = existing.type,
                           structuralKeyOfUnion(variants: ev, discriminator: ed) == key,
                           existing.shortName != unionName {
                            let ref: ResolvedType = .typeReference(name: existing.shortName)
                            return hasNullMember ? .nullable(inner: ref) : ref
                        }
                    }
                }
                if parentSchemaName != nil {
                    registerTopLevel(name: unionName, type: resolved, into: &typeDefinitions, declaredNames: &declaredNames)
                } else {
                    inlineTypes.append(InlineTypeEntry(
                        id: myId,
                        shortName: unionName,
                        type: resolved,
                        parentId: currentParentId
                    ))
                }
            }
            return hasNullMember ? .nullable(inner: resolved) : resolved

        case .schemaRef(let refName, _):
            if componentSchemas[refName] != nil {
                return .typeReference(name: refName)
            }
            return .typeReference(name: refName)

        case .transferable(let blocksType, let typeArgs):
            let resolvedArgs = typeArgs.map { arg in
                resolveType(
                    arg,
                    name: "\(name)Message",
                    parentSchemaName: parentSchemaName,
                    componentSchemas: componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    inlineTypes: &inlineTypes,
                    currentParentId: currentParentId
                )
            }
            return .transferable(blocksType: blocksType, typeArgs: resolvedArgs)
        }
    }

    // Overload for component-schema resolution (Step 1) which doesn't track inline nesting
    private func resolveType(
        _ typeRef: TypeRef,
        name: String,
        parentSchemaName: String?,
        componentSchemas: [String: TypeRef],
        typeDefinitions: inout [TypeDefinition],
        declaredNames: inout Set<String>,
        parentName: String? = nil,
        asUnionVariant: Bool = false,
        skipFieldNames: Set<String> = []
    ) -> ResolvedType {
        var noInline: [InlineTypeEntry] = []
        return resolveType(
            typeRef,
            name: name,
            parentSchemaName: parentSchemaName,
            componentSchemas: componentSchemas,
            typeDefinitions: &typeDefinitions,
            declaredNames: &declaredNames,
            parentName: parentName,
            asUnionVariant: asUnionVariant,
            skipFieldNames: skipFieldNames,
            inlineTypes: &noInline,
            currentParentId: nil
        )
    }

    private func registerTopLevel(
        name: String,
        type: ResolvedType,
        into typeDefinitions: inout [TypeDefinition],
        declaredNames: inout Set<String>
    ) {
        guard !declaredNames.contains(name) else { return }
        declaredNames.insert(name)
        typeDefinitions.append(TypeDefinition(name: name, type: type))
    }

    // MARK: - Union Resolution

    private func resolveUnion(
        members: [TypeRef],
        unionName: String,
        parentSchemaName: String?,
        componentSchemas: [String: TypeRef],
        typeDefinitions: inout [TypeDefinition],
        declaredNames: inout Set<String>,
        inlineTypes: inout [InlineTypeEntry],
        currentParentId: String?
    ) -> ResolvedType {
        let discriminator = detectDiscriminator(members: members, componentSchemas: componentSchemas)

        var variants: [UnionVariant] = []
        for (memberIdx, member) in members.enumerated() {
            if case .primitive(.void, _) = member { continue }

            let refName: String?
            if case .schemaRef(let refStr, _) = member { refName = refStr } else { refName = nil }

            let nestedInlineName: String? = {
                if case .schemaRef = member { return nil }
                return "\(unionName)_Variant\(memberIdx)"
            }()

            let resolveName = refName ?? nestedInlineName ?? unionName
            let dropFields: Set<String> = discriminator.map { Set([$0.fieldName]) } ?? []

            // Determine the variant name early so we can build a variant-scoped parent ID.
            // Types found inside variant fields
            // get a parent ID of `"{unionId}:variant:{variantName}"` instead of the
            // union node itself, allowing them to be distributed into the variant's
            // nestedTypes later in buildNode.
            let earlyVariantName: String
            if let ref = refName {
                earlyVariantName = pascalCase(ref)
            } else if let disc = discriminator,
                      case .inlineObject(let fields, _, _) = member,
                      let discField = fields.first(where: { $0.name == disc.fieldName }),
                      case .unionLiteral(let vals) = discField.type,
                      let discVal = vals.first {
                earlyVariantName = variantNameFromDiscriminator(fieldName: disc.fieldName, value: discVal)
            } else {
                earlyVariantName = "\(unionName)_Variant\(memberIdx)"
            }

            // Use a variant-scoped parent ID for inline types found inside this variant's fields
            let variantParentId: String? = currentParentId.map { "\($0):variant:\(earlyVariantName)" }

            let resolvedMember = resolveType(
                member,
                name: resolveName,
                parentSchemaName: parentSchemaName,
                componentSchemas: componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames,
                parentName: unionName,
                asUnionVariant: true,
                skipFieldNames: dropFields,
                inlineTypes: &inlineTypes,
                currentParentId: variantParentId ?? currentParentId
            )

            var discValue: String?
            if let disc = discriminator {
                let memberFields: [Field]?
                switch member {
                case .inlineObject(let fields, _, _):
                    memberFields = fields
                case .schemaRef(let ref, _):
                    if let schema = componentSchemas[ref], case .inlineObject(let fields, _, _) = schema {
                        memberFields = fields
                    } else {
                        memberFields = nil
                    }
                default:
                    memberFields = nil
                }
                if let fields = memberFields,
                   let discField = fields.first(where: { $0.name == disc.fieldName }),
                   case .unionLiteral(let vals) = discField.type, let firstVal = vals.first {
                    discValue = firstVal
                }
            }

            let payloadTypeName: String?
            let variantFields: [ResolvedField]
            let variantAddProps: ResolvedType?
            var variantEmbedded: ResolvedType?
            switch resolvedMember {
            case .record(_, let recordFields, let addProps, let embedded):
                let dropName = discriminator?.fieldName
                variantFields = recordFields.filter { $0.name != dropName }
                payloadTypeName = refName
                variantAddProps = addProps
                variantEmbedded = embedded
            case .nullable(let inner):
                if case .record(_, let recordFields, let addProps, let embedded) = inner {
                    variantFields = recordFields
                    payloadTypeName = refName
                    variantAddProps = addProps
                    variantEmbedded = embedded
                } else {
                    variantFields = []
                    payloadTypeName = refName
                    variantAddProps = nil
                    variantEmbedded = nil
                }
            case .union(let unionRefName, _, _):
                variantFields = []
                payloadTypeName = unionRefName
                variantAddProps = nil
                variantEmbedded = nil
            case .typeReference(let typeName):
                variantFields = []
                payloadTypeName = typeName
                variantAddProps = nil
                variantEmbedded = nil
            case .map, .list, .enum, .primitive, .formattedType, .transferable:
                variantFields = []
                payloadTypeName = nil
                variantAddProps = nil
                variantEmbedded = nil
            }

            let variantBaseName: String
            if let ref = refName {
                variantBaseName = pascalCase(ref)
            } else if let discVal = discValue, let disc = discriminator {
                variantBaseName = variantNameFromDiscriminator(fieldName: disc.fieldName, value: discVal)
            } else {
                variantBaseName = "\(unionName)_Variant\(memberIdx)"
            }

            if let inner = variantEmbedded, case .union(let innerName, let innerVariants, let innerDisc) = inner {
                let innerFieldName = innerDisc?.fieldName.isEmpty == false ? innerDisc!.fieldName : "Variant"
                let suggested = "\(variantBaseName)\(pascalCase(innerFieldName))"
                if innerName != suggested {
                    variantEmbedded = .union(name: suggested, variants: innerVariants, discriminator: innerDisc)
                }
            }

            variants.append(UnionVariant(
                name: variantBaseName,
                fields: variantFields,
                discriminatorValue: discValue,
                payloadTypeName: payloadTypeName,
                additionalPropertiesType: variantAddProps,
                embeddedUnion: variantEmbedded
            ))
        }

        // Disambiguate colliding variant names
        var nameCounts: [String: Int] = [:]
        for variant in variants {
            nameCounts[variant.name, default: 0] += 1
        }
        var seen: [String: Int] = [:]
        variants = variants.map { variant -> UnionVariant in
            guard (nameCounts[variant.name] ?? 0) > 1 else { return variant }
            let count = (seen[variant.name] ?? 0) + 1
            seen[variant.name] = count
            let renamed = "\(variant.name)_\(count)"
            return UnionVariant(
                name: renamed,
                fields: variant.fields,
                discriminatorValue: variant.discriminatorValue,
                payloadTypeName: variant.payloadTypeName,
                additionalPropertiesType: variant.additionalPropertiesType,
                embeddedUnion: variant.embeddedUnion
            )
        }

        return .union(name: unionName, variants: variants, discriminator: discriminator)
    }

    // MARK: - Discriminator Detection

    private func detectDiscriminator(members: [TypeRef], componentSchemas: [String: TypeRef] = [:]) -> DiscriminatorInfo? {
        let objectMembers = members.compactMap { member -> [Field]? in
            if case .inlineObject(let fields, _, _) = member { return fields }
            if case .schemaRef(let refName, _) = member,
               let schema = componentSchemas[refName],
               case .inlineObject(let fields, _, _) = schema { return fields }
            return nil
        }
        guard objectMembers.count >= 2 else { return nil }

        // Find all candidate discriminator fields (present in all members with a single literal value)
        var candidates: [(field: Field, variantMap: [String: String])] = []

        let firstFields = objectMembers[0]
        for field in firstFields {
            guard case .unionLiteral(let vals) = field.type, vals.count == 1 else { continue }

            let allHaveIt = objectMembers.allSatisfy { fields in
                fields.contains { candidate in
                    candidate.name == field.name && {
                        if case .unionLiteral(let values) = candidate.type { return values.count == 1 }
                        return false
                    }()
                }
            }

            if allHaveIt {
                var variantMap: [String: String] = [:]
                for fields in objectMembers {
                    if let matchedField = fields.first(where: { $0.name == field.name }),
                       case .unionLiteral(let values) = matchedField.type,
                       let val = values.first {
                        variantMap[val] = variantNameFromDiscriminator(fieldName: field.name, value: val)
                    }
                }
                candidates.append((field: field, variantMap: variantMap))
            }
        }

        guard !candidates.isEmpty else { return nil }

        // Prefer string discriminators over boolean ones
        let preferred = candidates.first { candidate in
            candidate.variantMap.keys.allSatisfy { $0 != "true" && $0 != "false" }
        } ?? candidates[0]

        return DiscriminatorInfo(fieldName: preferred.field.name, variants: preferred.variantMap)
    }

    // MARK: - Structural Keys

    private func structuralKeyOfUnion(variants: [UnionVariant], discriminator: DiscriminatorInfo?) -> String {
        let discField = discriminator?.fieldName ?? ""
        let sortedVariants = variants.sorted { ($0.discriminatorValue ?? "") < ($1.discriminatorValue ?? "") }
        let parts = sortedVariants.map { variant -> String in
            let sortedFields = variant.fields.sorted { $0.name < $1.name }
            let fieldKeys = sortedFields.map { field in
                "\(field.name):\(typeKey(field.type))\(field.required ? "!" : "")"
            }.joined(separator: ",")
            return "\(variant.discriminatorValue ?? ""){\(fieldKeys)}"
        }
        return "union[\(discField)]{\(parts.joined(separator: "|"))}"
    }

    private func typeKey(_ type: ResolvedType) -> String {
        switch type {
        case .primitive(let kind, _):
            return "\(kind)"
        case .formattedType(let kind, _):
            return "fmt:\(kind)"
        case .record(let name, _, _, _):
            return "ref:\(name)"
        case .enum(let name, _):
            return "ref:\(name)"
        case .list(let elementType, _):
            return "List<\(typeKey(elementType))>"
        case .nullable(let inner):
            return "\(typeKey(inner))?"
        case .union(_, let variants, let disc):
            return structuralKeyOfUnion(variants: variants, discriminator: disc)
        case .typeReference(let name):
            return "ref:\(name)"
        case .transferable(let blocksType, _):
            return "xfer:\(blocksType)"
        case .map(let valueType):
            return "Map<\(typeKey(valueType))>"
        }
    }
}
