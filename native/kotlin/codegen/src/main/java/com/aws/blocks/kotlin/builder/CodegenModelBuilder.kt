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
import com.aws.blocks.kotlin.model.TypeArgDirection
import com.aws.blocks.kotlin.model.TypeRef
import com.aws.blocks.kotlin.model.narrowsTypeArg
import com.aws.blocks.kotlin.model.transferableTypeArg
import com.aws.blocks.kotlin.model.UnionVariant

/** Where the local dev server listens, for a spec that declares no server of its own. */
private const val DEFAULT_LOCAL_ORIGIN = "http://localhost:3001"

/** The path a Blocks backend serves RPC on. */
private const val DEFAULT_RPC_PATH = "/aws-blocks/api"

/**
 * What a narrowed type argument resolves to until something names it: it holds the argument's
 * position, and the generator reads an unnamed one as the runtime type's own default there.
 */
private val NARROWED_PLACEHOLDER = ResolvedType.Enum(name = "", values = emptyList())


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
            // The generator appends x-blocks-endpoint to every server URL, so the RPC path is only
            // added here when the spec declares no endpoint of its own. Without it the fallback
            // points at the origin, where the backend serves no RPC.
            val path = if (model.endpoint == null) DEFAULT_RPC_PATH else ""
            listOf(ServerDefinition("local", DEFAULT_LOCAL_ORIGIN + path))
        } else {
            model.servers.map { ServerDefinition(it.name, it.url) }
        }

        return CodegenModel(
            apiNamespaces = apiGroups,
            typeDefinitions = collector.typeDefinitions(),
            servers = servers,
            endpoint = model.endpoint,
            nativeCatalogs = model.nativeCatalogs,
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
            val nestedTypes = collector.buildNestedTypesForMethod(method.name)
            val result = OperationResult(
                type = withNarrowedTypeArgs(returnType, method.result?.schema, nestedTypes),
                description = method.result?.description
            )

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

    // ── Narrowed type arguments ──────────────────────────────────────

    /**
     * Names the values each narrowed ([TypeArgDirection.IN]) type argument of an operation's own
     * result permits, as an enum the generator emits in the operation's object.
     *
     * Only an operation's own result is narrowed: a transferable in any other position doesn't
     * hydrate, so nothing could reference the enum. An argument the spec didn't resolve to string
     * literals keeps the placeholder it resolved to, which the generator reads as the runtime
     * type's own default for that position.
     */
    private fun withNarrowedTypeArgs(
        resolved: ResolvedType,
        schema: TypeRef?,
        nestedTypes: List<NestedTypeNode>,
    ): ResolvedType {
        val transferable = directTransferable(schema) ?: return resolved
        val taken = takenTypeNames(nestedTypes).toMutableSet()
        var narrowed = resolved
        for ((position, arg) in transferable.typeArgs.withIndex()) {
            if (!narrowsTypeArg(transferable.transferableName, position)) continue
            val values = (arg as? TypeRef.UnionLiteral)?.values ?: continue
            val name = narrowedTypeName(
                transferableTypeArg(transferable.transferableName, position).name,
                taken,
            )
            // Two narrowed arguments can't both be the tag's preferred name.
            taken.add(name)
            narrowed = replaceTypeArg(narrowed, position, ResolvedType.Enum(name = name, values = values))
        }
        return narrowed
    }

    /** The transferable an operation returns directly, or inside a nullable. */
    private fun directTransferable(schema: TypeRef?): TypeRef.Transferable? {
        var typeRef = schema
        while (typeRef is TypeRef.Nullable) typeRef = typeRef.inner
        return typeRef as? TypeRef.Transferable
    }

    /** Replaces one type argument, leaving every other position where the spec put it. */
    private fun replaceTypeArg(resolved: ResolvedType, position: Int, typeArg: ResolvedType): ResolvedType =
        when (resolved) {
            is ResolvedType.Nullable -> ResolvedType.Nullable(replaceTypeArg(resolved.inner, position, typeArg))
            is ResolvedType.Transferable -> resolved.copy(
                typeArgs = resolved.typeArgs.mapIndexed { i, existing -> if (i == position) typeArg else existing },
            )
            else -> resolved
        }

    /**
     * The tag's own name for the argument, unless the operation's object already holds a type by
     * that name or reaches one the enum would shadow.
     */
    private fun narrowedTypeName(preferred: String, taken: Set<String>): String {
        if (preferred !in taken) return preferred
        var candidate = "Result$preferred"
        var attempt = 2
        while (candidate in taken) {
            candidate = "Result$preferred$attempt"
            attempt++
        }
        return candidate
    }

    /**
     * The names an operation's object already uses: the types it declares at the top of the
     * object, which a provider enum would sit beside, and every named type they reach, which it
     * would shadow inside the object.
     */
    private fun takenTypeNames(nestedTypes: List<NestedTypeNode>): Set<String> {
        val taken = mutableSetOf<String>()
        fun walk(nodes: List<NestedTypeNode>) {
            for (node in nodes) {
                taken.add(node.name)
                collectNamedTypes(node.type, taken)
                walk(node.children)
            }
        }
        walk(nestedTypes)
        return taken
    }

    private fun collectNamedTypes(type: ResolvedType, into: MutableSet<String>) {
        when (type) {
            // A name already seen stops the walk, so a schema that reaches itself terminates. An
            // inline type can have no name, which says nothing about where the walk has been.
            is ResolvedType.Record -> {
                if (type.name.isNotEmpty() && !into.add(type.name)) return
                type.fields.forEach { collectNamedTypes(it.type, into) }
                type.additionalPropertiesType?.let { collectNamedTypes(it, into) }
            }
            is ResolvedType.Union -> {
                if (type.name.isNotEmpty() && !into.add(type.name)) return
                for (variant in type.variants) {
                    into.add(variant.name)
                    variant.payloadTypeName?.let { into.add(it) }
                    variant.fields.forEach { collectNamedTypes(it.type, into) }
                    variant.additionalPropertiesType?.let { collectNamedTypes(it, into) }
                    variant.embeddedUnion?.let { collectNamedTypes(it, into) }
                    variant.nestedTypes.forEach { collectNamedTypes(it.type, into) }
                }
            }
            is ResolvedType.Enum -> into.add(type.name)
            is ResolvedType.TypeReference -> into.add(type.name)
            is ResolvedType.TupleType -> {
                into.add(type.name)
                type.elements.forEach { collectNamedTypes(it, into) }
            }
            is ResolvedType.ListType -> collectNamedTypes(type.elementType, into)
            is ResolvedType.MapType -> collectNamedTypes(type.valueType, into)
            is ResolvedType.Nullable -> collectNamedTypes(type.inner, into)
            is ResolvedType.Transferable -> type.typeArgs.forEach { collectNamedTypes(it, into) }
            is ResolvedType.Primitive, is ResolvedType.FormattedType -> Unit
        }
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
                // A narrowed argument names values rather than a type to generate, so it resolves
                // to an unnamed placeholder: [withNarrowedTypeArgs] replaces an operation's own
                // with the enum, and the generator reads the rest as the runtime type's default.
                // Dropping it instead would shift every argument after it out of position.
                typeArgs = typeRef.typeArgs.mapIndexed { position, arg ->
                    if (narrowsTypeArg(typeRef.transferableName, position)) NARROWED_PLACEHOLDER
                    else resolveType(arg, collector)
                },
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
                    // Recurse into type args to collect any referenced types. A narrowed argument
                    // names no type of its own, so it collects nothing here.
                    for ((position, arg) in typeRef.typeArgs.withIndex()) {
                        if (narrowsTypeArg(typeRef.transferableName, position)) continue
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
