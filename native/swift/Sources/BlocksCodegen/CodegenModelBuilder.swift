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
// Models.swift; a component schema's inline-object properties (and the types
// inside them) nest inside the schema's struct by path (`Shipment.Destination.Geo`),
// so two schemas with a same-named inline property get separate types.

public struct CodegenModelBuilder {
    public init() {}

    // MARK: - Nesting Tracker

    private struct InlineTypeEntry {
        let id: String
        let shortName: String
        let type: ResolvedType
        let parentId: String?
    }

    // MARK: - Name Allocation
    //
    // A nested type's name is derived from the property (or parameter) it's declared for: `item: {…}` declares
    // `Item`, and so does `items: [{…}]` (the element type, singularized), as do `feed: channel<{…}>` and
    // `feeds: [channel<{…}>]` (`FeedMessage`). Two siblings that derive one name would declare the same type
    // twice in their scope, so names are allocated per scope: a property whose own type is the inline type
    // keeps its name, and a sibling whose name is derived takes the derivation without singularizing
    // (`Items`, `FeedsMessage`; Kotlin and Dart name these types the same way). If that's taken too, it gets
    // a numeric suffix (`Item_2`). Every name that doesn't collide is unchanged.

    /// Where a nested type's name comes from: the property or parameter it's declared for, and the steps from
    /// there (an array's element, a map's value, a transferable's type argument).
    private struct NameOrigin {
        /// Unique among the claimant's siblings: the property name plus its steps (`items[]`).
        let key: String
        /// The name the claimant takes when its derived name is taken: the same steps, without singularizing.
        let alternate: String

        init(key: String, name: String) {
            self.key = key
            self.alternate = name
        }

        var element: NameOrigin { NameOrigin(key: key + "[]", name: alternate) }
        var mapValue: NameOrigin { NameOrigin(key: key + "{}", name: alternate + "Value") }
        func typeArgument(_ index: Int) -> NameOrigin { NameOrigin(key: key + "<\(index)>", name: alternate + "Message") }
    }

    /// The names declared at the top level of Models.swift. A component schema owns its name. An inline type
    /// registered there (an enum or union directly on a schema's struct) shares a name only with the same type.
    private struct TopLevelNames {
        private var declared: Set<String> = []
        private var inlineTypes: [String: TypeRef] = [:]

        func contains(_ name: String) -> Bool { declared.contains(name) }
        mutating func insert(_ name: String) { declared.insert(name) }

        func inlineType(named name: String) -> TypeRef? { inlineTypes[name] }
        mutating func claim(_ name: String, for typeRef: TypeRef) {
            if inlineTypes[name] == nil { inlineTypes[name] = typeRef }
        }
        mutating func release(_ name: String, for typeRef: TypeRef) {
            if !declared.contains(name), inlineTypes[name] == typeRef { inlineTypes[name] = nil }
        }
    }

    /// Whether `typeRef` declares a type of its own named after its property (an inline object, enum or union).
    private func declaresTypeDirectly(_ typeRef: TypeRef) -> Bool {
        switch typeRef {
        case .inlineObject, .unionLiteral, .union: return true
        case .nullable(let inner): return declaresTypeDirectly(inner)
        default: return false
        }
    }

    /// A sibling that may declare a type: its key (`NameOrigin.key`), its PascalCase name and its type.
    private struct NameClaimant {
        let key: String
        let name: String
        let type: TypeRef
    }

    /// The names a set of siblings declares directly, by owner key. The first claimant of a name keeps it.
    private func directClaims(_ claimants: [NameClaimant]) -> [String: String] {
        var claims: [String: String] = [:]
        for claimant in claimants where declaresTypeDirectly(claimant.type) && claims[claimant.name] == nil {
            claims[claimant.name] = claimant.key
        }
        return claims
    }

