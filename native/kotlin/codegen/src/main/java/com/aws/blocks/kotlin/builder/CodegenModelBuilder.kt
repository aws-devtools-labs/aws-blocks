package com.aws.blocks.kotlin.builder

import com.aws.blocks.kotlin.NamingUtils
import com.aws.blocks.kotlin.model.ApiNamespace
import com.aws.blocks.kotlin.model.CodegenModel
import com.aws.blocks.kotlin.model.Constraints
import com.aws.blocks.kotlin.model.DiscriminatorInfo
import com.aws.blocks.kotlin.model.DiscriminatorType
import com.aws.blocks.kotlin.model.Field
import com.aws.blocks.kotlin.model.FormatKind
import com.aws.blocks.kotlin.model.Method
import com.aws.blocks.kotlin.model.NestedTypeNode
import com.aws.blocks.kotlin.model.Operation
import com.aws.blocks.kotlin.model.OperationParameter
import com.aws.blocks.kotlin.model.OperationResult
import com.aws.blocks.kotlin.model.PrimitiveKind
import com.aws.blocks.kotlin.model.ResolvedField
import com.aws.blocks.kotlin.model.ResolvedType
import com.aws.blocks.kotlin.model.RpcModel
import com.aws.blocks.kotlin.model.ServerDefinition
import com.aws.blocks.kotlin.model.TypeDefinition
import com.aws.blocks.kotlin.model.TypeRef
import com.aws.blocks.kotlin.model.UnionVariant

/**
 * Transforms an [RpcModel] into a language-independent [CodegenModel].
 *
 * Centralizes all business logic: API grouping, type resolution,
 * discriminator detection, and naming.
 */
class CodegenModelBuilder {

    fun build(model: RpcModel): CodegenModel {
        val collector = TypeCollector()

        for (method in model.methods) {
            val localName = method.name.substringAfterLast('.')
            val returnType = method.result?.schema ?: TypeRef.Primitive("void")
            val resultName = method.result?.name
            // Use full dotted name as methodKey to avoid collisions across namespaces
            collector.collect(returnType, method.name, "Result", parentSchemaName = null, explicitName = resultName, parentNodeId = null)
            for (param in method.params) {
                collector.collect(param.schema, method.name, toPascalCase(param.name), parentSchemaName = null, parentNodeId = null)
            }
        }

        collector.finalizeDefinitions()
        val apiGroups = groupMethods(model.methods, collector)

        val servers = if (model.servers.isEmpty()) {
            listOf(ServerDefinition("local", "http://localhost:3001"))
        } else {
            model.servers.map { ServerDefinition(it.name, it.url) }
        }

        return CodegenModel(
            apiNamespaces = apiGroups,
            typeDefinitions = collector.typeDefinitions(),
            servers = servers,
            endpoint = model.endpoint,
        )
    }

    // ── Method grouping ──────────────────────────────────────────────

    private fun groupMethods(methods: List<Method>, collector: TypeCollector): List<ApiNamespace> {
        val grouped = LinkedHashMap<String, MutableList<Operation>>()
        for (method in methods) {
            val dotIndex = method.name.indexOf('.')
            val (groupName, localName) = if (dotIndex >= 0) {
                method.name.substring(0, dotIndex) to method.name.substring(dotIndex + 1)
            } else {
                "_default" to method.name
            }

            val parameters = method.params.map { param ->
                OperationParameter(
                    name = param.name,
                    type = resolveType(param.schema, collector),
                    required = param.required,
                    description = param.description,
                )
            }

            val returnType = resolveType(method.result?.schema ?: TypeRef.Primitive("void"), collector, explicitName = method.result?.name)
            val result = OperationResult(
                type = returnType,
                description = method.result?.description
            )

            val nestedTypes = collector.buildNestedTypesForMethod(method.name)

            val operation = Operation(
                name = localName,
                parameters = parameters,
                result = result,
                description = method.description,
                nestedTypes = nestedTypes,
            )

            grouped.getOrPut(groupName) { mutableListOf() }.add(operation)
        }
        return grouped.map { (name, ops) -> ApiNamespace(name = name, operations = ops) }
    }

    // ── Type resolution (used after collection is complete) ───────────

