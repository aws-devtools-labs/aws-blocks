package com.aws.blocks.kotlin.generator

import com.aws.blocks.kotlin.NamingUtils
import com.aws.blocks.kotlin.model.ApiNamespace
import com.aws.blocks.kotlin.model.CodegenModel
import com.aws.blocks.kotlin.model.Constraints
import com.aws.blocks.kotlin.model.DiscriminatorInfo
import com.aws.blocks.kotlin.model.FormatKind
import com.aws.blocks.kotlin.model.NestedTypeNode
import com.aws.blocks.kotlin.model.Operation
import com.aws.blocks.kotlin.model.OperationParameter
import com.aws.blocks.kotlin.model.PrimitiveKind
import com.aws.blocks.kotlin.model.ResolvedField
import com.aws.blocks.kotlin.model.ResolvedType
import com.aws.blocks.kotlin.model.ServerDefinition
import com.aws.blocks.kotlin.model.TypeDefinition
import com.aws.blocks.kotlin.model.UnionVariant
import com.squareup.kotlinpoet.AnnotationSpec
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FileSpec
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.MemberName
import com.squareup.kotlinpoet.ParameterSpec
import com.squareup.kotlinpoet.ParameterizedTypeName
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.TypeName
import com.squareup.kotlinpoet.TypeSpec
import com.squareup.kotlinpoet.asTypeName
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

/**
 * Generates Kotlin source files from a [CodegenModel] using KotlinPoet.
 *
 * This is a thin translation layer: all business logic (type deduplication,
 * API grouping, discriminator detection) lives in the CodegenModelBuilder.
 * This generator owns Kotlin-specific concerns: naming conventions, nesting
 * decisions, KotlinPoet annotations, and file structure.
 */
data class GeneratorResult(
    val files: List<FileSpec>,
    val warnings: List<String>,
)

private data class TransferableBinding(val type: ClassName, val isGeneric: Boolean)

/**
 * The concrete runtime type each known tag maps to; isGeneric wraps the first type argument
 * (RealtimeChannel<T>). The tag set and type resolution derive from this.
 */
private val knownTransferableBindings = mapOf(
    "realtime/channel" to TransferableBinding(ClassNames.realtimeChannel, isGeneric = true),
    "file-bucket/download" to TransferableBinding(ClassNames.fileDownloadHandle, isGeneric = false),
    "file-bucket/upload" to TransferableBinding(ClassNames.fileUploadHandle, isGeneric = false),
    "oidc/client" to TransferableBinding(ClassNames.oidcClient, isGeneric = false),
)

private val knownTransferableTags: Set<String> = knownTransferableBindings.keys