    /// The name a nested type is declared under in scope `scope` (its parent's id, nil at an operation's root).
    /// `candidate` is the derived name, `transform` the rule that turns a name into the declared one (the
    /// shadowing prefix, a reserved-name prefix). A name is taken if a sibling claimed it directly
    /// (`siblingClaims`) or a sibling type was already declared under it.
    private func allocateNestedName(
        _ candidate: String,
        origin: NameOrigin?,
        siblingClaims: [String: String],
        scope: String?,
        inlineTypes: [InlineTypeEntry],
        transform: (String) -> String = { $0 }
    ) -> String {
        func isFree(_ name: String) -> Bool {
            for spelling in Set([name, transform(name)]) {
                if let owner = siblingClaims[spelling], owner != origin?.key { return false }
                if inlineTypes.contains(where: { $0.parentId == scope && $0.shortName == spelling }) { return false }
            }
            return true
        }
        if isFree(candidate) { return transform(candidate) }
        if let alternate = origin?.alternate, alternate != candidate, isFree(alternate) { return transform(alternate) }
        var suffix = 2
        while !isFree("\(candidate)_\(suffix)") {
            suffix += 1
        }
        return transform("\(candidate)_\(suffix)")
    }

    /// The name an inline type registered at the top level takes, claimed for it in `names`. It keeps `name`
    /// unless a component schema or another inline type that isn't the same type has it; then it's prefixed
    /// with its schema's name (`Ticket.status` → `TicketStatus`), like a nested type that would shadow one.
    private func allocateTopLevelName(
        _ name: String,
        for typeRef: TypeRef,
        enclosing: String?,
        componentSchemas: [String: TypeRef],
        names: inout TopLevelNames
    ) -> String {
        func fits(_ candidate: String) -> Bool {
            if let component = componentSchemas[candidate] {
                return component == typeRef || component == .nullable(inner: typeRef)
            }
            return names.inlineType(named: candidate).map { $0 == typeRef } ?? true
        }
        var allocated = name
        if !fits(allocated) {
            let prefixed = (enclosing ?? "") + name
            allocated = prefixed
            var suffix = 2
            while !fits(allocated) {
                allocated = "\(prefixed)_\(suffix)"
                suffix += 1
            }
        }
        if componentSchemas[allocated] == nil { names.claim(allocated, for: typeRef) }
        return allocated
    }