    private fun resolveType(typeRef: TypeRef, collector: TypeCollector, explicitName: String? = null): ResolvedType =
        when (typeRef) {
            is TypeRef.Primitive -> {
                val formatKind = mapFormat(typeRef.constraints.format)
                if (formatKind != null) {
                    ResolvedType.FormattedType(formatKind, typeRef.constraints)
                } else {
                    ResolvedType.Primitive(mapPrimitiveKind(typeRef.tsType), typeRef.constraints)
                }
            }
            is TypeRef.InlineObject -> {
                val name = if (explicitName != null) {
                    collector.nameForRegistrationId("explicit:$explicitName")
                } else {
                    collector.nameForTypeRef(typeRef)
                } ?: ""
                val resolvedAddProps = typeRef.additionalProperties?.let { resolveType(it, collector) }
                ResolvedType.Record(
                    name = name,
                    fields = typeRef.fields.map { resolveField(it, collector) },
                    description = null,
                    additionalPropertiesType = resolvedAddProps,
                )
            }
            is TypeRef.SchemaRef -> ResolvedType.Record(
                name = typeRef.schemaName,
                fields = typeRef.resolved.fields.map { resolveField(it, collector) },
                description = typeRef.description,
            )
            is TypeRef.UnionLiteral -> {
                val name = collector.nameForTypeRef(typeRef) ?: ""
                ResolvedType.Enum(name = name, values = typeRef.values)
            }
            is TypeRef.Union -> {
                val hasNullMember = typeRef.members.any { it is TypeRef.Primitive && it.tsType == "void" }
                val resolved = resolveUnion(typeRef, collector)
                if (hasNullMember) ResolvedType.Nullable(resolved) else resolved
            }
            is TypeRef.ArrayType -> ResolvedType.ListType(resolveType(typeRef.elementType, collector), typeRef.constraints)
            is TypeRef.MapType -> ResolvedType.MapType(resolveType(typeRef.valueType, collector))
            is TypeRef.TupleType -> ResolvedType.TupleType(
                name = explicitName ?: "Tuple",
                elements = typeRef.elements.map { resolveType(it, collector) },
            )
            is TypeRef.Nullable -> ResolvedType.Nullable(resolveType(typeRef.inner, collector))
            is TypeRef.Transferable -> ResolvedType.Transferable(
                transferableName = typeRef.transferableName,
                typeArgs = typeRef.typeArgs.map { resolveType(it, collector) },
            )
            is TypeRef.ObjectWithOneOf -> {
                val name = collector.nameForTypeRef(typeRef) ?: ""
                ResolvedType.Record(
                    name = name,
                    fields = typeRef.fields.map { resolveField(it, collector) },
                    description = null,
                )
            }
        }

    private fun resolveField(field: Field, collector: TypeCollector): ResolvedField {
        val resolved = resolveType(field.type, collector)
        val constraints = when (field.type) {
            is TypeRef.Primitive -> field.type.constraints
            is TypeRef.ArrayType -> field.type.constraints
            else -> Constraints.EMPTY
        }
        return ResolvedField(
            name = field.name,
            type = resolved,
            required = field.required,
            description = field.description,
            constraints = constraints,
            defaultValue = field.defaultValue,
        )
    }

    private fun mapPrimitiveKind(tsType: String): PrimitiveKind =
        when (tsType) {
            "string" -> PrimitiveKind.STRING
            "boolean" -> PrimitiveKind.BOOLEAN
            "integer" -> PrimitiveKind.INTEGER
            "number" -> PrimitiveKind.NUMBER
            "void" -> PrimitiveKind.VOID
            "unknown" -> PrimitiveKind.UNKNOWN
            else -> throw IllegalArgumentException("Unsupported primitive type: $tsType")
        }

    private fun mapFormat(format: String?): FormatKind? = when (format) {
        "date-time" -> FormatKind.DATE_TIME
        "date" -> FormatKind.DATE
        "time" -> FormatKind.TIME
        "uuid" -> FormatKind.UUID
        else -> null
    }

    // ── Union resolution with discriminator detection ─────────────────