class KotlinCodeGenerator(
    private val packageName: String,
    private val internalVisibility: Boolean = false,
    private val relayTo: String? = null,
    private val relayToRequirement: RelayToRequirement = RelayToRequirement.Required,
) {

    /** Visibility modifier applied to all top-level generated types. */
    private val apiModifiers: List<KModifier> =
        if (internalVisibility) listOf(KModifier.INTERNAL) else emptyList()

    /** Whether OIDC methods must be replaced with a stub that names the missing configuration. */
    private val stubOidc: Boolean
        get() = relayTo == null && relayToRequirement == RelayToRequirement.Required

    private fun TypeSpec.withApiVisibility(): TypeSpec =
        if (apiModifiers.isEmpty()) this
        else toBuilder().addModifiers(apiModifiers).build()
    private val blocksServerClass = ClassNames.blocksServer

    private val instantClass = ClassNames.instant
    private val localDateClass = ClassNames.localDate
    private val localTimeClass = ClassNames.localTime
    private val uuidClass = ClassNames.uuid

    // ── Main entry point ─────────────────────────────────────────────

    fun generate(model: CodegenModel): GeneratorResult {
        val index = buildTypeIndex(model)
        val files = mutableListOf<FileSpec>()
        val warnings = mutableListOf<String>()
        val serializerRegistry = TransferableSerializerRegistry()

        if (relayTo == null &&
            relayToRequirement != RelayToRequirement.NotNeeded &&
            model.hasOidcTransferable()
        ) {
            warnings.add(
                "Your Blocks spec includes OIDC auth, but no relay target is configured. " +
                    "OIDC operations will not be available. To enable OIDC, add to your build.gradle.kts:\n\n" +
                    "  awsBlocks {\n" +
                    "      oidc {\n" +
                    "          relayTo = \"com.yourcompany.yourapp://auth/callback\"\n" +
                    "      }\n" +
                    "  }"
            )
        }

        // Emit shared Types.kt
        val typesFile = generateTypesFile(index, serializerRegistry)
        if (typesFile != null) files.add(typesFile)

        // Generate API files before serializers so annotations register every serializer they use.
        val apiClassNames = apiClassNames(model)
        val serverProperties = serverPropertyNames(model.servers)
        val apiFiles = model.apiNamespaces.mapIndexed { i, group ->
            generateApiGroupFile(group, apiClassNames[i], index, serverProperties.firstOrNull(), model.endpoint, serializerRegistry)
        }

        // Emit Serializers.kt for the transferables referenced by generated annotations.
        if (serializerRegistry.entries.isNotEmpty()) {
            val serializerGenerator = TransferableSerializerGenerator()
            val serializersFile = FileSpec.builder(packageName, "Serializers")
            for (entry in serializerRegistry.entries) {
                serializersFile.addType(serializerGenerator.generateSerializerObject(entry))
            }
            files.add(serializersFile.build())
        }

        // Emit Servers.kt
        if (model.servers.isNotEmpty()) {
            files.add(generateServersFile(model.servers, serverProperties))
        }

        // Emit per-API-group files (interface + impl)
        files.addAll(apiFiles)

        for (namespace in model.apiNamespaces) {
            for (operation in namespace.operations) {
                val result = operation.result.type
                if (isUnboundDirectResult(result)) {
                    warnings.add(
                        formatUnboundTransferable(
                            operation.rpcMethod,
                            result as ResolvedType.Transferable,
                        )
                    )
                }
            }
        }

        return GeneratorResult(files.map { it.withUuidOptIn() }, warnings)
    }

    /**
     * `format: uuid` maps to `kotlin.uuid.Uuid`, which is `@ExperimentalUuidApi`: an opt-in marker at
     * level ERROR, so a file that uses `Uuid` without opting in doesn't compile. Adds the marker to the
     * file's `@file:OptIn`, only in files that use `Uuid`. `OptIn` isn't repeatable, so a file that
     * already opts in (to `ExperimentalSerializationApi`) gets one annotation naming both markers.
     *
     * Opting in here doesn't propagate: customer code that calls a generated method, or reads a
     * generated property, whose signature has a `Uuid` still opts in itself, as it would for any
     * `kotlin.uuid` API.
     */
    private fun FileSpec.withUuidOptIn(): FileSpec {
        if (!usesUuid.containsMatchIn(toString())) return this
        val builder = toBuilder()
        val existing = builder.annotations.indexOfFirst { it.typeName == ClassNames.optIn }
        val markers = if (existing >= 0) builder.annotations.removeAt(existing).members else emptyList()
        val optIn = AnnotationSpec.builder(ClassNames.optIn).useSiteTarget(AnnotationSpec.UseSiteTarget.FILE)
        markers.forEach { optIn.addMember(it) }
        optIn.addMember("%T::class", ClassNames.experimentalUuidApi)
        builder.annotations.add(0, optIn.build())
        return builder.build()
    }

    /**
     * The class (and file) name of each namespace's API class, in [CodegenModel.apiNamespaces]
     * order: the namespace in PascalCase (`_default` -> `Default`). One that a type already has,
     * that names a generated top-level declaration or file ([GENERATED_TOP_LEVEL_NAMES]), or that
     * an earlier namespace took (`a-b` and `a_b` are both `AB`) gets `_2`, `_3`, …, as in Dart,
     * where namespaces yield to types.
     */
    private fun apiClassNames(model: CodegenModel): List<String> {
        val reserved = GENERATED_TOP_LEVEL_NAMES + model.typeDefinitions.filter { it.parentSchema == null }.map { it.name }
        return NamingUtils.allocate(model.apiNamespaces.map { it.name }, reserved, ::toPascalCase)
    }

    /** The `Servers` property of each server: its name in camelCase, distinct (`us-east` and `us_east` are both `usEast`). */
    private fun serverPropertyNames(servers: List<ServerDefinition>): List<String> =
        NamingUtils.allocate(servers.map { it.name }, candidate = ::toCamelCase)

    /** `kotlin.uuid.Uuid` as an import or a qualified reference, but not `kotlin.uuid.ExperimentalUuidApi`. */
    private val usesUuid = Regex("""\b${Regex.escape(uuidClass.canonicalName)}\b""")

    private fun CodegenModel.hasOidcTransferable(): Boolean =
        apiNamespaces.any { ns -> ns.operations.any { containsOidcTransferable(it.result.type) } }

    /**
     * Whether [type] holds an `oidc/client` anywhere: itself, inside a list, map or nullable, in
     * a field or the additional properties of a model or union variant, or in the payload of a
     * realtime channel. Such an operation decodes with `OidcClient.json` (or is stubbed when no
     * relay target is configured), and such a channel decodes its messages with that Json too.
     * Resolved types are trees, so this ends.
     */
    private fun containsOidcTransferable(type: ResolvedType): Boolean = when (type) {
        is ResolvedType.Transferable ->
            type.transferableName == "oidc/client" || type.typeArgs.any { containsOidcTransferable(it) }
        is ResolvedType.Nullable -> containsOidcTransferable(type.inner)
        is ResolvedType.ListType -> containsOidcTransferable(type.elementType)
        is ResolvedType.MapType -> containsOidcTransferable(type.valueType)
        is ResolvedType.TupleType -> type.elements.any { containsOidcTransferable(it) }
        is ResolvedType.Record -> type.fields.any { containsOidcTransferable(it.type) } ||
            type.additionalPropertiesType?.let { containsOidcTransferable(it) } == true
        is ResolvedType.Union -> type.variants.any { variant ->
            variant.fields.any { containsOidcTransferable(it.type) } ||
                variant.additionalPropertiesType?.let { containsOidcTransferable(it) } == true ||
                variant.embeddedUnion?.let { containsOidcTransferable(it) } == true ||
                variant.valueType?.let { containsOidcTransferable(it) } == true
        }
        else -> false
    }

    // ── Type index ───────────────────────────────────────────────────

    /**
     * Builds a lookup index from the CodegenModel's type definitions.
     * Types with a parentSchema are nested under their parent; all others are top-level.
     */
    private fun buildTypeIndex(model: CodegenModel): TypeIndex {
        val index = TypeIndex(packageName)

        for (typeDef in model.typeDefinitions) {
            val className: ClassName
            val shortName: String

            if (typeDef.parentSchema != null) {
                // Schema child: nest under its enclosing type. parentSchema is a dotted path
                // (`Holder`, or `Holder.Payload` for a type inside an inline-object property).
                className = ClassName(packageName, typeDef.parentSchema.split('.') + typeDef.shortName)
                shortName = typeDef.shortName
            } else {
                // Top-level
                className = ClassName(packageName, typeDef.name)
                shortName = typeDef.name
            }

            when (typeDef.type) {
                is ResolvedType.Record -> index.dataClasses[typeDef.name] = TypeEntry(className, shortName, typeDef)
                is ResolvedType.Enum -> index.enumClasses[typeDef.name] = TypeEntry(className, shortName, typeDef)
                is ResolvedType.Union -> {
                    index.sealedClasses[typeDef.name] = TypeEntry(className, shortName, typeDef)
                    if (typeDef.type.discriminator != null) {
                        index.sealedDiscriminators[typeDef.name] = typeDef.type.discriminator
                    }
                }
                else -> {}
            }
        }

        return index
    }

    private data class TypeEntry(
        val className: ClassName,
        val shortName: String,
        val typeDef: TypeDefinition,
    )

    private class TypeIndex(
        val packageName: String,
    ) {
        val dataClasses = LinkedHashMap<String, TypeEntry>()
        val enumClasses = LinkedHashMap<String, TypeEntry>()
        val sealedClasses = LinkedHashMap<String, TypeEntry>()
        val sealedDiscriminators = LinkedHashMap<String, DiscriminatorInfo>()
    }

    // ── Types.kt generation ──────────────────────────────────────────

    private fun generateTypesFile(index: TypeIndex, serializerRegistry: TransferableSerializerRegistry): FileSpec? {
        if (index.dataClasses.isEmpty() && index.enumClasses.isEmpty() && index.sealedClasses.isEmpty()) {
            return null
        }

        val typesBuilder = FileSpec.builder(packageName, "Types")

        val hasDiscriminator = index.sealedDiscriminators.isNotEmpty()
        if (hasDiscriminator) {
            typesBuilder.addAnnotation(
                AnnotationSpec.builder(ClassNames.optIn)
                    .addMember("%T::class", ClassNames.experimentalSerializationApi)
                    .build()
            )
        }

        // Collect schema-child types to nest inside their parent data class
        val schemaNestedTypes = LinkedHashMap<String, MutableList<TypeSpec>>()

        fun routeType(typeDef: TypeDefinition, typeSpec: TypeSpec) {
            if (typeDef.parentSchema != null) {
                schemaNestedTypes.getOrPut(typeDef.parentSchema) { mutableListOf() }.add(typeSpec)
            } else {
                typesBuilder.addType(typeSpec.withApiVisibility())
            }
        }

        // Route enum and sealed classes first (they may be schema children)
        for ((_, entry) in index.enumClasses) {
            val enumType = entry.typeDef.type as ResolvedType.Enum
            val spec = generateEnumClass(entry.shortName, enumType.values)
            routeType(entry.typeDef, spec)
        }
        for ((_, entry) in index.sealedClasses) {
            val unionType = entry.typeDef.type as ResolvedType.Union
            val spec = generateSealedClass(entry.shortName, unionType, index, serializerRegistry = serializerRegistry)
            routeType(entry.typeDef, spec)
        }

        // Emit data classes, injecting schema-child types as nested types. Innermost first, so each
        // nested data class (`Holder.Payload.Meta`, then `Holder.Payload`) is attached to its
        // enclosing type before that type is built; top-level order is unchanged.
        val dataClassesInnermostFirst = index.dataClasses.values
            .sortedByDescending { entry -> entry.typeDef.parentSchema?.let { it.count { c -> c == '.' } + 1 } ?: 0 }
        for (entry in dataClassesInnermostFirst) {
            val recordType = entry.typeDef.type as ResolvedType.Record
            var spec = generateDataClass(entry.shortName, recordType, index, serializerRegistry = serializerRegistry)

            val nestedTypes = schemaNestedTypes[entry.typeDef.name]
            if (nestedTypes != null) {
                spec = spec.toBuilder().apply {
                    for (nested in nestedTypes) {
                        addType(nested)
                    }
                }.build()
            }

            if (entry.typeDef.parentSchema != null) {
                schemaNestedTypes.getOrPut(entry.typeDef.parentSchema) { mutableListOf() }.add(spec)
            } else {
                typesBuilder.addType(spec.withApiVisibility())
            }
        }

        return typesBuilder.build()
    }

    // ── Data class generation ─────────────────────────────────────────

    private fun generateDataClass(
        name: String,
        record: ResolvedType.Record,
        index: TypeIndex,
        opContext: OperationTypeContext? = null,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext? = opContext,
    ): TypeSpec {
        val constructor = FunSpec.constructorBuilder()
        val isOpenRecord = record.additionalPropertiesType != null
        val names = propertyNames(record.fields)
        val extrasProperty = NamingUtils.claim(OpenRecordSerializerGenerator.EXTRAS_PROPERTY, names.toMutableSet())
        val (openRecordSerializer, openRecordFields) = OpenRecordSerializerGenerator.nestedTypeNames(names)
        val classBuilder = TypeSpec
            .classBuilder(name)
            .addModifiers(KModifier.DATA)
            .addAnnotation(
                if (isOpenRecord) OpenRecordSerializerGenerator.serializableAnnotation(name, openRecordSerializer)
                else AnnotationSpec.builder(ClassNames.serializable).build(),
            )

        val kdoc = buildDataClassKdoc(record.description, record.fields, names)
        if (kdoc.isNotEmpty()) {
            classBuilder.addKdoc("%L", kdoc)
        }

        for ((i, field) in record.fields.withIndex()) {
            val name = names[i]
            val kotlinType = resolveResolvedType(field.type, index, opContext)
            val isOptional = !field.required
            val directTransferable = unwrapNullableTransferable(field.type)
            val finalType = (if (isOptional) kotlinType.copy(nullable = true) else kotlinType).let {
                if (directTransferable != null) it
                else annotateNestedTransferables(field.type, it, index, serializerRegistry, serializerContext)
            }

            val paramBuilder = ParameterSpec.builder(name, finalType)
            if (field.defaultValue != null) {
                val defaultExpr = jsonElementToKotlinDefault(field.defaultValue, field.type)
                if (defaultExpr != null) {
                    paramBuilder.defaultValue(defaultExpr)
                } else if (isOptional) {
                    paramBuilder.defaultValue("null")
                }
            } else if (isOptional) {
                paramBuilder.defaultValue("null")
            }
            constructor.addParameter(paramBuilder.build())

            val propBuilder = PropertySpec
                .builder(name, finalType)
                .initializer("%N", name)
            if (name != field.name || isKotlinKeyword(field.name)) {
                propBuilder.addAnnotation(
                    AnnotationSpec.builder(ClassNames.serialName)
                        .addMember("%S", field.name)
                        .build()
                )
            }
            if (directTransferable != null) {
                addTransferableSerializerAnnotation(
                    propBuilder,
                    directTransferable,
                    index,
                    serializerRegistry,
                    serializerContext,
                )
            }
            classBuilder.addProperty(propBuilder.build())
        }

        // Add attributes field for open-shape records (T & Record<string, V>), flat on the wire
        if (record.additionalPropertiesType != null) {
            val valueType = annotateNestedTransferables(
                record.additionalPropertiesType,
                resolveResolvedType(record.additionalPropertiesType, index, opContext),
                index,
                serializerRegistry,
                serializerContext,
            )
            val mapType = Map::class.asTypeName().parameterizedBy(String::class.asTypeName(), valueType)
            val paramBuilder = ParameterSpec.builder(extrasProperty, mapType)
                .defaultValue("emptyMap()")
            constructor.addParameter(paramBuilder.build())
            classBuilder.addProperty(
                PropertySpec.builder(extrasProperty, mapType)
                    .initializer("%N", extrasProperty)
                    .build(),
            )
        }

        val primaryConstructor = constructor.build()
        classBuilder.primaryConstructor(primaryConstructor)
        if (isOpenRecord) {
            classBuilder.addTypes(
                OpenRecordSerializerGenerator.nestedTypes(
                    ownerName = name,
                    serialName = name,
                    parameters = primaryConstructor.parameters,
                    properties = classBuilder.propertySpecs.toList(),
                    discriminator = null,
                    extrasProperty = extrasProperty,
                    wireNames = names.zip(record.fields.map { it.name }).toMap(),
                    serializerObject = openRecordSerializer,
                    fieldsClassName = openRecordFields,
                ),
            )
        }

        val initBlock = generateInitValidation(record.fields, names)
        if (initBlock != null) {
            classBuilder.addInitializerBlock(initBlock)
        }

        return classBuilder.build()
    }

    /**
     * The Kotlin names of a model's or union variant's [fields], in order: each field's spec name,
     * unless Kotlin can't declare it ([NamingUtils.memberName]: `back\slash` -> `backSlash`, written
     * with `@SerialName("back\\slash")`), and never one another field has (`_2`, …). The names are
     * the class's public properties; the generated members of the class step aside for them.
     */
    private fun propertyNames(fields: List<ResolvedField>): List<String> =
        NamingUtils.allocate(fields.map { it.name }, candidate = NamingUtils::memberName)

    private fun buildDataClassKdoc(
        description: String?,
        fields: List<ResolvedField>,
        names: List<String>,
    ): String {
        val parts = mutableListOf<String>()

        if (description != null) {
            parts.add(description)
        }

        val propertyTags = fields
            .mapIndexed { i, field -> names[i] to field }
            .filter { (_, field) -> field.description != null }
            .map { (name, field) -> "@property $name ${field.description}" }

        if (propertyTags.isNotEmpty()) {
            if (parts.isNotEmpty()) {
                parts.add("") // blank line between summary and tags
            }
            parts.addAll(propertyTags)
        }

        return parts.joinToString("\n")
    }

    // ── Init block validation generation ─────────────────────────────────

    private fun generateInitValidation(fields: List<ResolvedField>, names: List<String>): CodeBlock? {
        val statements = mutableListOf<CodeBlock>()
        for ((i, field) in fields.withIndex()) {
            val fieldStatements = generateFieldValidation(names[i], field.name, field.type, field.constraints, !field.required)
            statements.addAll(fieldStatements)
        }
        if (statements.isEmpty()) return null
        val builder = CodeBlock.builder()
        for (stmt in statements) {
            builder.add(stmt)
        }
        return builder.build()
    }

    /**
     * The `require` checks of the property [propertyName] (spec name [fieldName], which the
     * messages name) for its [constraints].
     */
    private fun generateFieldValidation(
        propertyName: String,
        fieldName: String,
        type: ResolvedType,
        constraints: Constraints,
        isOptional: Boolean,
    ): List<CodeBlock> {
        val stmts = mutableListOf<CodeBlock>()
        // The value checked: the property, escaped where Kotlin needs it, or `it` inside `?.let`.
        val ref = if (isOptional) "it" else expressionReference(propertyName)
        fun message(text: String) = messageLiteral("$fieldName $text")

        // String constraints (including format-based validation for non-type-mapped formats)
        if (type is ResolvedType.Primitive && type.kind == PrimitiveKind.STRING) {
            constraints.minLength?.let { min ->
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L.length >= %L) { %L }\n", ref, min, message("must be at least $min characters"))))
            }
            constraints.maxLength?.let { max ->
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L.length <= %L) { %L }\n", ref, max, message("must be at most $max characters"))))
            }
            constraints.pattern?.let { pattern ->
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L.matches(Regex(%S))) { %L }\n", ref, pattern, message("must match pattern $pattern"))))
            }
            constraints.format?.let { format ->
                val validationBlock = generateFormatValidation(propertyName, fieldName, format, isOptional)
                if (validationBlock != null) stmts.add(validationBlock)
            }
        }

        // Number constraints
        if (type is ResolvedType.Primitive && (type.kind == PrimitiveKind.NUMBER || type.kind == PrimitiveKind.INTEGER)) {
            constraints.minimum?.let { min ->
                val minVal = if (type.kind == PrimitiveKind.INTEGER) min.toInt().toString() else min.toString()
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L >= %L) { %L }\n", ref, minVal, message("must be >= $minVal"))))
            }
            constraints.maximum?.let { max ->
                val maxVal = if (type.kind == PrimitiveKind.INTEGER) max.toInt().toString() else max.toString()
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L <= %L) { %L }\n", ref, maxVal, message("must be <= $maxVal"))))
            }
            constraints.exclusiveMinimum?.let { min ->
                val minVal = if (type.kind == PrimitiveKind.INTEGER) min.toInt().toString() else min.toString()
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L > %L) { %L }\n", ref, minVal, message("must be > $minVal"))))
            }
            constraints.exclusiveMaximum?.let { max ->
                val maxVal = if (type.kind == PrimitiveKind.INTEGER) max.toInt().toString() else max.toString()
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L < %L) { %L }\n", ref, maxVal, message("must be < $maxVal"))))
            }
            constraints.multipleOf?.let { mult ->
                val multVal = if (type.kind == PrimitiveKind.INTEGER) mult.toInt().toString() else mult.toString()
                val zeroVal = if (type.kind == PrimitiveKind.INTEGER) "0" else "0.0"
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L %% %L == %L) { %L }\n", ref, multVal, zeroVal, message("must be a multiple of $multVal"))))
            }
        }

        // List/array constraints
        if (type is ResolvedType.ListType) {
            type.constraints.minItems?.let { min ->
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L.size >= %L) { %L }\n", ref, min, message("must have at least $min items"))))
            }
            type.constraints.maxItems?.let { max ->
                stmts.add(wrapOptional(propertyName, isOptional,
                    CodeBlock.of("require(%L.size <= %L) { %L }\n", ref, max, message("must have at most $max items"))))
            }
        }

        return stmts
    }

    private fun wrapOptional(fieldName: String, isOptional: Boolean, inner: CodeBlock): CodeBlock {
        return if (isOptional) {
            CodeBlock.builder()
                .beginControlFlow("%N?.let", fieldName)
                .add(inner)
                .endControlFlow()
                .build()
        } else {
            inner
        }
    }

    private fun generateFormatValidation(propertyName: String, fieldName: String, format: String, isOptional: Boolean): CodeBlock? {
        val ref = if (isOptional) "it" else expressionReference(propertyName)
        fun message(text: String) = messageLiteral("$fieldName $text")
        return when (format) {
            "email" -> wrapOptional(propertyName, isOptional,
                CodeBlock.of("require(%L.contains(%S) && %L.contains(%S)) { %L }\n",
                    ref, "@", ref, ".", message("must be a valid email address")))
            "uri" -> wrapOptional(propertyName, isOptional,
                CodeBlock.of("require(%L.startsWith(%S) || %L.startsWith(%S)) { %L }\n",
                    ref, "http://", ref, "https://", message("must be a valid URI")))
            "ipv4" -> wrapOptional(propertyName, isOptional,
                CodeBlock.of("require(%L.matches(Regex(%S))) { %L }\n",
                    ref, """^(\d{1,3}\.){3}\d{1,3}$""", message("must be a valid IPv4 address")))
            "ipv6" -> wrapOptional(propertyName, isOptional,
                CodeBlock.of("require(%L.contains(%S)) { %L }\n",
                    ref, ":", message("must be a valid IPv6 address")))
            else -> null
        }
    }

    /**
     * A one-line Kotlin string literal of [text], a validation message that quotes spec text (a
     * field name, a pattern). `\`, `"` and line breaks are escaped, and so is a `$` that would
     * start a template (`$name`, `${`); any other `$` stays as written, so `^[A-Z]{3}$` reads the
     * same as before.
     */
    private fun messageLiteral(text: String): String {
        val out = StringBuilder("\"")
        text.forEachIndexed { i, c ->
            val next = text.getOrNull(i + 1)
            when {
                c == '\\' -> out.append("\\\\")
                c == '"' -> out.append("\\\"")
                c == '\n' -> out.append("\\n")
                c == '\r' -> out.append("\\r")
                c == '\t' -> out.append("\\t")
                c == '$' && next != null && (next == '{' || next == '_' || next.isLetter()) -> out.append("\\$")
                c.isISOControl() -> out.append("\\u%04x".format(c.code))
                else -> out.append(c)
            }
        }
        return out.append('"').toString()
    }

    // ── Default value conversion ─────────────────────────────────────────

    private fun jsonElementToKotlinDefault(element: kotlinx.serialization.json.JsonElement, type: ResolvedType): CodeBlock? {
        val primitive = element as? JsonPrimitive ?: return null
        return when {
            type is ResolvedType.Primitive && type.kind == PrimitiveKind.STRING ->
                CodeBlock.of("%S", primitive.content)
            type is ResolvedType.Primitive && type.kind == PrimitiveKind.INTEGER ->
                CodeBlock.of("%L", primitive.content)
            type is ResolvedType.Primitive && type.kind == PrimitiveKind.NUMBER ->
                CodeBlock.of("%L", primitive.content)
            type is ResolvedType.Primitive && type.kind == PrimitiveKind.BOOLEAN ->
                CodeBlock.of("%L", primitive.content)
            else -> null
        }
    }

    // ── Enum class generation ─────────────────────────────────────────

    private fun generateEnumClass(
        name: String,
        values: List<String>,
    ): TypeSpec {
        val enumBuilder = TypeSpec
            .enumBuilder(name)
            .addAnnotation(ClassNames.serializable)

        // Constants are camel-cased, so two values may meet (`in-progress`, `in_progress`): the later gets `_2`.
        val entryNames = NamingUtils.allocate(values, candidate = ::toPascalCase)
        for ((i, literal) in values.withIndex()) {
            val entryName = entryNames[i]
            val entryBuilder = TypeSpec.anonymousClassBuilder()
            if (entryName != literal) {
                entryBuilder.addAnnotation(
                    AnnotationSpec.builder(ClassNames.serialName)
                        .addMember("%S", literal)
                        .build()
                )
            }
            enumBuilder.addEnumConstant(entryName, entryBuilder.build())
        }

        return enumBuilder.build()
    }

    // ── Sealed class generation ───────────────────────────────────────

    private fun generateSealedClass(
        name: String,
        union: ResolvedType.Union,
        index: TypeIndex,
        opContext: OperationTypeContext? = null,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext? = opContext,
    ): TypeSpec {
        val sealedBuilder = TypeSpec.classBuilder(name)
            .addModifiers(KModifier.SEALED)

        val discriminator = union.discriminator
        // kotlinx's sealed serializer writes the spec's wire format only for a string discriminator
        // over object arms; every other union reads and writes its own (UnionSerializerGenerator).
        val customSerializer = UnionSerializerGenerator.needsCustomSerializer(union)
        if (customSerializer) {
            sealedBuilder.addAnnotation(UnionSerializerGenerator.serializableAnnotation(name))
            sealedBuilder.addType(
                UnionSerializerGenerator.generate(name, union) { variant ->
                    unionValueCoding(variant, index, opContext, serializerRegistry, serializerContext)
                },
            )
        } else {
            sealedBuilder.addAnnotation(ClassNames.serializable)
            if (discriminator != null) {
                sealedBuilder.addAnnotation(
                    AnnotationSpec.builder(ClassNames.discriminator)
                        .addMember("%S", discriminator.fieldName)
                        .build()
                )
            }
        }

        for (variant in union.variants) {
            val variantContext = if (variant.nestedTypes.isNotEmpty()) {
                val ctx = OperationTypeContext(opContext?.operationObjectName ?: name)
                if (opContext != null) ctx.copyTypesFrom(opContext)
                for (nested in variant.nestedTypes) {
                    ctx.register(
                        nested.type,
                        ClassName("", variant.name, nested.name),
                        ClassName(packageName, variant.name, nested.name),
                    )
                }
                ctx
            } else opContext
            val variantSpec = generateSealedVariant(
                name,
                variant,
                union.discriminator,
                index,
                variantContext,
                serializerRegistry,
                serializerContext,
            )
            sealedBuilder.addType(variantSpec)
        }

        return sealedBuilder.build()
    }

    /** How a union's serializer reads and writes a value arm (or a literal arm with several literals). */
    private fun unionValueCoding(
        variant: UnionVariant,
        index: TypeIndex,
        opContext: OperationTypeContext?,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext?,
    ): UnionSerializerGenerator.ValueCoding {
        val literal = variant.literal
        if (literal != null) return UnionSerializerGenerator.ValueCoding(UnionSerializerGenerator.literalValueType(literal), null)
        val valueType = variant.valueType ?: error("${variant.name} is not a value arm")
        return UnionSerializerGenerator.ValueCoding(
            resolveResolvedType(valueType, index, opContext),
            containerTransferableSerializer(valueType, index, serializerRegistry, serializerContext),
        )
    }

    private fun generateSealedVariant(
        sealedName: String,
        variant: UnionVariant,
        discriminator: DiscriminatorInfo?,
        index: TypeIndex,
        opContext: OperationTypeContext? = null,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext? = opContext,
    ): TypeSpec {
        val sealedClassName = ClassName("", sealedName)

        // Compute the discriminator wire value for this variant
        val discValue = variant.discriminatorValue
            ?: discriminator?.variants?.entries?.find { it.value == variant.name }?.key
            ?: variant.name.lowercase()
        // A `@SerialName` is the discriminator value; a union without one has none to give.
        val serialName = AnnotationSpec.builder(ClassNames.serialName).addMember("%S", discValue).build()
        val annotateSerialName: TypeSpec.Builder.() -> TypeSpec.Builder =
            { if (discriminator != null) addAnnotation(serialName) else this }

        // A literal arm with one literal: the union's serializer reads and writes the literal itself.
        if (variant.literal?.size == 1) {
            return TypeSpec.objectBuilder(variant.name)
                .addModifiers(KModifier.DATA)
                .superclass(sealedClassName)
                .addKdoc("The literal `%L`.\n", variant.literal.single())
                .build()
        }

        // A value arm holds the arm's bare JSON value, which the union's serializer reads and writes.
        if (variant.valueType != null || variant.literal != null) {
            val valueType = unionValueCoding(variant, index, opContext, serializerRegistry, serializerContext).type
            val property = UnionSerializerGenerator.VALUE_PROPERTY
            return TypeSpec.classBuilder(variant.name)
                .addModifiers(KModifier.DATA)
                .superclass(sealedClassName)
                .primaryConstructor(FunSpec.constructorBuilder().addParameter(property, valueType).build())
                .addProperty(PropertySpec.builder(property, valueType).initializer(property).build())
                .build()
        }

        if (variant.fields.isEmpty() && variant.embeddedUnion == null && variant.additionalPropertiesType == null) {
            val objectBuilder = TypeSpec.objectBuilder(variant.name)
                .addModifiers(KModifier.DATA)
                .superclass(sealedClassName)
                .addAnnotation(ClassNames.serializable)
                .annotateSerialName()
            return objectBuilder.build()
        }

        val constructor = FunSpec.constructorBuilder()
        val isOpenRecord = variant.additionalPropertiesType != null
        // A hybrid arm (own properties plus a nested union) is one flat object on the wire.
        val isHybrid = variant.embeddedUnion != null && !isOpenRecord
        // Generated members step aside for the variant's properties: `attributes_2`, `OpenRecordSerializer_2`.
        val names = propertyNames(variant.fields)
        val taken = names.toMutableSet()
        val extrasProperty = NamingUtils.claim(OpenRecordSerializerGenerator.EXTRAS_PROPERTY, taken)
        val embeddedProperty = variant.embeddedUnion?.let {
            NamingUtils.claim(NamingUtils.memberName(it.discriminator?.fieldName ?: "variant"), taken)
        }
        val (openRecordSerializer, openRecordFields) = OpenRecordSerializerGenerator.nestedTypeNames(names)
        val (hybridSerializer, hybridFields) = HybridArmSerializerGenerator.nestedTypeNames(names + listOfNotNull(embeddedProperty))
        val variantBuilder = TypeSpec.classBuilder(variant.name)
            .addModifiers(KModifier.DATA)
            .superclass(sealedClassName)
            .addAnnotation(
                when {
                    isOpenRecord -> OpenRecordSerializerGenerator.serializableAnnotation(variant.name, openRecordSerializer)
                    isHybrid -> HybridArmSerializerGenerator.serializableAnnotation(variant.name, hybridSerializer)
                    else -> AnnotationSpec.builder(ClassNames.serializable).build()
                },
            )
            .annotateSerialName()

        for ((i, field) in variant.fields.withIndex()) {
            val name = names[i]
            val kotlinType = resolveResolvedType(field.type, index, opContext)
            val isOptional = !field.required
            val directTransferable = unwrapNullableTransferable(field.type)
            val finalType = (if (isOptional) kotlinType.copy(nullable = true) else kotlinType).let {
                if (directTransferable != null) it
                else annotateNestedTransferables(field.type, it, index, serializerRegistry, serializerContext)
            }

            val paramBuilder = ParameterSpec.builder(name, finalType)
            if (isOptional) paramBuilder.defaultValue("null")
            constructor.addParameter(paramBuilder.build())

            val propBuilder = PropertySpec.builder(name, finalType)
                .initializer("%N", name)
            if (name != field.name || isKotlinKeyword(field.name)) {
                propBuilder.addAnnotation(
                    AnnotationSpec.builder(ClassNames.serialName)
                        .addMember("%S", field.name)
                        .build()
                )
            }
            directTransferable?.let { transferableType ->
                addTransferableSerializerAnnotation(
                    propBuilder,
                    transferableType,
                    index,
                    serializerRegistry,
                    serializerContext,
                )
            }
            variantBuilder.addProperty(propBuilder.build())
        }

        // Add attributes field for open-shape variants, flat on the wire beside the discriminator
        if (variant.additionalPropertiesType != null) {
            val valueType = annotateNestedTransferables(
                variant.additionalPropertiesType,
                resolveResolvedType(variant.additionalPropertiesType, index, opContext),
                index,
                serializerRegistry,
                serializerContext,
            )
            val mapType = Map::class.asTypeName().parameterizedBy(String::class.asTypeName(), valueType)
            val paramBuilder = ParameterSpec.builder(extrasProperty, mapType)
                .defaultValue("emptyMap()")
            constructor.addParameter(paramBuilder.build())
            variantBuilder.addProperty(
                PropertySpec.builder(extrasProperty, mapType)
                    .initializer("%N", extrasProperty)
                    .build(),
            )
        }

        // Add embedded union field if present
        if (variant.embeddedUnion != null && embeddedProperty != null) {
            val embeddedName = variant.embeddedUnion.name
            val embeddedClassName = ClassName("", embeddedName)
            val discFieldName = embeddedProperty

            constructor.addParameter(
                ParameterSpec.builder(discFieldName, embeddedClassName).build()
            )
            variantBuilder.addProperty(
                PropertySpec.builder(discFieldName, embeddedClassName)
                    .initializer("%N", discFieldName)
                    .build(),
            )

            // Generate the embedded sealed class and nest it inside the variant
            val embeddedSpec = generateSealedClass(
                embeddedName,
                variant.embeddedUnion,
                index,
                opContext,
                serializerRegistry,
                serializerContext,
            )
            variantBuilder.addType(embeddedSpec)
        }

        val primaryConstructor = constructor.build()
        variantBuilder.primaryConstructor(primaryConstructor)
        if (isOpenRecord) {
            variantBuilder.addTypes(
                OpenRecordSerializerGenerator.nestedTypes(
                    ownerName = variant.name,
                    serialName = discValue,
                    parameters = primaryConstructor.parameters,
                    properties = variantBuilder.propertySpecs.toList(),
                    discriminator = discriminator?.fieldName,
                    extrasProperty = extrasProperty,
                    wireNames = names.zip(variant.fields.map { it.name }).toMap(),
                    serializerObject = openRecordSerializer,
                    fieldsClassName = openRecordFields,
                ),
            )
        }
        val embeddedUnion = variant.embeddedUnion
        if (isHybrid && embeddedUnion != null && embeddedProperty != null) {
            variantBuilder.addTypes(
                HybridArmSerializerGenerator.nestedTypes(
                    ownerName = variant.name,
                    serialName = discValue,
                    parameters = primaryConstructor.parameters,
                    properties = variantBuilder.propertySpecs.toList(),
                    unionProperty = embeddedProperty,
                    unionName = embeddedUnion.name,
                    discriminator = discriminator?.fieldName,
                    wireNames = names.zip(variant.fields.map { it.name }).toMap(),
                    serializerObject = hybridSerializer,
                    fieldsClassName = hybridFields,
                ),
            )
        }

        val initBlock = generateInitValidation(variant.fields, names)
        if (initBlock != null) {
            variantBuilder.addInitializerBlock(initBlock)
        }

        // Add variant-scoped nested types (e.g. enums for array item fields)
        for (nested in variant.nestedTypes) {
            variantBuilder.addType(
                generateNestedTypeSpec(
                    nested,
                    index,
                    listOf(sealedName, variant.name),
                    serializerRegistry,
                    serializerContext,
                ),
            )
        }

        return variantBuilder.build()
    }

    // ── Servers.kt generation ─────────────────────────────────────────

    private fun generateServersFile(servers: List<ServerDefinition>, propertyNames: List<String>): FileSpec {
        val serverFileBuilder = FileSpec.builder(packageName, "Servers")

        // Servers object using BlocksServer from the runtime
        val serversObjectBuilder = TypeSpec.objectBuilder("Servers")
        for ((i, entry) in servers.withIndex()) {
            serversObjectBuilder.addProperty(
                PropertySpec
                    .builder(propertyNames[i], blocksServerClass)
                    .initializer(
                        "%T(name = %S, url = %S)",
                        blocksServerClass,
                        entry.name,
                        entry.url,
                    )
                    .build(),
            )
        }
        serverFileBuilder.addType(serversObjectBuilder.build().withApiVisibility())

        return serverFileBuilder.build()
    }

    // ── Per-API-group file generation ─────────────────────────────────

    private fun generateApiGroupFile(
        group: ApiNamespace,
        className: String,
        index: TypeIndex,
        defaultServerProperty: String?,
        endpoint: String?,
        serializerRegistry: TransferableSerializerRegistry,
    ): FileSpec {
        val builder = FileSpec.builder(packageName, className)

        // A parameter named after an object a method body reads (`BlocksJson.encodeToJsonElement`)
        // would shadow it there, so that object is imported under an alias in this file.
        val parameterNames = group.operations.flatMap { methodNames(it).parameters }.toMutableSet()
        for (receiver in EXPRESSION_RECEIVERS) {
            if (receiver.simpleName in parameterNames) {
                builder.addAliasedImport(receiver, NamingUtils.claim(receiver.simpleName, parameterNames))
            }
        }

        // Add @OptIn(ExperimentalSerializationApi::class) if any operation has discriminated unions
        val hasDiscriminator = group.operations.any { op ->
            op.nestedTypes.any { hasDiscriminatorInTree(it) }
        }
        if (hasDiscriminator) {
            builder.addAnnotation(
                AnnotationSpec.builder(ClassNames.optIn)
                    .addMember("%T::class", ClassNames.experimentalSerializationApi)
                    .build()
            )
        }

        builder.addType(
            generateApiClass(group, className, index, defaultServerProperty, endpoint, serializerRegistry).withApiVisibility(),
        )

        return builder.build()
    }

    /** Recursively checks if a nested type tree contains any discriminated union. */
    private fun hasDiscriminatorInTree(node: NestedTypeNode): Boolean {
        if (node.type is ResolvedType.Union && (node.type as ResolvedType.Union).discriminator != null) {
            return true
        }
        return node.children.any { hasDiscriminatorInTree(it) }
    }

    // ── API class generation ─────────────────────────────────────────

    /**
     * Maps short type names to their relative ClassName path within an operation object.
     * Used to resolve inline types referenced in method signatures and bodies.
     */
    private inner class OperationTypeContext(
        val operationObjectName: String,
    ) {
        private val relativeTypes = LinkedHashMap<ResolvedType, ClassName>()
        private val qualifiedTypes = LinkedHashMap<ResolvedType, ClassName>()
        private val relativeNames = LinkedHashMap<String, ClassName>()
        private val qualifiedNames = LinkedHashMap<String, ClassName>()

        fun register(type: ResolvedType, relative: ClassName, qualified: ClassName) {
            relativeTypes[type] = relative
            qualifiedTypes[type] = qualified
            namedType(type)?.let { name ->
                relativeNames[name] = relative
                qualifiedNames[name] = qualified
            }
        }

        fun resolve(type: ResolvedType, qualified: Boolean): ClassName? =
            if (qualified) qualifiedTypes[type] else relativeTypes[type]

        fun resolveByName(name: String, qualified: Boolean): ClassName? =
            if (qualified) qualifiedNames[name] else relativeNames[name]

        fun copyTypesFrom(other: OperationTypeContext) {
            relativeTypes.putAll(other.relativeTypes)
            qualifiedTypes.putAll(other.qualifiedTypes)
            relativeNames.putAll(other.relativeNames)
            qualifiedNames.putAll(other.qualifiedNames)
        }

    }

    private fun generateApiClass(
        namespace: ApiNamespace,
        className: String,
        index: TypeIndex,
        defaultServerProperty: String?,
        endpoint: String?,
        serializerRegistry: TransferableSerializerRegistry,
    ): TypeSpec {
        val clientInitializer = if (endpoint != null) {
            com.squareup.kotlinpoet.CodeBlock.of("%T(%T(server.name, server.url.toString() + %S))", ClassNames.blocksClient, blocksServerClass, endpoint)
        } else {
            com.squareup.kotlinpoet.CodeBlock.of("%T(server)", ClassNames.blocksClient)
        }

        val constructorBuilder = FunSpec.constructorBuilder()
        if (defaultServerProperty != null) {
            val serversClassName = ClassName(packageName, "Servers")
            constructorBuilder.addParameter(
                ParameterSpec.builder("server", blocksServerClass)
                    .defaultValue("%T.%N", serversClassName, defaultServerProperty)
                    .build(),
            )
        } else {
            constructorBuilder.addParameter("server", blocksServerClass)
        }

        val classBuilder = TypeSpec
            .classBuilder(className)
            .primaryConstructor(constructorBuilder.build())
            .addProperty(
                PropertySpec
                    .builder("server", blocksServerClass, KModifier.PRIVATE)
                    .initializer("server")
                    .build(),
            ).addProperty(
                PropertySpec
                    .builder("client", ClassNames.blocksClient, KModifier.PRIVATE)
                    .initializer(clientInitializer)
                    .build(),
            )

        // An operation's function and its nested-types object are named after it, distinct in this class.
        val operations = namespace.operations
        val functionNames = NamingUtils.allocate(operations.map { it.name }, candidate = NamingUtils::memberName)
        val objectNames = NamingUtils.allocate(operations.map { it.name }, candidate = ::toPascalCase)

        val operationContexts = java.util.IdentityHashMap<Operation, OperationTypeContext?>()
        for ((i, operation) in operations.withIndex()) {
            operationContexts[operation] = buildOperationTypeContext(operation, objectNames[i], className)
        }

        for ((i, operation) in operations.withIndex()) {
            if (stubOidc && containsOidcTransferable(operation.result.type)) {
                classBuilder.addFunction(generateOidcStubMethod(functionNames[i]))
            } else {
                val opContext = operationContexts[operation]
                classBuilder.addFunction(
                    generateImplMethod(operation, functionNames[i], index, opContext, serializerRegistry),
                )
            }
        }

        // Add nested operation objects for operations that have nested types
        for ((i, operation) in operations.withIndex()) {
            if (operation.nestedTypes.isNotEmpty()) {
                classBuilder.addType(
                    generateOperationObject(
                        operation,
                        objectNames[i],
                        index,
                        serializerRegistry,
                        operationContexts[operation],
                    ),
                )
            }
        }

        return classBuilder.build()
    }

    /**
     * Builds both relative and fully qualified paths from one traversal of an operation's
     * nested types. Relative paths are used in API source; qualified paths are used by
     * serializers emitted in a separate top-level file.
     */
    private fun buildOperationTypeContext(operation: Operation, opObjectName: String, apiClassName: String): OperationTypeContext? {
        if (operation.nestedTypes.isEmpty()) return null
        val context = OperationTypeContext(opObjectName)

        fun walkNodes(
            nodes: List<NestedTypeNode>,
            parentPath: List<String>,
            qualifiedPath: List<String>,
        ) {
            for (node in nodes) {
                val currentPath = parentPath + node.name
                val currentQualifiedPath = qualifiedPath + node.name
                context.register(
                    node.type,
                    ClassName("", currentPath),
                    ClassName(packageName, *currentQualifiedPath.toTypedArray()),
                )
                if (node.children.isNotEmpty()) {
                    walkNodes(node.children, currentPath, currentQualifiedPath)
                }
                // Walk into variant-scoped nested types for union nodes
                val type = node.type
                if (type is ResolvedType.Union) {
                    for (variant in type.variants) {
                        if (variant.nestedTypes.isNotEmpty()) {
                            val variantPath = currentPath + variant.name
                            walkNodes(variant.nestedTypes, variantPath, currentQualifiedPath + variant.name)
                        }
                    }
                }
            }
        }

        walkNodes(operation.nestedTypes, listOf(opObjectName), listOf(apiClassName, opObjectName))
        return context
    }

    /**
     * Generates an `object OperationName { ... }` containing all nested types for one operation.
     */
    private fun generateOperationObject(
        operation: Operation,
        objectName: String,
        index: TypeIndex,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext?,
    ): TypeSpec {
        val objectBuilder = TypeSpec.objectBuilder(objectName)

        for (node in operation.nestedTypes) {
            objectBuilder.addType(
                generateNestedTypeSpec(
                    node,
                    index,
                    listOf(objectName),
                    serializerRegistry,
                    serializerContext,
                ),
            )
        }

        return objectBuilder.build()
    }

    /**
     * Recursively generates a TypeSpec for a NestedTypeNode — either a data class,
     * enum class, or sealed class depending on the node's resolved type.
     * Children are added as nested types inside the generated type.
     *
     * @param parentPath The ClassName nesting path of the parent (used to build child references).
     *   For root-level nodes inside an operation object, this is listOf("OperationName").
     */
    private fun generateNestedTypeSpec(
        node: NestedTypeNode,
        index: TypeIndex,
        parentPath: List<String> = emptyList(),
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext? = null,
    ): TypeSpec {
        // Build an OperationTypeContext for this node's children so that field type
        // references resolve to short relative ClassName paths.
        val hasVariantNestedTypes = (node.type as? ResolvedType.Union)?.variants?.any { it.nestedTypes.isNotEmpty() } == true
        val childContext = if (node.children.isNotEmpty() || hasVariantNestedTypes) {
            val ctx = OperationTypeContext(parentPath.firstOrNull() ?: node.name)
            fun registerChildren(
                children: List<NestedTypeNode>,
                currentPath: List<String>,
            ) {
                for (child in children) {
                    ctx.register(
                        child.type,
                        ClassName("", currentPath + child.name),
                        ClassName(packageName, *(currentPath + child.name).toTypedArray()),
                    )
                    if (child.children.isNotEmpty()) {
                        registerChildren(
                            child.children,
                            currentPath + child.name,
                        )
                    }
                }
            }
            registerChildren(node.children, listOf(node.name))
            // Register variant-scoped nested types
            if (node.type is ResolvedType.Union) {
                for (variant in node.type.variants) {
                    if (variant.nestedTypes.isNotEmpty()) {
                        registerChildren(
                            variant.nestedTypes,
                            listOf(node.name, variant.name),
                        )
                    }
                }
            }
            ctx
        } else null

        val spec = when (val type = node.type) {
            is ResolvedType.Record -> generateDataClass(
                node.name,
                type,
                index,
                childContext,
                serializerRegistry,
                serializerContext,
            )
            is ResolvedType.Enum -> generateEnumClass(node.name, type.values)
            is ResolvedType.Union -> generateSealedClass(
                node.name,
                type,
                index,
                childContext,
                serializerRegistry,
                serializerContext,
            )
            else -> throw IllegalStateException("Unexpected nested type kind: ${type::class.simpleName}")
        }

        // If there are children, add them as nested types inside this TypeSpec
        if (node.children.isNotEmpty()) {
            val currentPath = parentPath + node.name
            return spec.toBuilder().apply {
                for (child in node.children) {
                    addType(
                        generateNestedTypeSpec(
                            child,
                            index,
                            currentPath,
                            serializerRegistry,
                            serializerContext,
                        ),
                    )
                }
            }.build()
        }

        return spec
    }

    /**
     * The names an operation's method declares and reads. [parameters] are the Kotlin names of its
     * parameters, in order: the spec's, unless Kotlin can't declare one ([NamingUtils.memberName]).
     * They are public (named arguments), so the generated names step aside for them: the locals
     * [request], [args], [result] and [json] keep their names unless a parameter has one (then
     * `result_2`, …), and [client], the API class's property, is read as `this.client` when a
     * parameter is named `client`.
     */
    private inner class MethodNames(
        val parameters: List<String>,
        val request: String,
        val args: String,
        val result: String,
        val json: String,
        val client: String,
    ) {
        /** How the body reads the parameter at [index] (see [expressionReference]). */
        fun reference(index: Int): String = expressionReference(parameters[index])
    }

    private fun methodNames(operation: Operation): MethodNames {
        val parameters = NamingUtils.allocate(operation.parameters.map { it.name }, candidate = NamingUtils::memberName)
        val taken = parameters.toMutableSet()
        return MethodNames(
            parameters = parameters,
            request = NamingUtils.claim("request", taken),
            args = NamingUtils.claim("args", taken),
            result = NamingUtils.claim("result", taken),
            json = NamingUtils.claim("json", taken),
            client = if ("client" in parameters) "this.client" else "client",
        )
    }

    private fun buildMethodKdoc(operation: Operation, names: MethodNames): String {
        val parts = mutableListOf<String>()

        if (operation.description != null) {
            parts.add(operation.description)
        }

        val paramTags = operation.parameters
            .mapIndexed { i, param -> names.parameters[i] to param }
            .filter { (_, param) -> !param.description.isNullOrEmpty() }
            .map { (name, param) -> "@param $name ${param.description}" }

        val returnTag = operation.result.description

        val tags = paramTags + listOfNotNull(returnTag)

        if (tags.isNotEmpty()) {
            if (parts.isNotEmpty()) {
                parts.add("")
            }
            parts.addAll(tags)
        }

        return parts.joinToString("\n")
    }

    private fun generateImplMethod(
        operation: Operation,
        functionName: String,
        index: TypeIndex,
        opContext: OperationTypeContext?,
        serializerRegistry: TransferableSerializerRegistry,
    ): FunSpec {
        val funBuilder = FunSpec
            .builder(functionName)
            .addModifiers(KModifier.SUSPEND)

        val names = methodNames(operation)
        val kdoc = buildMethodKdoc(operation, names)
        if (kdoc.isNotEmpty()) {
            funBuilder.addKdoc("%L", kdoc)
        }

        for ((i, param) in operation.parameters.withIndex()) {
            val paramType = resolveResolvedType(param.type, index, opContext)
            val isOptional = !param.required
            val finalType = if (isOptional) paramType.copy(nullable = true) else paramType
            val paramBuilder = ParameterSpec.builder(names.parameters[i], finalType)
            if (isOptional) paramBuilder.defaultValue("null")
            funBuilder.addParameter(paramBuilder.build())
        }

        val returnType = if (isUnboundDirectResult(operation.result.type)) {
            ClassNames.unknownTransferable
        } else {
            resolveResolvedType(operation.result.type, index, opContext)
        }
        if (returnType != Unit::class.asTypeName()) {
            funBuilder.returns(returnType)
        }

        generateImplMethodBody(funBuilder, operation, names, index, opContext, returnType, serializerRegistry)

        return funBuilder.build()
    }

    private fun generateOidcStubMethod(functionName: String): FunSpec {
        val message = "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block " +
            "to enable this method."
        return FunSpec.builder(functionName)
            .addModifiers(KModifier.SUSPEND)
            .addAnnotation(
                AnnotationSpec.builder(ClassName("kotlin", "Deprecated"))
                    .addMember("message = %S", message)
                    .addMember("level = %T.%L", ClassName("kotlin", "DeprecationLevel"), "ERROR")
                    .build()
            )
            .returns(ClassName("kotlin", "Nothing"))
            .addStatement("throw NotImplementedError(%S)", message)
            .build()
    }

    private fun generateImplMethodBody(
        funBuilder: FunSpec.Builder,
        operation: Operation,
        names: MethodNames,
        index: TypeIndex,
        opContext: OperationTypeContext?,
        returnType: TypeName,
        serializerRegistry: TransferableSerializerRegistry,
    ) {
        // Optional parameters after the last required one. Every other parameter always has its slot.
        val trailingOptionals = operation.parameters.size - 1 - operation.parameters.indexOfLast { it.required }
        // The spec's method name, exactly: a dotless `ping` is grouped under `_default` but sent as `ping`.
        val dottedMethod = operation.rpcMethod

        if (operation.parameters.isEmpty()) {
            funBuilder.addStatement(
                "val %N = %T(method = %S, params = emptyList(), id = %T.nextId())",
                names.request,
                ClassNames.blocksRequest,
                dottedMethod,
                ClassNames.blocksRequest,
            )
        } else if (trailingOptionals > 0) {
            generateConditionalArgs(funBuilder, operation, names, index, opContext)
            funBuilder.addStatement(
                "val %N = %T(method = %S, params = %N, id = %T.nextId())",
                names.request,
                ClassNames.blocksRequest,
                dottedMethod,
                names.args,
                ClassNames.blocksRequest,
            )
        } else {
            // Every parameter has a slot (an optional one before a required one is sent as null when
            // it is null) — build a listOf(...) inline
            val paramBlocks = operation.parameters.indices.map { i -> slotExpression(operation, names, i, index, opContext) }
            val paramsCode = paramBlocks.joinToCode(", ")
            funBuilder.addStatement(
                "val %N = %T(method = %S, params = listOf(%L), id = %T.nextId())",
                names.request,
                ClassNames.blocksRequest,
                dottedMethod,
                paramsCode,
                ClassNames.blocksRequest,
            )
        }

        if (returnType == Unit::class.asTypeName()) {
            funBuilder.addStatement("%L.execute(%N)", names.client, names.request)
        } else if (returnType == ClassNames.unknownTransferable) {
            // An unbound tag here would otherwise fail generation; degrade to a checked carrier.
            val tag = (operation.result.type as ResolvedType.Transferable).transferableName
            funBuilder.addStatement("val %N = %L.execute(%N)", names.result, names.client, names.request)
            funBuilder.addStatement(
                "return %T.fromJson(%N, expectedTag = %L)",
                ClassNames.unknownTransferable,
                names.result,
                kotlinStringLiteral(tag),
            )
        } else if (isTransferableType(operation.result.type)) {
            val transferableType = unwrapNullableTransferable(operation.result.type)!!
            funBuilder.addStatement("val %N = %L.execute(%N)", names.result, names.client, names.request)
            // A channel whose payload holds an OIDC client decodes each message with a Json bound to this client.
            val payloadJson = if (transferableType.transferableName == "realtime/channel" &&
                transferableType.typeArgs.any { containsOidcTransferable(it) }
            ) {
                funBuilder.addStatement("val %N = %T.json(%L, %S)", names.json, ClassNames.oidcClient, names.client, relayTo ?: "")
                CodeBlock.of("%N", names.json)
            } else {
                CodeBlock.of("%T", ClassNames.blocksJson)
            }
            val fromJsonExpr = generateTransferableFromJson(
                transferableType,
                names.result,
                index,
                opContext,
                serializerRegistry,
                payloadJson,
                names.client,
            )
            funBuilder.addCode("return %L\n", fromJsonExpr)
        } else {
            // A result holding an OIDC client anywhere decodes with a Json that binds it to this client.
            val json = if (containsOidcTransferable(operation.result.type)) {
                CodeBlock.of("%T.json(%L, %S)", ClassNames.oidcClient, names.client, relayTo ?: "")
            } else {
                CodeBlock.of("%T", ClassNames.blocksJson)
            }
            val serializer = containerTransferableSerializer(operation.result.type, index, serializerRegistry, opContext)
            funBuilder.addStatement("val %N = %L.execute(%N)", names.result, names.client, names.request)
            if (serializer != null) {
                funBuilder.addStatement("return %L.%M(%L, %N)", json, MemberNames.decode, serializer, names.result)
            } else {
                funBuilder.addStatement("return %L.%M(%N)", json, MemberNames.decode, names.result)
            }
        }
    }

    private fun unwrapNullable(type: ResolvedType): ResolvedType =
        if (type is ResolvedType.Nullable) type.inner else type

    /**
     * The parameters of a method with optional ones after its last required one, as `args`.
     *
     * JSON-RPC params are positional on the server (`parseRpcRequest` passes `params` as the
     * method's argument list), so every argument keeps its slot, as the TypeScript client's
     * arguments array does: an optional parameter before a required one is sent as JSON `null`
     * when it is null ([slotExpression]); a trailing one is sent when it or a later one is set,
     * as `null` if it isn't, and trailing ones that are all null are left off.
     */
    private fun generateConditionalArgs(
        funBuilder: FunSpec.Builder,
        operation: Operation,
        names: MethodNames,
        index: TypeIndex,
        opContext: OperationTypeContext?,
    ) {
        val params = operation.parameters
        val firstTrailing = params.indexOfLast { it.required } + 1
        val leading = (0 until firstTrailing).map { slotExpression(operation, names, it, index, opContext) }
        fun toJson(position: Int) = paramToJsonExpression(params[position], names, position, index, opContext)

        if (firstTrailing == params.size - 1) {
            val optParam = params.lastIndex
            val reqCode = leading.joinToCode(", ")
            val allCode = (leading + toJson(optParam)).joinToCode(", ")

            funBuilder.addCode(
                "val %N: %T = if (%N != null) listOf(%L) else listOf(%L)\n",
                names.args,
                List::class.asTypeName().parameterizedBy(ClassNames.jsonElement),
                names.parameters[optParam],
                allCode,
                reqCode,
            )
        } else {
            funBuilder.addCode("val %N = mutableListOf<%T>(%L)\n", names.args, ClassNames.jsonElement, leading.joinToCode(", "))
            for (position in firstTrailing until params.size) {
                if (position == params.lastIndex) {
                    funBuilder.beginControlFlow("if (%N != null)", names.parameters[position])
                    funBuilder.addCode("%N.add(%L)\n", names.args, toJson(position))
                } else {
                    // Sent when this or a later argument is set, so the later one keeps its slot.
                    val anySet = (position until params.size)
                        .map { CodeBlock.of("%N != null", names.parameters[it]) }
                        .joinToCode(" || ")
                    funBuilder.beginControlFlow("if (%L)", anySet)
                    funBuilder.addCode(
                        "%N.add(if (%N != null) %L else %T)\n",
                        names.args,
                        names.parameters[position],
                        toJson(position),
                        ClassNames.jsonNull,
                    )
                }
                funBuilder.endControlFlow()
            }
        }
    }

    /**
     * The JSON a parameter that always has a slot sends: a required one as is, an optional one
     * (before a required one) as JSON `null` when it is null, so later arguments keep their place.
     */
    private fun slotExpression(
        operation: Operation,
        names: MethodNames,
        position: Int,
        index: TypeIndex,
        opContext: OperationTypeContext?,
    ): CodeBlock {
        val param = operation.parameters[position]
        val json = paramToJsonExpression(param, names, position, index, opContext)
        return if (param.required) json
        else CodeBlock.of("if (%N != null) %L else %T", names.parameters[position], json, ClassNames.jsonNull)
    }

    /**
     * Generates a [CodeBlock] that converts an operation parameter to a JsonElement.
     * Wraps primitives in JsonPrimitive; delegates to generateToJsonExpression for complex types.
     * A transferable is sent as its descriptor (`toJson()`), as Swift does. A parameter holding
     * an OIDC client inside a model encodes with `OidcClient.json`, whose contextual serializer
     * writes it (plain [ClassNames.blocksJson] has none).
     */
    private fun paramToJsonExpression(
        param: OperationParameter,
        names: MethodNames,
        position: Int,
        index: TypeIndex,
        opContext: OperationTypeContext?,
    ): CodeBlock {
        val jsonPrimitiveClass = ClassNames.jsonPrimitive
        val inner = unwrapNullable(param.type)
        val reference = names.reference(position)
        val json = if (containsOidcTransferable(inner)) {
            CodeBlock.of("%T.json(%L, %S)", ClassNames.oidcClient, names.client, relayTo ?: "")
        } else {
            CodeBlock.of("%T", ClassNames.blocksJson)
        }
        return when (inner) {
            is ResolvedType.Primitive -> when (inner.kind) {
                PrimitiveKind.VOID -> CodeBlock.of("%L", reference)
                // Already a JsonElement. A required-but-nullable one is `JsonElement?` here (optional
                // ones are smart-cast inside their `!= null` guard), so send a JSON null for null.
                PrimitiveKind.UNKNOWN -> if (param.required && param.type is ResolvedType.Nullable) {
                    CodeBlock.of("%L ?: %T", reference, ClassNames.jsonNull)
                } else {
                    CodeBlock.of("%L", reference)
                }
                else -> CodeBlock.of("%T(%L)", jsonPrimitiveClass, reference)
            }
            // A required-but-nullable transferable is `T?` here (optional ones are smart-cast inside
            // their `!= null` guard), so send a JSON null for null.
            is ResolvedType.Transferable -> if (param.required && param.type is ResolvedType.Nullable) {
                generateToJsonExpression(param.type, reference, index, json)
            } else {
                generateToJsonExpression(inner, reference, index, json)
            }
            else -> generateToJsonExpression(inner, reference, index, json)
        }
    }

    private fun List<CodeBlock>.joinToCode(separator: String): CodeBlock {
        val builder = CodeBlock.builder()
        forEachIndexed { i, block ->
            if (i > 0) builder.add(separator)
            builder.add(block)
        }
        return builder.build()
    }

    // ── Type resolution ──────────────────────────────────────────────

    private fun resolveResolvedType(
        type: ResolvedType,
        index: TypeIndex,
        opContext: OperationTypeContext? = null,
        qualified: Boolean = false,
    ): TypeName =
        when (type) {
            is ResolvedType.Primitive -> mapPrimitive(type.kind)
            is ResolvedType.ListType -> {
                val elementType = resolveResolvedType(type.elementType, index, opContext, qualified)
                List::class.asTypeName().parameterizedBy(elementType)
            }
            is ResolvedType.Nullable -> {
                resolveResolvedType(type.inner, index, opContext, qualified).copy(nullable = true)
            }
            is ResolvedType.Record -> {
                resolveNamedType(type, index, opContext, qualified)
            }
            is ResolvedType.Enum -> {
                resolveNamedType(type, index, opContext, qualified)
            }
            is ResolvedType.Union -> {
                resolveNamedType(type, index, opContext, qualified)
            }
            is ResolvedType.TypeReference -> {
                resolveNamedType(type, index, opContext, qualified)
            }
            is ResolvedType.FormattedType -> mapFormattedType(type.format)
            is ResolvedType.MapType -> {
                val valueType = resolveResolvedType(type.valueType, index, opContext, qualified)
                Map::class.asTypeName().parameterizedBy(String::class.asTypeName(), valueType)
            }
            is ResolvedType.TupleType -> {
                resolveNamedType(type, index, opContext, qualified)
            }
            is ResolvedType.Transferable -> resolveTransferable(type, index, opContext, qualified)
        }

    /**
     * Resolves a named type (Record, Enum, Union, TypeReference, TupleType) to a ClassName.
     * First checks the operation context (for inline nested types), then falls back to the
     * global type index (for component schemas).
     */
    private fun resolveNamedType(
        type: ResolvedType,
        index: TypeIndex,
        opContext: OperationTypeContext?,
        qualified: Boolean,
    ): ClassName {
        // Check operation context first (inline nested types)
        if (opContext != null) {
            opContext.resolve(type, qualified)?.let { return it }
            namedType(type)?.let { name ->
                opContext.resolveByName(name, qualified)?.let { return it }
            }
        }
        // Fall back to global type index (component schemas)
        val name = namedType(type).orEmpty()
        return findClassNameByTypeName(name, index)
            ?: if (name.isNotEmpty()) ClassName(packageName, name)
            else throw IllegalStateException("Type has no name and is not in the type index")
    }

    private fun resolveTransferable(
        type: ResolvedType.Transferable,
        index: TypeIndex,
        opContext: OperationTypeContext? = null,
        qualified: Boolean = false,
    ): TypeName {
        val binding = knownTransferableBindings[type.transferableName]
            ?: return JsonElement::class.asTypeName()
        if (!binding.isGeneric) return binding.type
        val typeArgs = if (type.typeArgs.isNotEmpty()) {
            type.typeArgs.map { resolveResolvedType(it, index, opContext, qualified) }
        } else {
            listOf(JsonElement::class.asTypeName())
        }
        return binding.type.parameterizedBy(typeArgs)
    }

    private fun isTransferableType(type: ResolvedType): Boolean = when (type) {
        is ResolvedType.Transferable -> true
        is ResolvedType.Nullable -> isTransferableType(type.inner)
        else -> false
    }

    private fun unwrapNullableTransferable(type: ResolvedType): ResolvedType.Transferable? = when (type) {
        is ResolvedType.Transferable -> type
        is ResolvedType.Nullable -> unwrapNullableTransferable(type.inner)
        else -> null
    }

    private fun isUnboundDirectResult(type: ResolvedType): Boolean =
        type is ResolvedType.Transferable && type.transferableName !in knownTransferableTags

    private fun transferableTypeArgModelName(type: ResolvedType): String? = when (type) {
        is ResolvedType.Record -> type.name
        is ResolvedType.Enum -> type.name
        is ResolvedType.Union -> type.name
        is ResolvedType.TypeReference -> type.name
        is ResolvedType.ListType -> transferableTypeArgModelName(type.elementType)
        is ResolvedType.MapType -> transferableTypeArgModelName(type.valueType)
        is ResolvedType.Nullable -> transferableTypeArgModelName(type.inner)
        else -> null
    }

    /** Names the operation, tag, platform, and generated type-arg models - never descriptor values. */
    private fun formatUnboundTransferable(operation: String, transferable: ResolvedType.Transferable): String {
        val models = transferable.typeArgs
            .mapNotNull { transferableTypeArgModelName(it) }
        val typeArgClause = when (models.size) {
            0 -> "no generated type-argument models"
            1 -> "type argument ${models[0]}"
            else -> "type arguments ${models.joinToString(", ")}"
        }
        val safeTag = transferable.transferableName.replace("\n", "\\n").replace("\r", "\\r")
        return "AWSBLOCKS-NATIVE-001: $operation returns unbound transferable " +
            "'$safeTag' on kotlin; generated UnknownTransferable with $typeArgClause."
    }

    /** Kotlin literal for [value]; %S would emit a trimMargin raw string that drops the CR from a CRLF tag. */
    private fun kotlinStringLiteral(value: String): String {
        val escaped = value
            .replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("$", "\\$")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
        return "\"$escaped\""
    }

    /** Annotates a property that is itself a (nullable) transferable with its serializer. */
    private fun addTransferableSerializerAnnotation(
        property: PropertySpec.Builder,
        transferable: ResolvedType.Transferable,
        index: TypeIndex,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext?,
    ) {
        transferableSerializerAnnotation(transferable, index, serializerRegistry, serializerContext)
            ?.let { property.addAnnotation(it) }
    }

    /**
     * The annotation that gives a transferable its serializer, on a property or a type usage.
     *
     * An `oidc/client` is `@Contextual`: hydrating it needs the calling `BlocksClient` and relay
     * target, so the operation decodes with `OidcClient.json`, which binds it. Without that it
     * still compiles, and decoding throws. Every other known tag gets a generated serializer
     * object; an unknown tag is a `JsonElement` and needs none.
     */
    private fun transferableSerializerAnnotation(
        transferable: ResolvedType.Transferable,
        index: TypeIndex,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext?,
    ): AnnotationSpec? {
        if (transferable.transferableName == "oidc/client") return AnnotationSpec.builder(ClassNames.contextual).build()
        val serializer = registerTransferableSerializer(transferable, index, serializerRegistry, serializerContext)
            ?: return null
        return AnnotationSpec.builder(ClassNames.serializable)
            .addMember("with = %T::class", serializer)
            .build()
    }

    /** Registers the generated serializer object for [transferable]; null for `oidc/client` and unknown tags. */
    private fun registerTransferableSerializer(
        transferable: ResolvedType.Transferable,
        index: TypeIndex,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext?,
    ): ClassName? {
        if (transferable.transferableName == "oidc/client") return null
        // A direct property of an unknown tag keeps its (throwing) serializer, as before; one
        // nested in a container resolves to `JsonElement`, which needs no serializer.
        val returnType = resolveTransferable(transferable, index, serializerContext, qualified = true)
        val payload = transferable.typeArgs.firstOrNull()
        val typeArgument = payload?.let {
            resolveResolvedType(it, index, serializerContext, qualified = true)
        }
        // A channel's messages decode through the payload's own serializers (registered first),
        // and with the channel's Json when the payload holds an OIDC client.
        val isChannel = transferable.transferableName == "realtime/channel"
        val payloadSerializer = payload?.takeIf { isChannel }
            ?.let { containerTransferableSerializer(it, index, serializerRegistry, serializerContext) }
        val serializerName = serializerRegistry.register(
            transferable.transferableName,
            returnType,
            typeArgument,
            payloadSerializer = payloadSerializer,
            payloadNeedsDecoderJson = isChannel && payload != null && containsOidcTransferable(payload),
        )
        return ClassName(packageName, serializerName)
    }

    /**
     * Gives every transferable inside a list, map or nullable of [type] its serializer, as an
     * annotation on that type usage (`List<@Serializable(with = …) RealtimeChannel<Note>>`).
     * [typeName] is [type] resolved to Kotlin; a model or union is left alone, since its own
     * serializer handles its fields. So is a channel's payload, recursively, when the channel is
     * annotated on a type usage (`RealtimeChannel<@Serializable(with = …) FileUploadHandle>`).
     */
    private fun annotateNestedTransferables(
        type: ResolvedType,
        typeName: TypeName,
        index: TypeIndex,
        serializerRegistry: TransferableSerializerRegistry,
        serializerContext: OperationTypeContext?,
    ): TypeName {
        fun annotateArgument(element: ResolvedType, position: Int): TypeName {
            val parameterized = typeName as? ParameterizedTypeName ?: return typeName
            val arguments = parameterized.typeArguments.toMutableList()
            arguments[position] = annotateNestedTransferables(
                element,
                arguments[position],
                index,
                serializerRegistry,
                serializerContext,
            )
            return parameterized.rawType.parameterizedBy(arguments)
                .copy(nullable = parameterized.isNullable, annotations = parameterized.annotations)
        }
        return when (type) {
            is ResolvedType.Transferable -> {
                if (type.transferableName !in knownTransferableTags) return typeName
                val annotation = transferableSerializerAnnotation(type, index, serializerRegistry, serializerContext)
                    ?: return typeName
                // The serialization plugin checks a type usage's type arguments even when it names a
                // serializer, so a channel payload holding transferables (`RealtimeChannel<FileUploadHandle>`)
                // is annotated too. Only the check reads these; the channel's serializer decodes the payload.
                val payload = type.typeArgs.firstOrNull()
                val withPayload = if (payload != null) annotateArgument(payload, 0) else typeName
                withPayload.copy(annotations = withPayload.annotations + annotation)
            }
            is ResolvedType.Nullable ->
                annotateNestedTransferables(type.inner, typeName, index, serializerRegistry, serializerContext)
            is ResolvedType.ListType -> annotateArgument(type.elementType, 0)
            is ResolvedType.MapType -> annotateArgument(type.valueType, 1)
            else -> typeName
        }
    }

    /**
     * The serializer for an operation result that holds a transferable inside lists, maps and
     * nullables only (`List<RealtimeChannel<Note>>`): `ListSerializer(RealtimeChannelNoteSerializer)`.
     * A reified decode can't find a serializer for the transferable there. Null for any other
     * result, which decodes as before: a model's own serializer handles its fields, and an
     * `oidc/client` resolves through `OidcClient.json`.
     */
    private fun containerTransferableSerializer(
        type: ResolvedType,
        index: TypeIndex,
        serializerRegistry: TransferableSerializerRegistry,
        opContext: OperationTypeContext?,
    ): CodeBlock? = when (type) {
        is ResolvedType.Transferable ->
            if (type.transferableName in knownTransferableTags) {
                registerTransferableSerializer(type, index, serializerRegistry, opContext)?.let { CodeBlock.of("%T", it) }
            } else null
        is ResolvedType.Nullable -> containerTransferableSerializer(type.inner, index, serializerRegistry, opContext)
            ?.let { CodeBlock.of("%L.%M", it, MemberNames.nullable) }
        is ResolvedType.ListType -> containerTransferableSerializer(type.elementType, index, serializerRegistry, opContext)
            ?.let { CodeBlock.of("%M(%L)", MemberNames.listSerializer, it) }
        is ResolvedType.MapType -> containerTransferableSerializer(type.valueType, index, serializerRegistry, opContext)
            ?.let {
                CodeBlock.of(
                    "%M(%T.%M(), %L)",
                    MemberNames.mapSerializer,
                    String::class.asTypeName(),
                    MemberNames.builtinSerializer,
                    it,
                )
            }
        else -> null
    }

    private fun namedType(type: ResolvedType): String? = when (type) {
        is ResolvedType.Record -> type.name
        is ResolvedType.Enum -> type.name
        is ResolvedType.Union -> type.name
        is ResolvedType.TypeReference -> type.name
        is ResolvedType.TupleType -> type.name
        else -> null
    }

    private class TransferableSerializerRegistry {
        private data class Key(
            val transferableName: String,
            val returnType: TypeName,
            val typeArgument: TypeName?,
        )

        private val entriesByKey = LinkedHashMap<Key, TransferableSerializerGenerator.TransferableEntry>()
        private val allocatedNames = mutableSetOf<String>()

        val entries: Collection<TransferableSerializerGenerator.TransferableEntry>
            get() = entriesByKey.values

        /**
         * The serializer object for a transferable of [returnType]. The payload settings derive from
         * the type argument, so one key always carries the same ones.
         */
        fun register(
            transferableName: String,
            returnType: TypeName,
            typeArgument: TypeName?,
            payloadSerializer: CodeBlock? = null,
            payloadNeedsDecoderJson: Boolean = false,
        ): String {
            val key = Key(transferableName, returnType, typeArgument)
            return entriesByKey.getOrPut(key) {
                TransferableSerializerGenerator.TransferableEntry(
                    transferableName = transferableName,
                    serializerName = allocateName(transferableName, typeArgument),
                    returnType = returnType,
                    typeArgument = typeArgument,
                    payloadSerializer = payloadSerializer,
                    payloadNeedsDecoderJson = payloadNeedsDecoderJson,
                )
            }.serializerName
        }

        private fun allocateName(transferableName: String, typeArgument: TypeName?): String {
            val base = knownTransferableBindings[transferableName]?.type?.simpleName ?: "Unknown"
            val suffix = typeArgument?.let(::typeNameSegment).orEmpty()
            val candidate = "${base}${suffix}Serializer"
            if (allocatedNames.add(candidate)) return candidate

            var duplicate = 2
            while (!allocatedNames.add("${candidate}${duplicate}")) duplicate++
            return "${candidate}${duplicate}"
        }

        private fun typeNameSegment(type: TypeName): String = when (type) {
            is ClassName -> type.simpleNames.joinToString("")
            is ParameterizedTypeName -> typeNameSegment(type.rawType) + type.typeArguments.joinToString("") { typeNameSegment(it) }
            else -> type.toString().replace(Regex("[^A-Za-z0-9]"), "").ifEmpty { "JsonElement" }
        } + if (type.isNullable) "Nullable" else ""
    }

    private fun mapPrimitive(kind: PrimitiveKind): TypeName = when (kind) {
        PrimitiveKind.STRING -> String::class.asTypeName()
        PrimitiveKind.BOOLEAN -> Boolean::class.asTypeName()
        PrimitiveKind.INTEGER -> Int::class.asTypeName()
        PrimitiveKind.NUMBER -> Double::class.asTypeName()
        PrimitiveKind.VOID -> Unit::class.asTypeName()
        // `unknown` is any JSON value. `JsonElement` has a built-in serializer, so it works as a
        // property of a `@Serializable` class, a map value, a list element, a parameter and a result
        // (`Any` has no serializer and fails to compile). Swift uses `JSONValue`, Dart `dynamic`.
        PrimitiveKind.UNKNOWN -> ClassNames.jsonElement
    }

    private fun mapFormattedType(format: FormatKind): TypeName = when (format) {
        FormatKind.DATE_TIME -> instantClass
        FormatKind.DATE -> localDateClass
        FormatKind.TIME -> localTimeClass
        FormatKind.UUID -> uuidClass
    }

    private fun findClassNameByTypeName(name: String, index: TypeIndex): ClassName? {
        for ((_, entry) in index.dataClasses) {
            if (entry.typeDef.name == name) return entry.className
        }
        for ((_, entry) in index.enumClasses) {
            if (entry.typeDef.name == name) return entry.className
        }
        for ((_, entry) in index.sealedClasses) {
            if (entry.typeDef.name == name) return entry.className
        }
        return null
    }

    // ── toJson code generation helpers ─────────────────────────────────

    /**
     * Generates a KotlinPoet [CodeBlock] for serializing a value expression of a given [ResolvedType] to JsonElement.
     *
     * @param type The resolved type to serialize from
     * @param expr The expression string holding the value to serialize
     * @param index The type index for resolving type references
     * @param json The [kotlinx.serialization.json.Json] that encodes models, enums and unions
     */
    private fun generateToJsonExpression(
        type: ResolvedType,
        expr: String,
        index: TypeIndex,
        json: CodeBlock = CodeBlock.of("%T", ClassNames.blocksJson),
    ): CodeBlock {
        return when (type) {
            is ResolvedType.Primitive -> when (type.kind) {
                PrimitiveKind.STRING -> CodeBlock.of("%L", expr)
                PrimitiveKind.BOOLEAN -> CodeBlock.of("%L", expr)
                PrimitiveKind.INTEGER -> CodeBlock.of("%L", expr)
                PrimitiveKind.NUMBER -> CodeBlock.of("%L", expr)
                PrimitiveKind.UNKNOWN -> CodeBlock.of("%L", expr)
                PrimitiveKind.VOID -> CodeBlock.of("")
            }

            is ResolvedType.Record, is ResolvedType.Enum, is ResolvedType.Union -> {
                CodeBlock.of("%L.%M(%L)", json, MemberNames.encode, expr)
            }

            is ResolvedType.ListType -> {
                val arrayBody = generateJsonArrayBody(type, expr, index, json)
                CodeBlock.of("%M { %L }", MemberNames.buildJsonArray, arrayBody)
            }

            is ResolvedType.Nullable -> {
                // A known transferable's `toJson()` needs a non-null receiver; any other value
                // encodes as before (a model's encode takes a nullable).
                val transferable = type.inner as? ResolvedType.Transferable
                if (transferable != null && transferable.transferableName in knownTransferableTags) {
                    CodeBlock.of("%L?.toJson() ?: %T", expr, ClassNames.jsonNull)
                } else if (transferable != null) {
                    CodeBlock.of("%L ?: %T", expr, ClassNames.jsonNull)
                } else {
                    generateToJsonExpression(type.inner, expr, index, json)
                }
            }

            is ResolvedType.TypeReference -> {
                val resolvedType = resolveTypeReference(type.name, index)
                if (resolvedType != null) {
                    generateToJsonExpression(resolvedType, expr, index, json)
                } else {
                    CodeBlock.of("%L.%M(%L)", json, MemberNames.encode, expr)
                }
            }

            is ResolvedType.FormattedType -> {
                CodeBlock.of("%T(%L.toString())", ClassNames.jsonPrimitive, expr)
            }
            is ResolvedType.MapType -> {
                // `put(key, JsonElement?)` has no overload, so a nullable `unknown` value becomes JsonNull.
                val valueToJson = if (type.valueType.isNullableUnknown()) {
                    CodeBlock.of("it.value ?: %T", ClassNames.jsonNull)
                } else {
                    generateToJsonExpression(type.valueType, "it.value", index, json)
                }
                CodeBlock.of("%M { %L.forEach { %M(it.key, %L) } }", MemberNames.buildJsonObject, expr, MemberNames.put, valueToJson)
            }
            is ResolvedType.TupleType -> TODO("TupleType toJson not yet implemented")

            // Sent as its `{ "__blocks": … }` descriptor, the shape the server's `toJSON()` sends. An
            // unbound tag is a `JsonElement` (the descriptor itself), sent as is.
            is ResolvedType.Transferable -> if (type.transferableName in knownTransferableTags) {
                CodeBlock.of("%L.toJson()", expr)
            } else {
                CodeBlock.of("%L", expr)
            }
        }
    }

    /**
     * Generates the body of a `putJsonArray` / `buildJsonArray` lambda for a list type.
     * Uses `addAll(expr)` for simple primitive collections, or `expr.forEach { add(...) }` for complex types.
     */
    private fun generateJsonArrayBody(listType: ResolvedType.ListType, expr: String, index: TypeIndex, json: CodeBlock): CodeBlock {
        val elementType = listType.elementType
        return when {
            elementType is ResolvedType.Primitive && elementType.kind in listOf(
                PrimitiveKind.STRING, PrimitiveKind.BOOLEAN, PrimitiveKind.INTEGER, PrimitiveKind.NUMBER
            ) -> CodeBlock.of("%M(%L)", MemberNames.addAll, expr)

            // `add(JsonElement?)` has no overload, so a null `unknown` element becomes JsonNull.
            elementType.isNullableUnknown() -> {
                CodeBlock.of("%L.forEach { %M(it ?: %T) }", expr, MemberNames.add, ClassNames.jsonNull)
            }

            elementType is ResolvedType.Nullable && elementType.inner is ResolvedType.Primitive -> {
                CodeBlock.of("%L.forEach { %M(it) }", expr, MemberNames.add)
            }

            else -> {
                val elementExpr = generateToJsonElementExpression(elementType, "it", index, json)
                CodeBlock.of("%L.forEach { %M(%L) }", expr, MemberNames.add, elementExpr)
            }
        }
    }

    /** True for `unknown | null` — generated as `JsonElement?`. */
    private fun ResolvedType.isNullableUnknown(): Boolean =
        this is ResolvedType.Nullable && inner.let { it is ResolvedType.Primitive && it.kind == PrimitiveKind.UNKNOWN }

    /**
     * Like [generateToJsonExpression], but guarantees the result is a JsonElement.
     * Primitives are wrapped in JsonPrimitive; complex types already return JsonElement.
     * Use this when the expression must be a JsonElement (e.g. inside JsonArray).
     */
    private fun generateToJsonElementExpression(type: ResolvedType, expr: String, index: TypeIndex, json: CodeBlock): CodeBlock {
        val jsonPrimitiveClass = ClassNames.jsonPrimitive
        return when (type) {
            is ResolvedType.Primitive -> when (type.kind) {
                PrimitiveKind.STRING, PrimitiveKind.BOOLEAN, PrimitiveKind.INTEGER, PrimitiveKind.NUMBER ->
                    CodeBlock.of("%T(%L)", jsonPrimitiveClass, expr)
                else -> CodeBlock.of("%L", expr)
            }
            is ResolvedType.Nullable -> {
                val innerExpr = generateToJsonElementExpression(type.inner, expr, index, json)
                val jsonNull = ClassNames.jsonNull
                CodeBlock.of("if (%L != null) %L else %T", expr, innerExpr, jsonNull)
            }
            else -> generateToJsonExpression(type, expr, index, json)
        }
    }

    /**
     * Generates a KotlinPoet [CodeBlock] for hydrating a transferable type from a JsonElement descriptor.
     *
     * @param type The transferable type to hydrate
     * @param expr The expression string holding the JsonElement descriptor
     * @param index The type index for resolving type arguments
     * @param serializerRegistry Registers the serializers a channel's payload decodes through
     * @param payloadJson The [kotlinx.serialization.json.Json] a channel decodes its messages with
     * @param client How the method reads the API's [ClassNames.blocksClient] (`client`, or `this.client`)
     */
    private fun generateTransferableFromJson(
        type: ResolvedType.Transferable,
        expr: String,
        index: TypeIndex,
        opContext: OperationTypeContext?,
        serializerRegistry: TransferableSerializerRegistry,
        payloadJson: CodeBlock,
        client: String = "client",
    ): CodeBlock {
        return when (type.transferableName) {
            "realtime/channel" -> {
                if (type.typeArgs.isNotEmpty()) {
                    val payload = type.typeArgs.first()
                    val payloadDecode = channelPayloadDecode(
                        resolveResolvedType(payload, index, opContext),
                        payloadJson,
                        containerTransferableSerializer(payload, index, serializerRegistry, opContext),
                    )
                    CodeBlock.of("%T.fromJson(%L) { %L }", ClassNames.realtimeChannel, expr, payloadDecode)
                } else {
                    CodeBlock.of(
                        "%T.fromJson(%L) { it }",
                        ClassNames.realtimeChannel, expr
                    )
                }
            }

            "file-bucket/download" -> {
                CodeBlock.of("%T.fromJson(%L)", ClassNames.fileDownloadHandle, expr)
            }

            "file-bucket/upload" -> {
                CodeBlock.of("%T.fromJson(%L)", ClassNames.fileUploadHandle, expr)
            }

            "oidc/client" -> {
                CodeBlock.of("%T.fromJson(%L, %L, %S)", ClassNames.oidcClient, expr, client, relayTo ?: "")
            }

            else -> {
                throw UnsupportedOperationException("Unknown transferable: ${type.transferableName}")
            }
        }
    }

    /**
     * Resolves a [TypeReference] name to its concrete [ResolvedType] by looking up the type definition in the index.
     * Returns null if the type cannot be found.
     */
    private fun resolveTypeReference(name: String, index: TypeIndex): ResolvedType? {
        for ((_, entry) in index.dataClasses) {
            if (entry.typeDef.name == name) return entry.typeDef.type
        }
        for ((_, entry) in index.enumClasses) {
            if (entry.typeDef.name == name) return entry.typeDef.type
        }
        for ((_, entry) in index.sealedClasses) {
            if (entry.typeDef.name == name) return entry.typeDef.type
        }
        return null
    }

    // ── Naming utilities ──────────────────────────────────────────────

    /**
     * How generated code reads the parameter or property [name] in an expression: as written when
     * it is a plain identifier, a soft or modifier keyword included (`value`, `data`), and escaped
     * with backticks otherwise (a hard keyword `class`, `content-type`, `a${'$'}b`). Declarations are
     * escaped by KotlinPoet; a read written with `%L` was not, so a parameter `class` didn't parse.
     */
    private fun expressionReference(name: String): String {
        val plain = (name.first().isLetter() || name.first() == '_') &&
            name.all { it.isLetterOrDigit() || it == '_' } &&
            !name.all { it == '_' }
        return if (plain && !isKotlinKeyword(name)) name else CodeBlock.of("%N", name).toString()
    }

    private fun isKotlinKeyword(name: String): Boolean {
        return name in setOf(
            "as", "break", "class", "continue", "do", "else", "false", "for",
            "fun", "if", "in", "interface", "is", "null", "object", "package",
            "return", "super", "this", "throw", "true", "try", "typealias",
            "typeof", "val", "var", "when", "while",
        )
    }

    companion object {
        fun toPascalCase(name: String): String = NamingUtils.toPascalCase(name)
        fun toCamelCase(name: String): String = NamingUtils.toCamelCase(name)

        /**
         * The generator's own top-level declarations and file names in the package: the `Servers`
         * object and the `Types.kt` / `Serializers.kt` / `Servers.kt` files. An API class named
         * like one would shadow it, or be written over by it.
         */
        private val GENERATED_TOP_LEVEL_NAMES = setOf("Servers", "Types", "Serializers")

        /**
         * The objects a method body reads as a receiver or a value (`BlocksJson.encodeToJsonElement`,
         * `BlocksRequest.nextId()`, `?: JsonNull`). A parameter of that name would shadow one inside
         * the method, so a file with such a parameter imports the object under an alias. A class only
         * called (`JsonPrimitive(…)`) can't be shadowed by a parameter: Kotlin moves on to the class.
         */
        private val EXPRESSION_RECEIVERS = listOf(
            ClassNames.blocksJson,
            ClassNames.blocksRequest,
            ClassNames.jsonNull,
            ClassNames.oidcClient,
            ClassNames.realtimeChannel,
            ClassNames.fileDownloadHandle,
            ClassNames.fileUploadHandle,
            ClassNames.unknownTransferable,
        )
    }
}