    public func build(from rpcModel: RPCModel) -> CodegenModel {
        var typeDefinitions: [TypeDefinition] = []
        var declaredNames = TopLevelNames()

        // Step 1: Resolve component schemas with their declared names.
        // Each schema tracks the inline types nested under it by path.
        for (schemaName, typeRef) in rpcModel.componentSchemas.sorted(by: { $0.key < $1.key }) {
            var schemaInlineTypes: [InlineTypeEntry] = []
            let resolved = resolveType(
                typeRef,
                name: schemaName,
                parentSchemaName: schemaName,
                componentSchemas: rpcModel.componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames,
                inlineTypes: &schemaInlineTypes,
                currentParentId: nil
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

            // The operation's root scope: an inline result keeps `Result`, then each parameter its own name.
            // The result's key can't be a parameter name.
            let resultKey = "#result"
            let rootClaims = directClaims(
                (method.result.map { [NameClaimant(key: resultKey, name: "Result", type: $0.schema)] } ?? [])
                    + method.params.map { NameClaimant(key: $0.name, name: specTypeName($0.name), type: $0.schema) }
            )

            let parameters = method.params.map { param -> OperationParameter in
                let shortName = specTypeName(param.name)
                let resolved = resolveType(
                    param.schema,
                    name: shortName,
                    parentSchemaName: nil,
                    componentSchemas: rpcModel.componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    inlineTypes: &inlineTypes,
                    currentParentId: nil,
                    origin: NameOrigin(key: param.name, name: shortName),
                    siblingClaims: rootClaims
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
                    currentParentId: nil,
                    origin: NameOrigin(key: resultKey, name: resultName),
                    siblingClaims: rootClaims
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

    /// The nested-type tree under the type with id `parentId` (a component schema's top-level type).
    private func nestedTypeNodes(under parentId: String, in entries: [InlineTypeEntry]) -> [NestedTypeNode] {
        entries.filter { $0.parentId == parentId }.map { buildNode($0, allEntries: entries) }
    }

    /// Name for a type nested inside a component schema. Prefixed with its enclosing type's name
    /// when the bare name can't be declared there or would shadow a type the generated code refers
    /// to: a component schema (`Order.address` → `Order.OrderAddress`, keeping `Address` reachable),
    /// a Swift or runtime type (`Holder.date` → `Holder.HolderDate`), or a reserved name (`Type`).
    private func nestedTypeName(_ base: String, enclosingId: String, componentSchemas: [String: TypeRef]) -> String {
        guard reservedTypeNames.contains(base)
                || nestedShadowingTypeNames.contains(base)
                || componentSchemas[base] != nil else { return base }
        // Ids are dotted paths; a union variant's scope is `{unionId}:variant:{VariantName}`.
        let last = enclosingId.split(separator: ".").last.map(String.init) ?? ""
        let enclosing = last.range(of: ":variant:").map { String(last[$0.upperBound...]) } ?? last
        return enclosing + base
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
                        return variant.with(nestedTypes: variantChildren)
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
        declaredNames: inout TopLevelNames,
        parentName: String? = nil,
        asUnionVariant: Bool = false,
        skipFieldNames: Set<String> = [],
        inlineTypes: inout [InlineTypeEntry],
        currentParentId: String?,
        inNestedRecord: Bool = false,
        origin: NameOrigin? = nil,
        siblingClaims: [String: String] = [:]
    ) -> ResolvedType {
        // Within a component schema (`parentSchemaName != nil`), `currentParentId` is the id of the
        // enclosing record, or nil where the old flat registration applies (the schema itself, an
        // embedded union). An inline object that is a record's property nests inside that record.
        // An enum or union nests only inside a nested record (`inNestedRecord`); one directly on a
        // schema-level record stays top-level, as before.
        // `origin` and `siblingClaims` allocate the name of a type this declares in `currentParentId`'s
        // scope (see "Name Allocation"); they pass through arrays, maps, optionals and transferables, which
        // declare their inner type in the same scope.
        let inSchema = parentSchemaName != nil
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
            let nestsInSchema = inSchema && !asUnionVariant && currentParentId != nil
            let registersTopLevel = inSchema && !asUnionVariant && !nestsInSchema
            let recordName: String
            if asUnionVariant {
                // A union variant's payload is declared under the variant's name, not this one.
                recordName = specTypeName(name)
            } else {
                let siblingName = allocateNestedName(
                    specTypeName(name), origin: origin, siblingClaims: siblingClaims,
                    scope: currentParentId, inlineTypes: inlineTypes
                ) { base in
                    nestsInSchema
                        ? nestedTypeName(base, enclosingId: currentParentId ?? "", componentSchemas: componentSchemas)
                        : base
                }
                recordName = registersTopLevel
                    ? allocateTopLevelName(
                        siblingName, for: typeRef, enclosing: parentSchemaName,
                        componentSchemas: componentSchemas, names: &declaredNames
                    )
                    : siblingName
            }
            let myId = "\(currentParentId ?? "root").\(recordName)"
            // When resolving as a union variant, this object won't be added to
            // inlineTypes, so its children should be parented directly to the
            // variant-scoped parent ID (currentParentId) rather than myId.
            let childParentId: String? = asUnionVariant ? currentParentId : myId
            let childrenInNestedRecord = asUnionVariant ? inNestedRecord : nestsInSchema
            let liveFields = fields.filter { !skipFieldNames.contains($0.name) }
            let fieldClaims = directClaims(liveFields.map { NameClaimant(key: $0.name, name: specTypeName($0.name), type: $0.type) })
            let resolvedFields = liveFields.map { field -> ResolvedField in
                let fieldTypeName = specTypeName(field.name)
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
                    currentParentId: childParentId,
                    inNestedRecord: childrenInNestedRecord,
                    origin: NameOrigin(key: field.name, name: fieldTypeName),
                    siblingClaims: fieldClaims
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
                    currentParentId: childParentId,
                    inNestedRecord: childrenInNestedRecord,
                    // The value type is declared among the fields' types.
                    siblingClaims: fieldClaims
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
                    // An embedded union keeps the flat registration within a schema.
                    currentParentId: inSchema ? nil : childParentId
                )
            }
            let record: ResolvedType = .record(
                name: recordName,
                fields: resolvedFields,
                additionalPropertiesType: resolvedAddProps,
                embeddedUnion: resolvedEmbedded
            )
            if !asUnionVariant {
                if nestsInSchema {
                    inlineTypes.append(InlineTypeEntry(id: myId, shortName: recordName, type: record, parentId: currentParentId))
                    return .typeReference(name: recordName)
                } else if inSchema {
                    registerTopLevel(
                        name: recordName, type: record,
                        nestedTypes: nestedTypeNodes(under: myId, in: inlineTypes),
                        into: &typeDefinitions, declaredNames: &declaredNames
                    )
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
            let nestsInSchema = inSchema && !asUnionVariant && inNestedRecord && currentParentId != nil
            let enumName: String
            if asUnionVariant {
                // A union member, not declared on its own.
                enumName = safeTypeName(specTypeName(name), parentName: parentName)
            } else {
                let siblingName = allocateNestedName(
                    specTypeName(name), origin: origin, siblingClaims: siblingClaims,
                    scope: currentParentId, inlineTypes: inlineTypes
                ) { base in
                    nestsInSchema
                        ? nestedTypeName(base, enclosingId: currentParentId ?? "", componentSchemas: componentSchemas)
                        : safeTypeName(base, parentName: parentName)
                }
                enumName = inSchema && !nestsInSchema
                    ? allocateTopLevelName(
                        siblingName, for: typeRef, enclosing: parentSchemaName,
                        componentSchemas: componentSchemas, names: &declaredNames
                    )
                    : siblingName
            }
            let resolved: ResolvedType = .enum(name: enumName, values: values)
            if nestsInSchema {
                inlineTypes.append(InlineTypeEntry(
                    id: "\(currentParentId ?? "root").\(enumName)",
                    shortName: enumName,
                    type: resolved,
                    parentId: currentParentId
                ))
                return .typeReference(name: enumName)
            }
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
                currentParentId: currentParentId,
                inNestedRecord: inNestedRecord,
                origin: origin?.element,
                siblingClaims: siblingClaims
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
                currentParentId: currentParentId,
                inNestedRecord: inNestedRecord,
                origin: origin?.mapValue,
                siblingClaims: siblingClaims
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
                currentParentId: currentParentId,
                inNestedRecord: inNestedRecord,
                origin: origin,
                siblingClaims: siblingClaims
            )
            return .nullable(inner: innerResolved)

        case .union(let members):
            return resolveUnionType(
                members: members,
                name: name,
                parentSchemaName: parentSchemaName,
                componentSchemas: componentSchemas,
                typeDefinitions: &typeDefinitions,
                declaredNames: &declaredNames,
                asUnionVariant: asUnionVariant,
                inlineTypes: &inlineTypes,
                currentParentId: currentParentId,
                inNestedRecord: inNestedRecord,
                origin: origin,
                siblingClaims: siblingClaims
            )

        case .literal(let value):
            // Outside a discriminator or a union arm, a boolean or numeric literal is a value of its type.
            return .primitive(value.kind)

        case .schemaRef(let refName, _):
            return .typeReference(name: refName)

        case .transferable(let blocksType, let typeArgs):
            let resolvedArgs = typeArgs.enumerated().map { index, arg in
                resolveType(
                    arg,
                    name: "\(name)Message",
                    parentSchemaName: parentSchemaName,
                    componentSchemas: componentSchemas,
                    typeDefinitions: &typeDefinitions,
                    declaredNames: &declaredNames,
                    inlineTypes: &inlineTypes,
                    currentParentId: currentParentId,
                    inNestedRecord: inNestedRecord,
                    origin: origin?.typeArgument(index),
                    siblingClaims: siblingClaims
                )
            }
            return .transferable(blocksType: blocksType, typeArgs: resolvedArgs)
        }
    }

    /// The `.union` case of `resolveType`: resolves the members, then deduplicates, nests, or registers the union.
    private func resolveUnionType(
        members: [TypeRef],
        name: String,
        parentSchemaName: String?,
        componentSchemas: [String: TypeRef],
        typeDefinitions: inout [TypeDefinition],
        declaredNames: inout TopLevelNames,
        asUnionVariant: Bool = false,
        inlineTypes: inout [InlineTypeEntry],
        currentParentId: String?,
        inNestedRecord: Bool = false,
        origin: NameOrigin? = nil,
        siblingClaims: [String: String] = [:]
    ) -> ResolvedType {
        let inSchema = parentSchemaName != nil
        let nestsInSchema = inSchema && !asUnionVariant && inNestedRecord && currentParentId != nil
        let registersTopLevel = inSchema && !asUnionVariant && !nestsInSchema
        let unionRef: TypeRef = .union(members: members)
        let unionName: String
        if asUnionVariant {
            // A union member, not declared on its own.
            unionName = specTypeName(name)
        } else {
            let siblingName = allocateNestedName(
                specTypeName(name), origin: origin, siblingClaims: siblingClaims,
                scope: currentParentId, inlineTypes: inlineTypes
            ) { base in
                nestsInSchema
                    ? nestedTypeName(base, enclosingId: currentParentId ?? "", componentSchemas: componentSchemas)
                    : base
            }
            unionName = registersTopLevel
                ? allocateTopLevelName(
                    siblingName, for: unionRef, enclosing: parentSchemaName,
                    componentSchemas: componentSchemas, names: &declaredNames
                )
                : siblingName
        }
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
            // Within a schema, a union that is itself a union member keeps the flat registration.
            currentParentId: inSchema && asUnionVariant ? nil : myId,
            inNestedRecord: nestsInSchema
        )
        // A union whose variants hold nested types refers to them by their short names, which are
        // only unique by path, so it must not be deduplicated against a same-shaped union.
        let holdsNestedTypes = inSchema && inlineTypes.contains { entry in
            entry.parentId.map { $0 == myId || $0.hasPrefix("\(myId):variant:") } ?? false
        }
        if nestsInSchema {
            inlineTypes.append(InlineTypeEntry(id: myId, shortName: unionName, type: resolved, parentId: currentParentId))
            let ref: ResolvedType = .typeReference(name: unionName)
            return hasNullMember ? .nullable(inner: ref) : ref
        }
        if !asUnionVariant {
            // Structural dedup: reuse existing union with same shape
            if !holdsNestedTypes, case .union(_, let variants, let disc) = resolved {
                let key = structuralKeyOfUnion(variants: variants, discriminator: disc)
                for existing in typeDefinitions {
                    if case .union(_, let existingVariants, let existingDisc) = existing.type,
                       structuralKeyOfUnion(variants: existingVariants, discriminator: existingDisc) == key {
                        if registersTopLevel { declaredNames.release(unionName, for: unionRef) }
                        let ref: ResolvedType = .typeReference(name: existing.name)
                        return hasNullMember ? .nullable(inner: ref) : ref
                    }
                }
                // Also check inline types for structural dedup (method-level inline types only)
                for existing in inlineTypes where !inSchema {
                    if case .union(_, let existingVariants, let existingDisc) = existing.type,
                       structuralKeyOfUnion(variants: existingVariants, discriminator: existingDisc) == key,
                       existing.shortName != unionName {
                        let ref: ResolvedType = .typeReference(name: existing.shortName)
                        return hasNullMember ? .nullable(inner: ref) : ref
                    }
                }
            }
            if parentSchemaName != nil {
                // Variants' nested types (`Click.Meta`) are distributed into the variants.
                let node = buildNode(
                    InlineTypeEntry(id: myId, shortName: unionName, type: resolved, parentId: nil),
                    allEntries: inlineTypes
                )
                registerTopLevel(name: unionName, type: node.type, into: &typeDefinitions, declaredNames: &declaredNames)
                return hasNullMember ? .nullable(inner: node.type) : node.type
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
    }

    // Overload for component-schema resolution (Step 1) which doesn't track inline nesting
    private func resolveType(
        _ typeRef: TypeRef,
        name: String,
        parentSchemaName: String?,
        componentSchemas: [String: TypeRef],
        typeDefinitions: inout [TypeDefinition],
        declaredNames: inout TopLevelNames,
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
        nestedTypes: [NestedTypeNode] = [],
        into typeDefinitions: inout [TypeDefinition],
        declaredNames: inout TopLevelNames
    ) {
        guard !declaredNames.contains(name) else { return }
        declaredNames.insert(name)
        typeDefinitions.append(TypeDefinition(name: name, type: type, nestedTypes: nestedTypes))
    }

    // MARK: - Union Resolution

    private func resolveUnion(
        members: [TypeRef],
        unionName: String,
        parentSchemaName: String?,
        componentSchemas: [String: TypeRef],
        typeDefinitions: inout [TypeDefinition],
        declaredNames: inout TopLevelNames,
        inlineTypes: inout [InlineTypeEntry],
        currentParentId: String?,
        inNestedRecord: Bool = false
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
                      let discVal = literalValue(of: discField.type)?.text {
                earlyVariantName = variantNameFromDiscriminator(fieldName: disc.fieldName, value: discVal)
            } else {
                earlyVariantName = "\(unionName)_Variant\(memberIdx)"
            }

            // A one-literal arm (`{"const": "auto"}`, a TypeScript `false`) is a payload-less case that encodes as
            // that value and decodes only from it.
            if let literal = literalValue(of: member) {
                variants.append(UnionVariant(name: earlyVariantName, fields: [], literal: literal))
                continue
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
                currentParentId: variantParentId ?? currentParentId,
                inNestedRecord: inNestedRecord
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
                   let literal = literalValue(of: discField.type) {
                    discValue = literal.text
                }
            }

            let payloadTypeName: String?
            let variantFields: [ResolvedField]
            let variantAddProps: ResolvedType?
            var variantEmbedded: ResolvedType?
            // An arm that isn't an object carries its value (a string, a number, a list…).
            var valueType: ResolvedType?
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
                    if refName == nil, carriesValue(inner) { valueType = resolvedMember }
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
                if carriesValue(resolvedMember) { valueType = resolvedMember }
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
                let suggested = "\(variantBaseName)\(specTypeName(innerFieldName))"
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
                embeddedUnion: variantEmbedded,
                valueType: valueType
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
            return variant.with(name: "\(variant.name)_\(count)")
        }

        return .union(name: unionName, variants: variants, discriminator: discriminator)
    }

    /// Whether a union arm that resolved to `type` carries a value of that type: a primitive other than
    /// `null` (which makes the union optional instead), a formatted string (a `Date`), an array, a map, an enum
    /// of several values (declared beside the union, like a variant's struct) or a transferable (a channel, a
    /// file handle, an OIDC client). A one-literal arm never gets here: it's a payload-less case.
    private func carriesValue(_ type: ResolvedType) -> Bool {
        switch type {
        case .primitive(let kind, _): return kind != .void
        case .formattedType, .list, .map, .enum, .transferable: return true
        case .nullable(let inner): return carriesValue(inner)
        case .record, .union, .typeReference: return false
        }
    }

    /// The literal `typeRef` is, if it's exactly one: a one-value string `enum` or `const`, or a boolean or
    /// numeric literal.
    private func literalValue(of typeRef: TypeRef) -> LiteralValue? {
        switch typeRef {
        case .unionLiteral(let values) where values.count == 1: return .string(values[0])
        case .literal(let value): return value
        default: return nil
        }
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

        // Find all candidate discriminator fields (present in all members with a single literal value of one
        // JSON type: `"a"` / `"b"`, `true` / `false`, `1` / `2`)
        var candidates: [DiscriminatorInfo] = []

        let firstFields = objectMembers[0]
        for field in firstFields {
            guard let first = literalValue(of: field.type) else { continue }

            let literals = objectMembers.map { fields in
                fields.first { $0.name == field.name }.flatMap { literalValue(of: $0.type) }
            }
            guard literals.allSatisfy({ $0?.kind == first.kind }) else { continue }

            var variantMap: [String: String] = [:]
            for literal in literals.compactMap({ $0 }) {
                variantMap[literal.text] = variantNameFromDiscriminator(fieldName: field.name, value: literal.text)
            }
            candidates.append(DiscriminatorInfo(fieldName: field.name, variants: variantMap, kind: first.kind))
        }

        // Prefer string discriminators over boolean (or numeric) ones
        return candidates.first { $0.kind == .string } ?? candidates.first
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
            // A value arm (`string`, `[Int]`) differs from a fieldless object arm and from another value arm, and
            // a literal arm (`"auto"`, `false`) from both.
            let valueKey = variant.valueType.map { "=\(typeKey($0))" }
                ?? variant.literal.map { "==\($0.kind):\($0.text)" } ?? ""
            return "\(variant.discriminatorValue ?? ""){\(fieldKeys)}\(valueKey)"
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