    private fun resolveUnion(union: TypeRef.Union, collector: TypeCollector): ResolvedType.Union {
        val name = collector.nameForTypeRef(union) ?: ""
        val discriminator = detectDiscriminator(union)
        // Filter out null/void primitive members — they don't become sealed class variants
        val nonNullMembers = union.members.filter { member ->
            !(member is TypeRef.Primitive && member.tsType == "void")
        }
        val variants = nonNullMembers.mapIndexed { index, member ->
            when (member) {
                is TypeRef.InlineObject -> {
                    val discField = findDiscriminatorField(member)
                    val discValue = if (discField != null) {
                        (discField.type as TypeRef.UnionLiteral).values.first()
                    } else null

                    val variantName = if (discValue != null && discField != null) {
                        variantNameFromDiscriminator(discField.name, discValue)
                    } else {
                        "Variant${index + 1}"
                    }

                    val fields = member.fields
                        .filter { discriminator == null || it.name != discriminator.fieldName }
                        .map { resolveField(it, collector) }

                    val resolvedAddProps = member.additionalProperties?.let { resolveType(it, collector) }

                    UnionVariant(
                        name = variantName,
                        fields = fields,
                        discriminatorValue = discValue,
                        additionalPropertiesType = resolvedAddProps,
                    )
                }
                is TypeRef.ObjectWithOneOf -> {
                    val discField = findDiscriminatorFieldInObjectWithOneOf(member)
                    val discValue = if (discField != null) {
                        (discField.type as TypeRef.UnionLiteral).values.first()
                    } else null

                    val variantName = if (discValue != null && discField != null) {
                        variantNameFromDiscriminator(discField.name, discValue)
                    } else {
                        "Variant${index + 1}"
                    }

                    val fields = member.fields
                        .filter { discriminator == null || it.name != discriminator.fieldName }
                        .map { resolveField(it, collector) }

                    val innerDiscriminator = detectDiscriminatorFromMembers(member.oneOf)
                    val innerDiscFieldName = innerDiscriminator?.fieldName ?: "variant"
                    val innerUnionName = toPascalCase(innerDiscFieldName)
                    val innerVariants = member.oneOf.mapIndexed { innerIndex, innerMember ->
                        when (innerMember) {
                            is TypeRef.InlineObject -> {
                                val innerDiscField = findDiscriminatorField(innerMember)
                                val innerDiscValue = if (innerDiscField != null) {
                                    (innerDiscField.type as TypeRef.UnionLiteral).values.first()
                                } else null

                                val innerVariantName = if (innerDiscValue != null && innerDiscField != null) {
                                    variantNameFromDiscriminator(innerDiscField.name, innerDiscValue)
                                } else {
                                    "Variant${innerIndex + 1}"
                                }

                                val innerFields = innerMember.fields
                                    .filter { innerDiscriminator == null || it.name != innerDiscriminator.fieldName }
                                    .map { resolveField(it, collector) }

                                UnionVariant(name = innerVariantName, fields = innerFields, discriminatorValue = innerDiscValue)
                            }
                            else -> UnionVariant(
                                name = "Variant${innerIndex + 1}",
                                fields = emptyList(),
                                discriminatorValue = null,
                            )
                        }
                    }

                    val embeddedUnion = ResolvedType.Union(
                        name = innerUnionName,
                        variants = innerVariants,
                        discriminator = innerDiscriminator,
                    )

                    UnionVariant(name = variantName, fields = fields, discriminatorValue = discValue, embeddedUnion = embeddedUnion)
                }
                is TypeRef.SchemaRef -> {
                    val discField = findDiscriminatorField(member.resolved)
                    val discValue = if (discField != null) {
                        (discField.type as TypeRef.UnionLiteral).values.first()
                    } else null

                    val variantName = if (discValue != null && discField != null) {
                        variantNameFromDiscriminator(discField.name, discValue)
                    } else {
                        toPascalCase(member.schemaName)
                    }

                    val fields = member.resolved.fields
                        .filter { discriminator == null || it.name != discriminator.fieldName }
                        .map { resolveField(it, collector) }

                    UnionVariant(
                        name = variantName,
                        fields = fields,
                        discriminatorValue = discValue,
                        payloadTypeName = member.schemaName,
                        additionalPropertiesType = member.resolved.additionalProperties?.let { resolveType(it, collector) },
                    )
                }
                else -> UnionVariant(
                    name = "Variant${index + 1}",
                    fields = emptyList(),
                    discriminatorValue = null,
                )
            }
        }

        return ResolvedType.Union(name = name, variants = variants, discriminator = discriminator)
    }

