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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull

/**
 * Transforms an [RpcModel] into a language-independent [CodegenModel].
 *
 * Centralizes all business logic: API grouping, type resolution,
 * discriminator detection, and naming.
 */
class CodegenModelBuilder {

    fun build(model: RpcModel): CodegenModel {
        val collector = TypeCollector(schemaTypeNames(model))

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

    /**
     * The Kotlin class name of each component schema: its spec name, unless Kotlin can't declare
     * that (`my.doc` -> `myDoc`, see [NamingUtils.memberName]) or it is `Servers`, the generated
     * servers object. A changed name never takes another schema's ( `_2`, `_3`, …). A schema's
     * name is never on the wire.
     */
    private fun schemaTypeNames(model: RpcModel): Map<String, String> {
        val names = (model.components?.get("schemas") as? JsonObject)?.keys?.toList().orEmpty()
        return names.zip(NamingUtils.allocate(names, reserved = setOf(SERVERS_OBJECT), candidate = NamingUtils::memberName)).toMap()
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
                rpcMethod = method.name,
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
            // A result the spec names is registered per method (`explicit:<method>:<name>`), so it
            // too resolves by the registration of this very TypeRef.
            is TypeRef.InlineObject -> {
                val name = collector.nameForTypeRef(typeRef) ?: ""
                val resolvedAddProps = typeRef.additionalProperties?.let { resolveType(it, collector) }
                ResolvedType.Record(
                    name = name,
                    fields = typeRef.fields.map { resolveField(it, collector) },
                    description = null,
                    additionalPropertiesType = resolvedAddProps,
                )
            }
            // Carries the schema's additionalProperties type, as its definition does, so a walk over
            // a use of it (the generator's OIDC detection) sees what its `attributes` map holds.
            is TypeRef.SchemaRef -> ResolvedType.Record(
                name = collector.schemaTypeName(typeRef.schemaName),
                fields = typeRef.resolved.fields.map { resolveField(it, collector) },
                description = typeRef.description,
                additionalPropertiesType = typeRef.resolved.additionalProperties?.let { resolveType(it, collector) },
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
        val variantNames = variantNames(union.members)
        val variants = nonNullMembers.mapIndexed { index, member ->
            val variantName = variantNames[index]
            when (member) {
                is TypeRef.InlineObject -> {
                    val discField = findDiscriminatorField(member)
                    val discValue = if (discField != null) {
                        (discField.type as TypeRef.UnionLiteral).values.first()
                    } else null

                    val fields = member.fields
                        .filter { discriminator == null || it.name != discriminator.fieldName }
                        .map { resolveField(it, collector) }

                    val resolvedAddProps = member.additionalProperties?.let { resolveType(it, collector) }

                    UnionVariant(
                        name = variantName,
                        fields = fields,
                        discriminatorValue = discValue,
                        additionalPropertiesType = resolvedAddProps,
                        discriminatorLiteral = discField?.let(::literalOf),
                    )
                }
                is TypeRef.ObjectWithOneOf -> {
                    val discField = findDiscriminatorFieldInObjectWithOneOf(member)
                    val discValue = if (discField != null) {
                        (discField.type as TypeRef.UnionLiteral).values.first()
                    } else null

                    val fields = member.fields
                        .filter { discriminator == null || it.name != discriminator.fieldName }
                        .map { resolveField(it, collector) }

                    val innerDiscriminator = detectDiscriminatorFromMembers(member.oneOf)
                    val innerDiscFieldName = innerDiscriminator?.fieldName ?: "variant"
                    val innerUnionName = toPascalCase(innerDiscFieldName)
                    val innerVariantNames = variantNames(member.oneOf)
                    val innerVariants = member.oneOf.mapIndexed { innerIndex, innerMember ->
                        when (innerMember) {
                            is TypeRef.InlineObject -> {
                                val innerDiscField = findDiscriminatorField(innerMember)
                                val innerDiscValue = if (innerDiscField != null) {
                                    (innerDiscField.type as TypeRef.UnionLiteral).values.first()
                                } else null

                                val innerVariantName = innerVariantNames[innerIndex]

                                val innerFields = innerMember.fields
                                    .filter { innerDiscriminator == null || it.name != innerDiscriminator.fieldName }
                                    .map { resolveField(it, collector) }

                                UnionVariant(
                                    name = innerVariantName,
                                    fields = innerFields,
                                    discriminatorValue = innerDiscValue,
                                    discriminatorLiteral = innerDiscField?.let(::literalOf),
                                )
                            }
                            else -> UnionVariant(
                                name = innerVariantNames[innerIndex],
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

                    UnionVariant(
                        name = variantName,
                        fields = fields,
                        discriminatorValue = discValue,
                        embeddedUnion = embeddedUnion,
                        discriminatorLiteral = discField?.let(::literalOf),
                    )
                }
                is TypeRef.SchemaRef -> {
                    val discField = findDiscriminatorField(member.resolved)
                    val discValue = if (discField != null) {
                        (discField.type as TypeRef.UnionLiteral).values.first()
                    } else null

                    val fields = member.resolved.fields
                        .filter { discriminator == null || it.name != discriminator.fieldName }
                        .map { resolveField(it, collector) }

                    UnionVariant(
                        name = variantName,
                        fields = fields,
                        discriminatorValue = discValue,
                        payloadTypeName = collector.schemaTypeName(member.schemaName),
                        additionalPropertiesType = member.resolved.additionalProperties?.let { resolveType(it, collector) },
                        discriminatorLiteral = discField?.let(::literalOf),
                    )
                }
                // A `const` or `enum` arm: matched by its exact JSON literals.
                is TypeRef.UnionLiteral -> UnionVariant(
                    name = variantName,
                    fields = emptyList(),
                    literal = member.literals,
                )
                // A value arm: the bare JSON value. A nested union or tuple arm has no type of its
                // own here, so it keeps its value as a `JsonElement` (`unknown`) rather than losing it.
                else -> UnionVariant(
                    name = variantName,
                    fields = emptyList(),
                    valueType = when (member) {
                        is TypeRef.Union, is TypeRef.TupleType -> ResolvedType.Primitive(PrimitiveKind.UNKNOWN)
                        else -> resolveType(member, collector)
                    },
                )
            }
        }

        return ResolvedType.Union(name = name, variants = variants, discriminator = discriminator)
    }

    /**
     * The class names of [members]' variants, in order, leaving out a `null` member (it makes the
     * union nullable, not a variant): a discriminated object arm is named after its discriminator
     * value, a `${'$'}ref` arm after its schema, any other arm `Variant<n>`. They are nested classes of
     * one sealed class, so a later name that a sibling already took (discriminator values
     * `in-progress` and `in_progress` are both `InProgress`) gets `_2`, `_3`, …; the `@SerialName`
     * keeps each one's wire value. Collection and resolution both name variants here, so the types
     * a variant's fields declare nest under the right one.
     */
    private fun variantNames(members: List<TypeRef>): List<String> {
        val taken = mutableSetOf<String>()
        return members.filterNot { it is TypeRef.Primitive && it.tsType == "void" }.mapIndexed { index, member ->
            val discField = when (member) {
                is TypeRef.InlineObject -> findDiscriminatorField(member)
                is TypeRef.ObjectWithOneOf -> findDiscriminatorFieldInObjectWithOneOf(member)
                is TypeRef.SchemaRef -> findDiscriminatorField(member.resolved)
                else -> null
            }
            val candidate = when {
                discField != null -> variantNameFromDiscriminator(discField.name, (discField.type as TypeRef.UnionLiteral).values.first())
                member is TypeRef.SchemaRef -> toPascalCase(member.schemaName)
                else -> "Variant${index + 1}"
            }
            NamingUtils.claim(candidate, taken)
        }
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
        val literals = mutableListOf<JsonPrimitive>()
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
            literals.add(literalOf(disc))
        }

        if (discriminatorFieldName == null || variants.isEmpty()) return null
        return DiscriminatorInfo(fieldName = discriminatorFieldName, variants = variants, type = discriminatorType(literals))
    }

    private fun detectDiscriminator(union: TypeRef.Union): DiscriminatorInfo? {
        val variants = mutableMapOf<String, String>()
        val literals = mutableListOf<JsonPrimitive>()
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
            literals.add(literalOf(disc))
        }

        if (discriminatorFieldName == null || variants.isEmpty()) return null
        return DiscriminatorInfo(fieldName = discriminatorFieldName, variants = variants, type = discriminatorType(literals))
    }

    /** The JSON literal of a discriminator field (a single-value `const` or `enum`). */
    private fun literalOf(field: Field): JsonPrimitive = (field.type as TypeRef.UnionLiteral).literals.first()

    /** STRING when every discriminator value is a JSON string, BOOLEAN when every one is a boolean. */
    private fun discriminatorType(literals: List<JsonPrimitive>): DiscriminatorType = when {
        literals.all { it.isString } -> DiscriminatorType.STRING
        literals.all { !it.isString && it.booleanOrNull != null } -> DiscriminatorType.BOOLEAN
        else -> DiscriminatorType.OTHER
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

    /**
     * A collected type. For a type that lives under a component schema, [parentSchemaName] is the
     * dotted path of the type that encloses it (`Holder`, or `Holder.Payload` for a type inside the
     * inline object `Holder.payload`) and [name] is its own dotted path (`Holder.Payload.Meta`),
     * which is unique across the model.
     */
    private data class TypeSource<T>(val name: String, val suffix: String, val source: T, val parentSchemaName: String?) {
        /** The name a reference to this type resolves by: the unique path under a schema, else the short name. */
        val referenceName: String get() = if (parentSchemaName != null) name else suffix
    }

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
    private inner class TypeCollector(private val schemaTypeNames: Map<String, String>) {
        private val inlineObjectSources = LinkedHashMap<String, TypeSource<TypeRef.InlineObject>>()
        private val enumSources = LinkedHashMap<String, TypeSource<TypeRef.UnionLiteral>>()
        private val unionSources = LinkedHashMap<String, TypeSource<TypeRef.Union>>()
        private val schemaSources = LinkedHashMap<String, TypeSource<TypeRef.SchemaRef>>()
        /** Enums reached through a `${'$'}ref`: one top-level enum per component schema. */
        private val schemaEnumSources = LinkedHashMap<String, TypeSource<TypeRef.UnionLiteral>>()

        /** Finalized definitions after pass 2 (only component schemas) */
        private val definitions = LinkedHashMap<String, TypeDefinition>()

        /** Maps TypeRef identity (System.identityHashCode) to registration ID for lookup during resolution */
        private val typeRefToId = HashMap<Int, String>()

        /** Tracks nesting structure for inline types */
        private val nestedNodeInfos = mutableListOf<NestedNodeInfo>()

        /** Resolved types for inline nodes, populated during finalizeDefinitions */
        private val resolvedInlineTypes = LinkedHashMap<String, ResolvedType>()

        /** The nested type names taken in each scope: see [allocateNestedName]. */
        private val takenNestedNames = HashMap<Pair<String, String?>, MutableSet<String>>()

        /** The Kotlin class name of the component schema [schemaName] (see [schemaTypeNames]). */
        fun schemaTypeName(schemaName: String): String =
            schemaTypeNames[schemaName] ?: NamingUtils.memberName(schemaName)

        /** The scope of the types declared under a component schema's type at [path] (`Holder.Payload`). */
        private fun schemaScope(path: String): Pair<String, String?> = "schema:$path" to null

        /** The names taken in [scope]. Every class nested in a `@Serializable` class has `Companion` taken. */
        private fun takenNames(scope: Pair<String, String?>): MutableSet<String> =
            takenNestedNames.getOrPut(scope) {
                // An operation's root is an `object`, which has no companion; everything else
                // nests in a `@Serializable` class, whose companion the serialization plugin declares.
                val operationRoot = scope.second == null && !scope.first.startsWith("schema:")
                if (operationRoot) mutableSetOf() else mutableSetOf(SERIALIZABLE_COMPANION)
            }

        /**
         * The name of an inline type declared in [scope]: an operation's root (its parameters
         * and result, `(<method>, null)`), an inline object or a union variant of an operation
         * (`(<method>, <node id>)`), or a component schema's type ([schemaScope]). Those types are
         * nested classes of one scope, so two of a name don't compile. The first declaration keeps
         * [candidate]; an operation's result is collected before its parameters, so it keeps
         * `Result`. A later sibling of the same name (a parameter named `result`, properties
         * `user_name` and `userName`, an enum `kind` beside an object `Kind`) gets `_2`, `_3`, …, as
         * Swift does, and so does a name the generator declares there ([takenNames]). A name that
         * doesn't collide is unchanged.
         */
        private fun allocateNestedName(scope: Pair<String, String?>, candidate: String): String =
            NamingUtils.claim(candidate, takenNames(scope))

        /** The name of a type declared at [suffix] in an operation's scope, or under the schema type at [parentSchemaName]. */
        private fun allocateNestedName(methodName: String, parentNodeId: String?, parentSchemaName: String?, suffix: String): String =
            if (parentSchemaName != null) allocateNestedName(schemaScope(parentSchemaName), suffix)
            else allocateNestedName(methodName to parentNodeId, suffix)

        /**
         * Takes, in [scope], the names of the serializer and fields class the generator nests in an
         * open record with [fields] (`KotlinCodeGenerator.generateDataClass`), so its other nested
         * types don't take them.
         */
        private fun reserveOpenRecordNames(scope: Pair<String, String?>, fields: List<Field>) {
            val properties = NamingUtils.allocate(fields.map { it.name }, candidate = NamingUtils::memberName)
            takenNames(scope).addAll(NamingUtils.nestedTypeNamesBeside(properties, OPEN_RECORD_NESTED_TYPES))
        }

        /**
         * Takes, in [scope], the Kotlin names of the properties of the class that encloses it:
         * Kotlin rejects a nested class named like a property of its class ("Conflicting
         * declarations"), so a property `Meta` holding an inline object declares `Meta_2`. The
         * names are the generator's (`KotlinCodeGenerator.propertyNames`).
         */
        private fun reservePropertyNames(scope: Pair<String, String?>, fields: List<Field>) {
            takenNames(scope).addAll(NamingUtils.allocate(fields.map { it.name }, candidate = NamingUtils::memberName))
        }

        fun typeDefinitions(): List<TypeDefinition> = definitions.values.sortedBy { it.name }

        fun nameForRegistrationId(id: String): String? =
            inlineObjectSources[id]?.referenceName
                ?: enumSources[id]?.referenceName
                ?: unionSources[id]?.referenceName
                ?: schemaSources[id]?.name
                ?: schemaEnumSources[id]?.name

        /**
         * Registration id for a type at [suffix] under [parentSchemaName], or for a method-level type.
         *
         * A type under a schema is keyed by its enclosing type's path and the spec [key] that
         * declares it (the property's name), so the same schema reached through several `$ref`s
         * (each parsed into a fresh [TypeRef] tree) registers its nested types once, same-named
         * properties of different schemas (`Holder.payload`, `Envelope.payload`) stay apart, and so
         * do properties whose PascalCase names are one (`Holder.user_name`, `Holder.userName`).
         *
         * One key can still declare several types: the variants of a union under a schema declare
         * their properties' types in the schema's scope, so two variants' `payload`s share a key. A
         * type shares a registration only with one of the same shape ([shapeOf]); one that differs
         * from every type registered under its key takes the next (`<key>\u00002`, `\u00003`, …),
         * so it is declared and named on its own (`Payload_2`, see [allocateNestedName]).
         */
        private fun registrationId(
            kind: String,
            typeRef: TypeRef,
            methodName: String,
            suffix: String,
            parentSchemaName: String?,
            key: String,
        ): String {
            if (parentSchemaName == null) return "$kind:${methodName}:${suffix}:${System.identityHashCode(typeRef)}"
            val base = "schemaChild:$kind:$parentSchemaName\u0000$key"
            val shape = shapeOf(typeRef)
            var id = base
            var next = 2
            while (true) {
                val registered = registeredSource(id) ?: return id
                if (shapeOf(registered) == shape) return id
                id = "$base\u0000${next++}"
            }
        }

        /** The [TypeRef] an inline object, enum or union was registered from under [id], if any. */
        private fun registeredSource(id: String): TypeRef? =
            inlineObjectSources[id]?.source ?: enumSources[id]?.source ?: unionSources[id]?.source

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
         * @param key The spec name that declares this type under a schema (a property's name), which
         *   keys its registration there (see [registrationId]); a container passes its own on.
         */
        fun collect(
            typeRef: TypeRef,
            methodName: String,
            suffix: String,
            parentSchemaName: String?,
            explicitName: String? = null,
            parentNodeId: String? = null,
            key: String = suffix,
        ) {
            when (typeRef) {
                is TypeRef.InlineObject -> {
                    // A result the spec names is keyed per method: two methods may give theirs one name.
                    val id = if (explicitName != null) "explicit:$methodName:$explicitName"
                             else registrationId("inline", typeRef, methodName, suffix, parentSchemaName, key)
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!inlineObjectSources.containsKey(id)) {
                        val shortName = allocateNestedName(methodName, parentNodeId, parentSchemaName, suffix)
                        val name = if (explicitName != null) toPascalCase(explicitName)
                                   else if (parentSchemaName != null) "$parentSchemaName.$shortName"
                                   else toPascalCase(methodName) + shortName
                        inlineObjectSources[id] = TypeSource(name, shortName, typeRef, parentSchemaName)
                        // Track nesting for inline types (not under a schema)
                        if (parentSchemaName == null) {
                            nestedNodeInfos.add(NestedNodeInfo(id, methodName, shortName, parentNodeId))
                        }
                    }
                    // Recurse into fields AFTER registering this type. Under a schema, this object
                    // encloses the types its fields declare (`Holder.Payload.Meta`), mirroring how
                    // method-level inline objects nest their children.
                    val thisNodeId = if (parentSchemaName == null) id else null
                    val childParentSchema = if (parentSchemaName != null) inlineObjectSources.getValue(id).name else null
                    val childScope = if (childParentSchema != null) schemaScope(childParentSchema) else methodName to thisNodeId
                    reservePropertyNames(childScope, typeRef.fields)
                    if (typeRef.additionalProperties != null) reserveOpenRecordNames(childScope, typeRef.fields)
                    for (field in typeRef.fields) {
                        collect(field.type, methodName, toPascalCase(field.name), childParentSchema, parentNodeId = thisNodeId, key = field.name)
                    }
                    // Recurse into additionalProperties value type
                    if (typeRef.additionalProperties != null) {
                        collect(
                            typeRef.additionalProperties,
                            methodName,
                            suffix + "Value",
                            childParentSchema,
                            parentNodeId = thisNodeId,
                            key = ADDITIONAL_PROPERTIES_KEY,
                        )
                    }
                }

                is TypeRef.SchemaRef -> {
                    val id = "schema:${typeRef.schemaName}"
                    val typeName = schemaTypeName(typeRef.schemaName)
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!schemaSources.containsKey(id)) {
                        schemaSources[id] = TypeSource(typeName, typeName, typeRef, null)
                    }
                    reservePropertyNames(schemaScope(typeName), typeRef.resolved.fields)
                    if (typeRef.resolved.additionalProperties != null) reserveOpenRecordNames(schemaScope(typeName), typeRef.resolved.fields)
                    // Recurse into resolved fields with schema as parent
                    for (field in typeRef.resolved.fields) {
                        collect(field.type, typeName, toPascalCase(field.name), typeName, parentNodeId = null, key = field.name)
                    }
                }

                is TypeRef.UnionLiteral -> {
                    if (typeRef.schemaName != null) {
                        val id = "schemaEnum:${typeRef.schemaName}"
                        val typeName = schemaTypeName(typeRef.schemaName)
                        typeRefToId[System.identityHashCode(typeRef)] = id
                        schemaEnumSources.getOrPut(id) {
                            TypeSource(typeName, typeName, typeRef, parentSchemaName = null)
                        }
                        return
                    }
                    val id = registrationId("enum", typeRef, methodName, suffix, parentSchemaName, key)
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!enumSources.containsKey(id)) {
                        val shortName = allocateNestedName(methodName, parentNodeId, parentSchemaName, suffix)
                        val name = if (parentSchemaName != null) "$parentSchemaName.$shortName"
                                   else toPascalCase(methodName) + shortName
                        enumSources[id] = TypeSource(name, shortName, typeRef, parentSchemaName)
                        // Track nesting for inline enums (not under a schema)
                        if (parentSchemaName == null) {
                            nestedNodeInfos.add(NestedNodeInfo(id, methodName, shortName, parentNodeId))
                        }
                    }
                }

                is TypeRef.Union -> {
                    val id = registrationId("union", typeRef, methodName, suffix, parentSchemaName, key)
                    typeRefToId[System.identityHashCode(typeRef)] = id
                    if (!unionSources.containsKey(id)) {
                        val shortName = allocateNestedName(methodName, parentNodeId, parentSchemaName, suffix)
                        val name = if (parentSchemaName != null) "$parentSchemaName.$shortName"
                                   else toPascalCase(methodName) + shortName
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
                    val members = typeRef.members.filterNot { it is TypeRef.Primitive && it.tsType == "void" }
                    val variantNames = variantNames(typeRef.members)
                    for ((memberIndex, member) in members.withIndex()) {
                        if (member is TypeRef.InlineObject) {
                            val discriminator = findDiscriminatorField(member)
                            val variantNodeId = if (thisNodeId != null) "${id}:variant:${variantNames[memberIndex]}" else null
                            if (variantNodeId != null) {
                                reservePropertyNames(methodName to variantNodeId, member.fields)
                                if (member.additionalProperties != null) reserveOpenRecordNames(methodName to variantNodeId, member.fields)
                            }

                            for (field in member.fields) {
                                if (discriminator != null && field.name == discriminator.name) continue
                                collect(
                                    field.type,
                                    methodName,
                                    toPascalCase(field.name),
                                    parentSchemaName,
                                    parentNodeId = variantNodeId ?: thisNodeId,
                                    key = field.name,
                                )
                            }
                        } else if (member !is TypeRef.UnionLiteral) {
                            // A literal arm declares no enum: the union's serializer matches its
                            // literals (an enum here would be named after the union and shadow it).
                            collect(member, methodName, suffix, parentSchemaName, parentNodeId = thisNodeId, key = key)
                        }
                    }
                }

                is TypeRef.ArrayType -> {
                    collect(typeRef.elementType, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
                }

                is TypeRef.Nullable -> {
                    collect(typeRef.inner, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
                }

                is TypeRef.Primitive -> { /* no type definition to register */ }

                is TypeRef.MapType -> {
                    collect(typeRef.valueType, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
                }

                is TypeRef.TupleType -> {
                    for (element in typeRef.elements) {
                        collect(element, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
                    }
                }

                is TypeRef.Transferable -> {
                    // Recurse into type args to collect any referenced types
                    for (arg in typeRef.typeArgs) {
                        collect(arg, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
                    }
                }

                is TypeRef.ObjectWithOneOf -> {
                    // Recurse into outer fields and inner oneOf members
                    // (the type itself is consumed by its parent union, not registered standalone)
                    val discriminator = findDiscriminatorFieldInObjectWithOneOf(typeRef)
                    for (field in typeRef.fields) {
                        if (discriminator != null && field.name == discriminator.name) continue
                        collect(field.type, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
                    }
                    for (member in typeRef.oneOf) {
                        if (member is TypeRef.InlineObject) {
                            val innerDiscriminator = findDiscriminatorField(member)
                            for (field in member.fields) {
                                if (innerDiscriminator != null && field.name == innerDiscriminator.name) continue
                                collect(field.type, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
                            }
                        } else {
                            collect(member, methodName, suffix, parentSchemaName, parentNodeId = parentNodeId, key = key)
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
            // Enums reached through a `${'$'}ref` are top-level definitions named after their schema
            for ((key, src) in schemaEnumSources) {
                definitions[key] = TypeDefinition(
                    name = src.name,
                    type = ResolvedType.Enum(name = src.name, values = src.source.values),
                    shortName = src.suffix,
                    parentSchema = null,
                )
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
        /**
         * [typeRef] without its descriptions: what two same-named types under one schema key must
         * share to be one type. A description only documents the type (the first one's is kept);
         * names, types, `required`, constraints and defaults all change the generated class.
         */
        private fun shapeOf(typeRef: TypeRef): TypeRef = when (typeRef) {
            is TypeRef.InlineObject -> typeRef.copy(
                fields = typeRef.fields.map(::shapeOf),
                additionalProperties = typeRef.additionalProperties?.let(::shapeOf),
            )
            is TypeRef.SchemaRef -> typeRef.copy(resolved = shapeOf(typeRef.resolved) as TypeRef.InlineObject, description = null)
            is TypeRef.ArrayType -> typeRef.copy(elementType = shapeOf(typeRef.elementType))
            is TypeRef.MapType -> typeRef.copy(valueType = shapeOf(typeRef.valueType))
            is TypeRef.TupleType -> typeRef.copy(elements = typeRef.elements.map(::shapeOf))
            is TypeRef.Nullable -> typeRef.copy(inner = shapeOf(typeRef.inner))
            is TypeRef.Union -> typeRef.copy(members = typeRef.members.map(::shapeOf))
            is TypeRef.Transferable -> typeRef.copy(typeArgs = typeRef.typeArgs.map(::shapeOf))
            is TypeRef.ObjectWithOneOf -> typeRef.copy(fields = typeRef.fields.map(::shapeOf), oneOf = typeRef.oneOf.map(::shapeOf))
            is TypeRef.Primitive, is TypeRef.UnionLiteral -> typeRef
        }

        private fun shapeOf(field: Field): Field = field.copy(type = shapeOf(field.type), description = null)

        /** The generated servers object, a top-level name a component schema yields to. */
        private const val SERVERS_OBJECT = "Servers"

        /** The companion object the serialization plugin declares in every `@Serializable` class. */
        private const val SERIALIZABLE_COMPANION = "Companion"

        /** The types the generator nests in an open record (`OpenRecordSerializerGenerator`), in its order. */
        private val OPEN_RECORD_NESTED_TYPES = listOf("OpenRecordSerializer", "OpenRecordFields")

        /** The [TypeCollector.collect] key of an object's `additionalProperties` value type: never a property's name. */
        private const val ADDITIONAL_PROPERTIES_KEY = "\u0000additionalProperties"

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