    private fun findDiscriminatorFieldInObjectWithOneOf(obj: TypeRef.ObjectWithOneOf): Field? {
        val candidates = obj.fields.filter { field ->
            field.required && field.type is TypeRef.UnionLiteral &&
                field.type.values.size == 1
        }
        return candidates.find { (it.type as TypeRef.UnionLiteral).values.first() !in listOf("true", "false") }
            ?: candidates.firstOrNull()
    }

    private fun detectDiscriminatorFromMembers(members: List<TypeRef>): DiscriminatorInfo? {
        val variants = mutableMapOf<String, String>()
        var discriminatorFieldName: String? = null

        for (member in members) {
            if (member !is TypeRef.InlineObject) return null
            val disc = findDiscriminatorField(member) ?: return null
            val discValue = (disc.type as TypeRef.UnionLiteral).values.first()
            val variantName = variantNameFromDiscriminator(disc.name, discValue)

            if (discriminatorFieldName == null) {
                discriminatorFieldName = disc.name
            } else if (discriminatorFieldName != disc.name) {
                return null
            }

            variants[discValue] = variantName
        }

        if (discriminatorFieldName == null || variants.isEmpty()) return null
        val type = if (variants.keys.all { it == "true" || it == "false" }) DiscriminatorType.BOOLEAN else DiscriminatorType.STRING
        return DiscriminatorInfo(fieldName = discriminatorFieldName, variants = variants, type = type)
    }

    private fun detectDiscriminator(union: TypeRef.Union): DiscriminatorInfo? {
        val variants = mutableMapOf<String, String>()
        var discriminatorFieldName: String? = null

        for (member in union.members) {
            // Skip null/primitive members — they don't participate in discrimination
            if (member is TypeRef.Primitive || member is TypeRef.Nullable) continue

            val disc = when (member) {
                is TypeRef.InlineObject -> findDiscriminatorField(member)
                is TypeRef.ObjectWithOneOf -> findDiscriminatorFieldInObjectWithOneOf(member)
                is TypeRef.SchemaRef -> findDiscriminatorField(member.resolved)
                else -> return null
            } ?: return null

            val discValue = (disc.type as TypeRef.UnionLiteral).values.first()
            val variantName = variantNameFromDiscriminator(disc.name, discValue)

            if (discriminatorFieldName == null) {
                discriminatorFieldName = disc.name
            } else if (discriminatorFieldName != disc.name) {
                return null
            }

            variants[discValue] = variantName
        }

        if (discriminatorFieldName == null || variants.isEmpty()) return null
        val type = if (variants.keys.all { it == "true" || it == "false" }) DiscriminatorType.BOOLEAN else DiscriminatorType.STRING
        return DiscriminatorInfo(fieldName = discriminatorFieldName, variants = variants, type = type)
    }

    private fun findDiscriminatorField(obj: TypeRef.InlineObject): Field? {
        val candidates = obj.fields.filter { field ->
            field.required && field.type is TypeRef.UnionLiteral &&
                field.type.values.size == 1
        }
        // Prefer string discriminators over boolean ones
        return candidates.find { (it.type as TypeRef.UnionLiteral).values.first() !in listOf("true", "false") }
            ?: candidates.firstOrNull()
    }

    private data class TypeSource<T>(val name: String, val suffix: String, val source: T, val parentSchemaName: String?)

    /**
     * Tracks nesting relationships for inline types within a method.
     * Each entry maps a node ID to its children IDs.
     */
    private data class NestedNodeInfo(
        val id: String,
        val methodName: String,
        val shortName: String,
        val parentNodeId: String?,
    )

    // ── Type collection (no structural deduplication) ──────────────────

    /**
     * Encapsulates mutable state for type collection during a single build pass.
     *
     * Pass 1 ([collect]): Walks the TypeRef tree, registers names for all types.
     * Each type gets its own unique registration with no deduplication.
     *
     * Pass 2 ([finalizeDefinitions]): Resolves all stored TypeRef sources into
     * ResolvedType instances with proper names (since all names are now known).
     * For inline types, builds NestedTypeNode trees per method.
     */
    private inner class TypeCollector {
        private val inlineObjectSources = LinkedHashMap<String, TypeSource<TypeRef.InlineObject>>()
        private val enumSources = LinkedHashMap<String, TypeSource<TypeRef.UnionLiteral>>()
        private val unionSources = LinkedHashMap<String, TypeSource<TypeRef.Union>>()
        private val schemaSources = LinkedHashMap<String, TypeSource<TypeRef.SchemaRef>>()

        /** Finalized definitions after pass 2 (only component schemas) */
        private val definitions = LinkedHashMap<String, TypeDefinition>()

        /** Maps TypeRef identity (System.identityHashCode) to registration ID for lookup during resolution */
        private val typeRefToId = HashMap<Int, String>()

        /** Tracks nesting structure for inline types */
        private val nestedNodeInfos = mutableListOf<NestedNodeInfo>()

        /** Resolved types for inline nodes, populated during finalizeDefinitions */
        private val resolvedInlineTypes = LinkedHashMap<String, ResolvedType>()

        fun typeDefinitions(): List<TypeDefinition> = definitions.values.sortedBy { it.name }

        fun nameForRegistrationId(id: String): String? =
            inlineObjectSources[id]?.let { it.suffix }
                ?: enumSources[id]?.let { it.suffix }
                ?: unionSources[id]?.let { it.suffix }
                ?: schemaSources[id]?.name

        fun nameForTypeRef(typeRef: TypeRef): String? {
            val id = typeRefToId[System.identityHashCode(typeRef)] ?: return null
            return nameForRegistrationId(id)
        }

        /**
         * Build the NestedTypeNode trees for a given method.
         * Called after finalizeDefinitions.
         */
        fun buildNestedTypesForMethod(methodName: String): List<NestedTypeNode> {
            val methodNodes = nestedNodeInfos.filter { it.methodName == methodName }
            // Build a map from parentId -> list of children
            val childrenMap = methodNodes.groupBy { it.parentNodeId }
            // Root nodes are those with parentNodeId == null
            val roots = childrenMap[null] ?: return emptyList()
            return roots.mapNotNull { buildNode(it, childrenMap) }
        }

        private fun buildNode(
            info: NestedNodeInfo,
            childrenMap: Map<String?, List<NestedNodeInfo>>,
        ): NestedTypeNode? {
            val resolvedType = resolvedInlineTypes[info.id] ?: return null

            // Direct children of this node (non-variant-scoped)
            val children = (childrenMap[info.id] ?: emptyList()).mapNotNull { buildNode(it, childrenMap) }

            // For union (sealed class) nodes, distribute variant-scoped children
            // into each variant's nestedTypes.
            val finalType = if (resolvedType is ResolvedType.Union) {
                val variantPrefix = "${info.id}:variant:"
                val variantChildrenMap = childrenMap.entries
                    .filter { (key, _) -> key != null && key.startsWith(variantPrefix) }
                    .associate { (key, nodes) ->
                        val variantName = key!!.removePrefix(variantPrefix)
                        variantName to nodes.mapNotNull { buildNode(it, childrenMap) }
                    }
                if (variantChildrenMap.isNotEmpty()) {
                    val updatedVariants = resolvedType.variants.map { variant ->
                        val variantChildren = variantChildrenMap[variant.name] ?: emptyList()
                        if (variantChildren.isNotEmpty()) variant.copy(nestedTypes = variantChildren)
                        else variant
                    }
                    resolvedType.copy(variants = updatedVariants)
                } else resolvedType
            } else resolvedType

            return NestedTypeNode(
                name = info.shortName,
                type = finalType,
                children = children,
            )
        }

        /**
         * Pass 1: Collect type names without resolving.
         * Each type gets a unique registration — no structural deduplication.
         *
         * @param explicitName If provided (from the spec's result "name" field), this type
         *   gets its own name directly.
         * @param parentNodeId The ID of the parent nested node (null for root-level params/result).
         */
        fun collect(
            typeRef: TypeRef,
            methodName: String,
            suffix: String,
            parentSchemaName: String?,
            explicitName: String? = null,
            parentNodeId: String? = null,
        ) {
            when (typeRef) {
                is TypeRef.InlineObject -> {
                    val id = if (explicitName != null) "explicit:$explicitName"
                             else "inline:${methodName}:${suffix}:${System.identityHashCode(typeRef)}"
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!inlineObjectSources.containsKey(id)) {
                        val name = if (explicitName != null) toPascalCase(explicitName)
                                   else if (parentSchemaName != null) suffix
                                   else toPascalCase(methodName) + suffix
                        inlineObjectSources[id] = TypeSource(name, suffix, typeRef, parentSchemaName)
                        // Track nesting for inline types (not under a schema)
                        if (parentSchemaName == null) {
                            nestedNodeInfos.add(NestedNodeInfo(id, methodName, suffix, parentNodeId))
                        }
                    }
                    // Recurse into fields AFTER registering this type
                    val thisNodeId = if (parentSchemaName == null) id else null
                    for (field in typeRef.fields) {
                        collect(field.type, methodName, toPascalCase(field.name), parentSchemaName, parentNodeId = thisNodeId)
                    }
                    // Recurse into additionalProperties value type
                    if (typeRef.additionalProperties != null) {
                        collect(typeRef.additionalProperties, methodName, suffix + "Value", parentSchemaName, parentNodeId = thisNodeId)
                    }
                }

                is TypeRef.SchemaRef -> {
                    val id = "schema:${typeRef.schemaName}"
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!schemaSources.containsKey(id)) {
                        schemaSources[id] = TypeSource(typeRef.schemaName, typeRef.schemaName, typeRef, null)
                    }
                    // Recurse into resolved fields with schema as parent
                    for (field in typeRef.resolved.fields) {
                        collect(field.type, typeRef.schemaName, toPascalCase(field.name), typeRef.schemaName, parentNodeId = null)
                    }
                }

                is TypeRef.UnionLiteral -> {
                    val id = "enum:${methodName}:${suffix}:${System.identityHashCode(typeRef)}"
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!enumSources.containsKey(id)) {
                        val shortName = suffix
                        val name = if (parentSchemaName != null) suffix
                                   else toPascalCase(methodName) + suffix
                        enumSources[id] = TypeSource(name, shortName, typeRef, parentSchemaName)
                        // Track nesting for inline enums (not under a schema)
                        if (parentSchemaName == null) {
                            nestedNodeInfos.add(NestedNodeInfo(id, methodName, shortName, parentNodeId))
                        }
                    }
                }

                is TypeRef.Union -> {
                    val id = "union:${methodName}:${suffix}:${System.identityHashCode(typeRef)}"
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!unionSources.containsKey(id)) {
                        val shortName = suffix
                        val name = if (parentSchemaName != null) suffix
                                   else toPascalCase(methodName) + suffix
                        unionSources[id] = TypeSource(name, shortName, typeRef, parentSchemaName)
                        // Track nesting for inline unions (not under a schema)
                        if (parentSchemaName == null) {
                            nestedNodeInfos.add(NestedNodeInfo(id, methodName, shortName, parentNodeId))
                        }
                    }
                    // Recurse into union member fields, skipping discriminator fields.
                    // Each variant gets its own synthetic node so field-derived types
                    // nest under the variant class (not as siblings at the sealed level).
                    val thisNodeId = if (parentSchemaName == null) id else null
                    for ((memberIndex, member) in typeRef.members.withIndex()) {
                        if (member is TypeRef.InlineObject) {
                            val discriminator = findDiscriminatorField(member)
                            val discValue = discriminator?.let {
                                (it.type as? TypeRef.UnionLiteral)?.values?.firstOrNull()
                            }
                            val variantName = if (discValue != null && discriminator != null) {
                                variantNameFromDiscriminator(discriminator.name, discValue)
                            } else {
                                "Variant${memberIndex + 1}"
                            }
                            val variantNodeId = if (thisNodeId != null) "${id}:variant:${variantName}" else null

                            for (field in member.fields) {
                                if (discriminator != null && field.name == discriminator.name) continue
                                collect(field.type, methodName, toPascalCase(field.name), parentSchemaName, parentNodeId = variantNodeId ?: thisNodeId)
                            }
                        } else {
                            collect(member, methodName, suffix, parentSchemaName, parentNodeId = thisNodeId)
                        }
                    }
                }

                is TypeRef.ArrayType -> {
                    collect(typeRef.elementType, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                }

                is TypeRef.Nullable -> {
                    collect(typeRef.inner, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                }

                is TypeRef.Primitive -> { /* no type definition to register */ }

                is TypeRef.MapType -> {
                    collect(typeRef.valueType, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                }

                is TypeRef.TupleType -> {
                    for (element in typeRef.elements) {
                        collect(element, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                    }
                }

                is TypeRef.Transferable -> {
                    // Recurse into type args to collect any referenced types
                    for (arg in typeRef.typeArgs) {
                        collect(arg, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                    }
                }

                is TypeRef.ObjectWithOneOf -> {
                    // Recurse into outer fields and inner oneOf members
                    // (the type itself is consumed by its parent union, not registered standalone)
                    val discriminator = findDiscriminatorFieldInObjectWithOneOf(typeRef)
                    for (field in typeRef.fields) {
                        if (discriminator != null && field.name == discriminator.name) continue
                        collect(field.type, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                    }
                    for (member in typeRef.oneOf) {
                        if (member is TypeRef.InlineObject) {
                            val innerDiscriminator = findDiscriminatorField(member)
                            for (field in member.fields) {
                                if (innerDiscriminator != null && field.name == innerDiscriminator.name) continue
                                collect(field.type, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                            }
                        } else {
                            collect(member, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId)
                        }
                    }
                }
            }
        }

        /**
         * Pass 2: Resolve all collected sources into TypeDefinitions (for schemas)
         * and ResolvedTypes (for inline types used in NestedTypeNode trees).
         * At this point all names are known, so resolveType can look them up.
         */
        fun finalizeDefinitions() {
            // Schema types go into flat typeDefinitions
            for ((key, src) in schemaSources) {
                val resolvedFields = src.source.resolved.fields.map { resolveField(it, this) }
                val resolvedAddProps = src.source.resolved.additionalProperties?.let { resolveType(it, this) }
                definitions[key] = TypeDefinition(
                    name = src.name,
                    type = ResolvedType.Record(name = src.name, fields = resolvedFields, description = src.source.description, additionalPropertiesType = resolvedAddProps),
                    shortName = src.suffix,
                    parentSchema = src.parentSchemaName,
                )
            }
            // Inline objects: schema-parented go to definitions, method-parented go to resolvedInlineTypes
            for ((key, src) in inlineObjectSources) {
                val resolvedFields = src.source.fields.map { resolveField(it, this) }
                val resolvedAddProps = src.source.additionalProperties?.let { resolveType(it, this) }
                if (src.parentSchemaName != null) {
                    definitions[key] = TypeDefinition(
                        name = src.name,
                        type = ResolvedType.Record(name = src.name, fields = resolvedFields, description = null, additionalPropertiesType = resolvedAddProps),
                        shortName = src.suffix,
                        parentSchema = src.parentSchemaName,
                    )
                } else {
                    resolvedInlineTypes[key] = ResolvedType.Record(
                        name = src.suffix,
                        fields = resolvedFields,
                        description = null,
                        additionalPropertiesType = resolvedAddProps,
                    )
                }
            }
            // Enums: schema-parented go to definitions, method-parented go to resolvedInlineTypes
            for ((key, src) in enumSources) {
                if (src.parentSchemaName != null) {
                    definitions[key] = TypeDefinition(
                        name = src.name,
                        type = ResolvedType.Enum(name = src.name, values = src.source.values),
                        shortName = src.suffix,
                        parentSchema = src.parentSchemaName,
                    )
                } else {
                    resolvedInlineTypes[key] = ResolvedType.Enum(name = src.suffix, values = src.source.values)
                }
            }
            // Unions: schema-parented go to definitions, method-parented go to resolvedInlineTypes
            for ((key, src) in unionSources) {
                val resolved = resolveUnion(src.source, this)
                if (src.parentSchemaName != null) {
                    definitions[key] = TypeDefinition(
                        name = src.name,
                        type = resolved.copy(name = src.name),
                        shortName = src.suffix,
                        parentSchema = src.parentSchemaName,
                    )
                } else {
                    resolvedInlineTypes[key] = resolved.copy(name = src.suffix)
                }
            }
        }
    }

    // ── Naming utilities ─────────────────────────────────────────────

    companion object {
        fun toPascalCase(name: String): String = NamingUtils.toPascalCase(name)

        fun variantNameFromDiscriminator(fieldName: String, value: String): String {
            return if (value == "true" || value == "false") {
                toPascalCase(fieldName) + toPascalCase(value)
            } else {
                toPascalCase(value)
            }
        }
    }
}
