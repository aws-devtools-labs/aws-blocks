package com.aws.blocks.kotlin.generator

import com.aws.blocks.kotlin.NamingUtils
import com.aws.blocks.kotlin.model.ApiNamespace
import com.aws.blocks.kotlin.model.CodegenModel
import com.aws.blocks.kotlin.model.Constraints
import com.aws.blocks.kotlin.model.DiscriminatorInfo
import com.aws.blocks.kotlin.model.DiscriminatorType
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

class KotlinCodeGenerator(
    private val packageName: String,
    private val internalVisibility: Boolean = false,
    private val redirectUrl: String? = null,
) {

    /** Visibility modifier applied to all top-level generated types. */
    private val apiModifiers: List<KModifier> =
        if (internalVisibility) listOf(KModifier.INTERNAL) else emptyList()

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

        if (redirectUrl == null && model.hasOidcTransferable()) {
            warnings.add(
                "Your Blocks spec includes OIDC auth, but no redirect URL is configured. " +
                "OIDC operations will not be available. To enable OIDC, add to your build.gradle.kts:\n\n" +
                "  awsBlocks {\n" +
                "      oidc {\n" +
                "          redirectUrl = \"com.yourcompany.yourapp://auth/callback\"\n" +
                "      }\n" +
                "  }"
            )
        }

        // Emit shared Types.kt
        val typesFile = generateTypesFile(index)
        if (typesFile != null) files.add(typesFile)

        // Emit Serializers.kt for transferable types
        val transferableEntries = collectTransferableEntries(model, index)
        if (transferableEntries.isNotEmpty()) {
            val serializerGenerator = TransferableSerializerGenerator(packageName)
            val serializersFile = FileSpec.builder(packageName, "Serializers")
            for (entry in transferableEntries) {
                serializersFile.addType(serializerGenerator.generateSerializerObject(entry))
            }
            files.add(serializersFile.build())
        }

        // Emit Servers.kt
        if (model.servers.isNotEmpty()) {
            files.add(generateServersFile(model.servers))
        }

        // Emit per-API-group files (interface + impl)
        for (group in model.apiNamespaces) {
            files.add(generateApiGroupFile(group, index, model.servers, model.endpoint))
        }

        return GeneratorResult(files, warnings)
    }

    private fun CodegenModel.hasOidcTransferable(): Boolean =
        apiNamespaces.any { ns -> ns.operations.any { containsOidcTransferable(it.result.type) } }

    private fun containsOidcTransferable(type: ResolvedType): Boolean = when (type) {
        is ResolvedType.Transferable -> type.transferableName == "oidc/client"
        is ResolvedType.Nullable -> containsOidcTransferable(type.inner)
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
                // Schema child: nest under parent schema class
                className = ClassName(packageName, typeDef.parentSchema, typeDef.name)
                shortName = typeDef.name
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

    private fun generateTypesFile(index: TypeIndex): FileSpec? {
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
            val spec = generateSealedClass(entry.shortName, unionType, index)
            routeType(entry.typeDef, spec)
        }

        // Emit data classes, injecting schema-child types as nested types
        for ((_, entry) in index.dataClasses) {
            val recordType = entry.typeDef.type as ResolvedType.Record
            var spec = generateDataClass(entry.shortName, recordType, index)

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
    ): TypeSpec {
        val constructor = FunSpec.constructorBuilder()
        val classBuilder = TypeSpec
            .classBuilder(name)
            .addModifiers(KModifier.DATA)
            .addAnnotation(ClassNames.serializable)

        val kdoc = buildDataClassKdoc(record.description, record.fields)
        if (kdoc.isNotEmpty()) {
            classBuilder.addKdoc("%L", kdoc)
        }

        for (field in record.fields) {
            val kotlinType = resolveResolvedType(field.type, index, opContext)
            val isOptional = !field.required
            val finalType = if (isOptional) kotlinType.copy(nullable = true) else kotlinType

            val paramBuilder = ParameterSpec.builder(field.name, finalType)
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
                .builder(field.name, finalType)
                .initializer(field.name)
            if (isKotlinKeyword(field.name)) {
                propBuilder.addAnnotation(
                    AnnotationSpec.builder(ClassNames.serialName)
                        .addMember("%S", field.name)
                        .build()
                )
            }
            if (isTransferableType(field.type)) {
                val transferableType = unwrapNullableTransferable(field.type)
                if (transferableType != null) {
                    val serializerName = getTransferableSerializerName(transferableType)
                    propBuilder.addAnnotation(
                        AnnotationSpec.builder(ClassNames.serializable)
                            .addMember("with = %T::class", ClassName(packageName, serializerName))
                            .build()
                    )
                }
            }
            classBuilder.addProperty(propBuilder.build())
        }

        // Add attributes field for open-shape records (T & Record<string, V>)
        if (record.additionalPropertiesType != null) {
            val valueType = resolveResolvedType(record.additionalPropertiesType, index, opContext)
            val mapType = Map::class.asTypeName().parameterizedBy(String::class.asTypeName(), valueType)
            val paramBuilder = ParameterSpec.builder("attributes", mapType)
                .defaultValue("emptyMap()")
            constructor.addParameter(paramBuilder.build())
            classBuilder.addProperty(
                PropertySpec.builder("attributes", mapType)
                    .initializer("attributes")
                    .build(),
            )
        }

        classBuilder.primaryConstructor(constructor.build())

        val initBlock = generateInitValidation(record.fields)
        if (initBlock != null) {
            classBuilder.addInitializerBlock(initBlock)
        }

        return classBuilder.build()
    }

    private fun buildDataClassKdoc(
        description: String?,
        fields: List<ResolvedField>,
    ): String {
        val parts = mutableListOf<String>()

        if (description != null) {
            parts.add(description)
        }

        val propertyTags = fields
            .filter { it.description != null }
            .map { "@property ${it.name} ${it.description}" }

        if (propertyTags.isNotEmpty()) {
            if (parts.isNotEmpty()) {
                parts.add("") // blank line between summary and tags
            }
            parts.addAll(propertyTags)
        }

        return parts.joinToString("\n")
    }

    // ── Init block validation generation ─────────────────────────────────

    private fun generateInitValidation(fields: List<ResolvedField>): CodeBlock? {
        val statements = mutableListOf<CodeBlock>()
        for (field in fields) {
            val fieldStatements = generateFieldValidation(field.name, field.type, field.constraints, !field.required)
            statements.addAll(fieldStatements)
        }
        if (statements.isEmpty()) return null
        val builder = CodeBlock.builder()
        for (stmt in statements) {
            builder.add(stmt)
        }
        return builder.build()
    }

    private fun generateFieldValidation(
        fieldName: String,
        type: ResolvedType,
        constraints: Constraints,
        isOptional: Boolean,
    ): List<CodeBlock> {
        val stmts = mutableListOf<CodeBlock>()

        // String constraints (including format-based validation for non-type-mapped formats)
        if (type is ResolvedType.Primitive && type.kind == PrimitiveKind.STRING) {
            constraints.minLength?.let { min ->
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L.length >= %L) { \"%L must be at least %L characters\" }\n",
                        if (isOptional) "it" else fieldName, min, fieldName, min)))
            }
            constraints.maxLength?.let { max ->
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L.length <= %L) { \"%L must be at most %L characters\" }\n",
                        if (isOptional) "it" else fieldName, max, fieldName, max)))
            }
            constraints.pattern?.let { pattern ->
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L.matches(Regex(%S))) { \"%L must match pattern %L\" }\n",
                        if (isOptional) "it" else fieldName, pattern, fieldName, pattern)))
            }
            constraints.format?.let { format ->
                val validationBlock = generateFormatValidation(fieldName, format, isOptional)
                if (validationBlock != null) stmts.add(validationBlock)
            }
        }

        // Number constraints
        if (type is ResolvedType.Primitive && (type.kind == PrimitiveKind.NUMBER || type.kind == PrimitiveKind.INTEGER)) {
            constraints.minimum?.let { min ->
                val minVal = if (type.kind == PrimitiveKind.INTEGER) min.toInt().toString() else min.toString()
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L >= %L) { \"%L must be >= %L\" }\n",
                        if (isOptional) "it" else fieldName, minVal, fieldName, minVal)))
            }
            constraints.maximum?.let { max ->
                val maxVal = if (type.kind == PrimitiveKind.INTEGER) max.toInt().toString() else max.toString()
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L <= %L) { \"%L must be <= %L\" }\n",
                        if (isOptional) "it" else fieldName, maxVal, fieldName, maxVal)))
            }
            constraints.exclusiveMinimum?.let { min ->
                val minVal = if (type.kind == PrimitiveKind.INTEGER) min.toInt().toString() else min.toString()
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L > %L) { \"%L must be > %L\" }\n",
                        if (isOptional) "it" else fieldName, minVal, fieldName, minVal)))
            }
            constraints.exclusiveMaximum?.let { max ->
                val maxVal = if (type.kind == PrimitiveKind.INTEGER) max.toInt().toString() else max.toString()
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L < %L) { \"%L must be < %L\" }\n",
                        if (isOptional) "it" else fieldName, maxVal, fieldName, maxVal)))
            }
            constraints.multipleOf?.let { mult ->
                val multVal = if (type.kind == PrimitiveKind.INTEGER) mult.toInt().toString() else mult.toString()
                val zeroVal = if (type.kind == PrimitiveKind.INTEGER) "0" else "0.0"
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L %% %L == %L) { \"%L must be a multiple of %L\" }\n",
                        if (isOptional) "it" else fieldName, multVal, zeroVal, fieldName, multVal)))
            }
        }

        // List/array constraints
        if (type is ResolvedType.ListType) {
            type.constraints.minItems?.let { min ->
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L.size >= %L) { \"%L must have at least %L items\" }\n",
                        if (isOptional) "it" else fieldName, min, fieldName, min)))
            }
            type.constraints.maxItems?.let { max ->
                stmts.add(wrapOptional(fieldName, isOptional,
                    CodeBlock.of("require(%L.size <= %L) { \"%L must have at most %L items\" }\n",
                        if (isOptional) "it" else fieldName, max, fieldName, max)))
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

    private fun generateFormatValidation(fieldName: String, format: String, isOptional: Boolean): CodeBlock? {
        val ref = if (isOptional) "it" else fieldName
        return when (format) {
            "email" -> wrapOptional(fieldName, isOptional,
                CodeBlock.of("require(%L.contains(%S) && %L.contains(%S)) { \"%L must be a valid email address\" }\n",
                    ref, "@", ref, ".", fieldName))
            "uri" -> wrapOptional(fieldName, isOptional,
                CodeBlock.of("require(%L.startsWith(%S) || %L.startsWith(%S)) { \"%L must be a valid URI\" }\n",
                    ref, "http://", ref, "https://", fieldName))
            "ipv4" -> wrapOptional(fieldName, isOptional,
                CodeBlock.of("require(%L.matches(Regex(%S))) { \"%L must be a valid IPv4 address\" }\n",
                    ref, """^(\d{1,3}\.){3}\d{1,3}$""", fieldName))
            "ipv6" -> wrapOptional(fieldName, isOptional,
                CodeBlock.of("require(%L.contains(%S)) { \"%L must be a valid IPv6 address\" }\n",
                    ref, ":", fieldName))
            else -> null
        }
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

        for (literal in values) {
            val entryName = toPascalCase(literal)
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
    ): TypeSpec {
        val sealedBuilder = TypeSpec.classBuilder(name)
            .addModifiers(KModifier.SEALED)

        val discriminator = union.discriminator
        if (discriminator != null && discriminator.type == DiscriminatorType.BOOLEAN) {
            val serializerName = "${name}Serializer"
            sealedBuilder.addAnnotation(
                AnnotationSpec.builder(ClassNames.serializable)
                    .addMember("with = %T::class", ClassName("", name, serializerName))
                    .build()
            )
            sealedBuilder.addType(generateBooleanDiscriminatorSerializer(name, serializerName, discriminator, union.variants))
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
                if (opContext != null) ctx.typeMap.putAll(opContext.typeMap)
                for (nested in variant.nestedTypes) {
                    ctx.typeMap[nested.name] = ClassName("", variant.name, nested.name)
                }
                ctx
            } else opContext
            val variantSpec = generateSealedVariant(name, variant, union.discriminator, index, variantContext)
            sealedBuilder.addType(variantSpec)
        }

        return sealedBuilder.build()
    }

    private fun generateBooleanDiscriminatorSerializer(
        sealedClassName: String,
        serializerName: String,
        discriminator: DiscriminatorInfo,
        variants: List<UnionVariant>,
    ): TypeSpec {
        val sealedClass = ClassName("", sealedClassName)
        val jsonElementClass = ClassName("kotlinx.serialization.json", "JsonElement")
        val jsonObjectMember = MemberName("kotlinx.serialization.json", "jsonObject")
        val jsonPrimitiveMember = MemberName("kotlinx.serialization.json", "jsonPrimitive")
        val booleanMember = MemberName("kotlinx.serialization.json", "boolean")

        val selectFun = FunSpec.builder("selectDeserializer")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("element", jsonElementClass)
            .returns(ClassNames.deserializationStrategy.parameterizedBy(sealedClass))

        val fieldName = discriminator.fieldName
        selectFun.addStatement(
            "val disc = element.%M[%S]?.%M?.%M",
            jsonObjectMember, fieldName, jsonPrimitiveMember, booleanMember
        )

        selectFun.beginControlFlow("return when (disc)")
        for (variant in variants) {
            val discValue = variant.discriminatorValue ?: continue
            val boolLiteral = if (discValue == "true") "true" else "false"
            selectFun.addStatement("$boolLiteral -> %T.serializer()", ClassName("", sealedClassName, variant.name))
        }
        selectFun.addStatement("else -> error(%S)", "Unknown $fieldName value: \$disc")
        selectFun.endControlFlow()

        return TypeSpec.objectBuilder(serializerName)
            .superclass(ClassNames.jsonContentPolymorphicSerializer.parameterizedBy(sealedClass))
            .addSuperclassConstructorParameter("%T::class", sealedClass)
            .addFunction(selectFun.build())
            .build()
    }

    private fun generateSealedVariant(
        sealedName: String,
        variant: UnionVariant,
        discriminator: DiscriminatorInfo?,
        index: TypeIndex,
        opContext: OperationTypeContext? = null,
    ): TypeSpec {
        val sealedClassName = ClassName("", sealedName)

        // Compute the discriminator wire value for this variant
        val discValue = variant.discriminatorValue
            ?: discriminator?.variants?.entries?.find { it.value == variant.name }?.key
            ?: variant.name.lowercase()

        if (variant.fields.isEmpty() && variant.embeddedUnion == null && variant.additionalPropertiesType == null) {
            val objectBuilder = TypeSpec.objectBuilder(variant.name)
                .addModifiers(KModifier.DATA)
                .superclass(sealedClassName)
                .addAnnotation(ClassNames.serializable)
                .addAnnotation(
                    AnnotationSpec.builder(ClassNames.serialName)
                        .addMember("%S", discValue)
                        .build()
                )
            return objectBuilder.build()
        }

        val constructor = FunSpec.constructorBuilder()
        val variantBuilder = TypeSpec.classBuilder(variant.name)
            .addModifiers(KModifier.DATA)
            .superclass(sealedClassName)
            .addAnnotation(ClassNames.serializable)
            .addAnnotation(
                AnnotationSpec.builder(ClassNames.serialName)
                    .addMember("%S", discValue)
                    .build()
            )

        for (field in variant.fields) {
            val kotlinType = resolveResolvedType(field.type, index, opContext)
            val isOptional = !field.required
            val finalType = if (isOptional) kotlinType.copy(nullable = true) else kotlinType

            val paramBuilder = ParameterSpec.builder(field.name, finalType)
            if (isOptional) paramBuilder.defaultValue("null")
            constructor.addParameter(paramBuilder.build())

            val propBuilder = PropertySpec.builder(field.name, finalType)
                .initializer(field.name)
            if (isKotlinKeyword(field.name)) {
                propBuilder.addAnnotation(
                    AnnotationSpec.builder(ClassNames.serialName)
                        .addMember("%S", field.name)
                        .build()
                )
            }
            variantBuilder.addProperty(propBuilder.build())
        }

        // Add attributes field for open-shape variants
        if (variant.additionalPropertiesType != null) {
            val valueType = resolveResolvedType(variant.additionalPropertiesType, index, opContext)
            val mapType = Map::class.asTypeName().parameterizedBy(String::class.asTypeName(), valueType)
            val paramBuilder = ParameterSpec.builder("attributes", mapType)
                .defaultValue("emptyMap()")
            constructor.addParameter(paramBuilder.build())
            variantBuilder.addProperty(
                PropertySpec.builder("attributes", mapType)
                    .initializer("attributes")
                    .build(),
            )
        }

        // Add embedded union field if present
        if (variant.embeddedUnion != null) {
            val embeddedName = variant.embeddedUnion.name
            val embeddedClassName = ClassName("", embeddedName)
            val discFieldName = variant.embeddedUnion.discriminator?.fieldName ?: "variant"

            constructor.addParameter(
                ParameterSpec.builder(discFieldName, embeddedClassName).build()
            )
            variantBuilder.addProperty(
                PropertySpec.builder(discFieldName, embeddedClassName)
                    .initializer(discFieldName)
                    .build(),
            )

            // Generate the embedded sealed class and nest it inside the variant
            val embeddedSpec = generateSealedClass(embeddedName, variant.embeddedUnion, index, opContext)
            variantBuilder.addType(embeddedSpec)
        }

        variantBuilder.primaryConstructor(constructor.build())

        val initBlock = generateInitValidation(variant.fields)
        if (initBlock != null) {
            variantBuilder.addInitializerBlock(initBlock)
        }

        // Add variant-scoped nested types (e.g. enums for array item fields)
        for (nested in variant.nestedTypes) {
            variantBuilder.addType(generateNestedTypeSpec(nested, index))
        }

        return variantBuilder.build()
    }

    // ── Servers.kt generation ─────────────────────────────────────────

    private fun generateServersFile(servers: List<ServerDefinition>): FileSpec {
        val serverFileBuilder = FileSpec.builder(packageName, "Servers")

        // Servers object using BlocksServer from the runtime
        val serversObjectBuilder = TypeSpec.objectBuilder("Servers")
        for (entry in servers) {
            serversObjectBuilder.addProperty(
                PropertySpec
                    .builder(toCamelCase(entry.name), blocksServerClass)
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
        index: TypeIndex,
        servers: List<ServerDefinition>,
        endpoint: String?,
    ): FileSpec {
        val className = toPascalCase(group.name)
        val builder = FileSpec.builder(packageName, className)

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

        builder.addType(generateApiClass(group, className, index, servers, endpoint).withApiVisibility())

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
    private class OperationTypeContext(
        val operationObjectName: String,
    ) {
        /** Maps short type name → relative ClassName (e.g. "Result" → ClassName("", "Echo", "Result")) */
        val typeMap = LinkedHashMap<String, ClassName>()
    }

    private fun generateApiClass(
        namespace: ApiNamespace,
        className: String,
        index: TypeIndex,
        servers: List<ServerDefinition>,
        endpoint: String?,
    ): TypeSpec {
        val clientInitializer = if (endpoint != null) {
            com.squareup.kotlinpoet.CodeBlock.of("%T(%T(server.name, server.url.toString() + %S))", ClassNames.blocksClient, blocksServerClass, endpoint)
        } else {
            com.squareup.kotlinpoet.CodeBlock.of("%T(server)", ClassNames.blocksClient)
        }

        val constructorBuilder = FunSpec.constructorBuilder()
        if (servers.isNotEmpty()) {
            val serversClassName = ClassName(packageName, "Servers")
            val defaultProperty = toCamelCase(servers[0].name)
            constructorBuilder.addParameter(
                ParameterSpec.builder("server", blocksServerClass)
                    .defaultValue("%T.%N", serversClassName, defaultProperty)
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

        for (operation in namespace.operations) {
            if (redirectUrl == null && containsOidcTransferable(operation.result.type)) {
                classBuilder.addFunction(generateOidcStubMethod(operation))
            } else {
                val opContext = buildOperationTypeContext(operation)
                classBuilder.addFunction(generateImplMethod(operation, namespace.name, index, opContext))
            }
        }

        // Add nested operation objects for operations that have nested types
        for (operation in namespace.operations) {
            if (operation.nestedTypes.isNotEmpty()) {
                classBuilder.addType(generateOperationObject(operation, index))
            }
        }

        return classBuilder.build()
    }

    /**
     * Builds a type context for an operation, mapping short type names to their
     * relative ClassName paths within the operation object.
     */
    private fun buildOperationTypeContext(operation: Operation): OperationTypeContext? {
        if (operation.nestedTypes.isEmpty()) return null
        val opObjectName = toPascalCase(operation.name)
        val context = OperationTypeContext(opObjectName)

        fun walkNodes(nodes: List<NestedTypeNode>, parentPath: List<String>) {
            for (node in nodes) {
                val currentPath = parentPath + node.name
                context.typeMap[node.name] = ClassName("", currentPath)
                if (node.children.isNotEmpty()) {
                    walkNodes(node.children, currentPath)
                }
                // Walk into variant-scoped nested types for union nodes
                val type = node.type
                if (type is ResolvedType.Union) {
                    for (variant in type.variants) {
                        if (variant.nestedTypes.isNotEmpty()) {
                            val variantPath = currentPath + variant.name
                            walkNodes(variant.nestedTypes, variantPath)
                        }
                    }
                }
            }
        }

        walkNodes(operation.nestedTypes, listOf(opObjectName))
        return context
    }

    /**
     * Generates an `object OperationName { ... }` containing all nested types for one operation.
     */
    private fun generateOperationObject(operation: Operation, index: TypeIndex): TypeSpec {
        val objectName = toPascalCase(operation.name)
        val objectBuilder = TypeSpec.objectBuilder(objectName)

        for (node in operation.nestedTypes) {
            objectBuilder.addType(generateNestedTypeSpec(node, index, listOf(objectName)))
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
    private fun generateNestedTypeSpec(node: NestedTypeNode, index: TypeIndex, parentPath: List<String> = emptyList()): TypeSpec {
        // Build an OperationTypeContext for this node's children so that field type
        // references resolve to short relative ClassName paths.
        val hasVariantNestedTypes = (node.type as? ResolvedType.Union)?.variants?.any { it.nestedTypes.isNotEmpty() } == true
        val childContext = if (node.children.isNotEmpty() || hasVariantNestedTypes) {
            val ctx = OperationTypeContext(parentPath.firstOrNull() ?: node.name)
            fun registerChildren(children: List<NestedTypeNode>, currentPath: List<String>) {
                for (child in children) {
                    ctx.typeMap[child.name] = ClassName("", currentPath + child.name)
                    if (child.children.isNotEmpty()) {
                        registerChildren(child.children, currentPath + child.name)
                    }
                }
            }
            registerChildren(node.children, listOf(node.name))
            // Register variant-scoped nested types
            if (node.type is ResolvedType.Union) {
                for (variant in node.type.variants) {
                    if (variant.nestedTypes.isNotEmpty()) {
                        registerChildren(variant.nestedTypes, listOf(node.name, variant.name))
                    }
                }
            }
            ctx
        } else null

        val spec = when (val type = node.type) {
            is ResolvedType.Record -> generateDataClass(node.name, type, index, childContext)
            is ResolvedType.Enum -> generateEnumClass(node.name, type.values)
            is ResolvedType.Union -> generateSealedClass(node.name, type, index, childContext)
            else -> throw IllegalStateException("Unexpected nested type kind: ${type::class.simpleName}")
        }

        // If there are children, add them as nested types inside this TypeSpec
        if (node.children.isNotEmpty()) {
            val currentPath = parentPath + node.name
            return spec.toBuilder().apply {
                for (child in node.children) {
                    addType(generateNestedTypeSpec(child, index, currentPath))
                }
            }.build()
        }

        return spec
    }

    private fun buildMethodKdoc(operation: Operation): String {
        val parts = mutableListOf<String>()

        if (operation.description != null) {
            parts.add(operation.description)
        }

        val paramTags = operation.parameters
            .filter { !it.description.isNullOrEmpty() }
            .map { "@param ${it.name} ${it.description}" }

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
        namespace: String,
        index: TypeIndex,
        opContext: OperationTypeContext?,
    ): FunSpec {
        val funBuilder = FunSpec
            .builder(operation.name)
            .addModifiers(KModifier.SUSPEND)

        val kdoc = buildMethodKdoc(operation)
        if (kdoc.isNotEmpty()) {
            funBuilder.addKdoc("%L", kdoc)
        }

        for (param in operation.parameters) {
            val paramType = resolveResolvedType(param.type, index, opContext)
            val isOptional = !param.required
            val finalType = if (isOptional) paramType.copy(nullable = true) else paramType
            val paramBuilder = ParameterSpec.builder(param.name, finalType)
            if (isOptional) paramBuilder.defaultValue("null")
            funBuilder.addParameter(paramBuilder.build())
        }

        val returnType = resolveResolvedType(operation.result.type, index, opContext)
        if (returnType != Unit::class.asTypeName()) {
            funBuilder.returns(returnType)
        }

        generateImplMethodBody(funBuilder, operation, namespace, index, opContext)

        return funBuilder.build()
    }

    private fun generateOidcStubMethod(operation: Operation): FunSpec {
        val message = "OIDC is not configured. Add oidc { redirectUrl = \"...\" } to your awsBlocks block to enable this method."
        return FunSpec.builder(operation.name)
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
        namespace: String,
        index: TypeIndex,
        opContext: OperationTypeContext?,
    ) {
        val hasOptionalParams = operation.parameters.any { !it.required }
        val dottedMethod = "${namespace}.${operation.name}"

        if (operation.parameters.isEmpty()) {
            funBuilder.addStatement(
                "val request = %T(method = %S, params = emptyList(), id = %T.nextId())",
                ClassNames.blocksRequest,
                dottedMethod,
                ClassNames.blocksRequest,
            )
        } else if (hasOptionalParams) {
            generateConditionalArgs(funBuilder, operation, index, opContext)
            funBuilder.addStatement(
                "val request = %T(method = %S, params = args, id = %T.nextId())",
                ClassNames.blocksRequest,
                dottedMethod,
                ClassNames.blocksRequest,
            )
        } else {
            // All params are required — build a listOf(...) inline
            val paramBlocks = operation.parameters.map { paramToJsonExpression(it, index, opContext) }
            val paramsCode = paramBlocks.joinToCode(", ")
            funBuilder.addStatement(
                "val request = %T(method = %S, params = listOf(%L), id = %T.nextId())",
                ClassNames.blocksRequest,
                dottedMethod,
                paramsCode,
                ClassNames.blocksRequest,
            )
        }

        val returnType = resolveResolvedType(operation.result.type, index, opContext)
        if (returnType == Unit::class.asTypeName()) {
            funBuilder.addStatement("client.execute(request)")
        } else if (isTransferableType(operation.result.type)) {
            val transferableType = unwrapNullableTransferable(operation.result.type)!!
            funBuilder.addStatement("val result = client.execute(request)")
            val fromJsonExpr = generateTransferableFromJson(transferableType, "result", index, opContext)
            funBuilder.addCode("return %L\n", fromJsonExpr)
        } else {
            val blocksJson = ClassNames.blocksJson
            val decodeFromJsonElement = MemberNames.decode
            funBuilder.addStatement("val result = client.execute(request)")
            funBuilder.addStatement("return %T.%M(result)", blocksJson, decodeFromJsonElement)
        }
    }

    private fun unwrapNullable(type: ResolvedType): ResolvedType =
        if (type is ResolvedType.Nullable) type.inner else type

    private fun generateConditionalArgs(
        funBuilder: FunSpec.Builder,
        operation: Operation,
        index: TypeIndex,
        opContext: OperationTypeContext?,
    ) {
        val params = operation.parameters
        val requiredParams = params.filter { it.required }
        val optionalParams = params.filter { !it.required }

        if (optionalParams.size == 1 && requiredParams.size == params.size - 1) {
            val optParam = optionalParams[0]
            val reqBlocks = requiredParams.map { paramToJsonExpression(it, index, opContext) }
            val allBlocks = params.map { paramToJsonExpression(it, index, opContext) }
            val reqCode = reqBlocks.joinToCode(", ")
            val allCode = allBlocks.joinToCode(", ")

            funBuilder.addCode(
                "val args: %T = if (%N != null) listOf(%L) else listOf(%L)\n",
                List::class.asTypeName().parameterizedBy(ClassNames.jsonElement),
                optParam.name,
                allCode,
                reqCode,
            )
        } else {
            val reqBlocks = requiredParams.map { paramToJsonExpression(it, index, opContext) }
            val reqCode = reqBlocks.joinToCode(", ")
            funBuilder.addCode("val args = mutableListOf<%T>(%L)\n", ClassNames.jsonElement, reqCode)
            for (param in optionalParams) {
                val expr = paramToJsonExpression(param, index, opContext)
                funBuilder.beginControlFlow("if (%N != null)", param.name)
                funBuilder.addCode("args.add(%L)\n", expr)
                funBuilder.endControlFlow()
            }
        }
    }

    /**
     * Generates a [CodeBlock] that converts an operation parameter to a JsonElement.
     * Wraps primitives in JsonPrimitive; delegates to generateToJsonExpression for complex types.
     */
    private fun paramToJsonExpression(param: OperationParameter, index: TypeIndex, opContext: OperationTypeContext?): CodeBlock {
        val jsonPrimitiveClass = ClassNames.jsonPrimitive
        val inner = unwrapNullable(param.type)
        return when (inner) {
            is ResolvedType.Primitive -> when (inner.kind) {
                PrimitiveKind.VOID, PrimitiveKind.UNKNOWN -> CodeBlock.of("%L", param.name)
                else -> CodeBlock.of("%T(%L)", jsonPrimitiveClass, param.name)
            }
            else -> generateToJsonExpression(inner, param.name, index)
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

    private fun resolveResolvedType(type: ResolvedType, index: TypeIndex, opContext: OperationTypeContext? = null): TypeName =
        when (type) {
            is ResolvedType.Primitive -> mapPrimitive(type.kind)
            is ResolvedType.ListType -> {
                val elementType = resolveResolvedType(type.elementType, index, opContext)
                List::class.asTypeName().parameterizedBy(elementType)
            }
            is ResolvedType.Nullable -> {
                resolveResolvedType(type.inner, index, opContext).copy(nullable = true)
            }
            is ResolvedType.Record -> {
                resolveNamedType(type.name, index, opContext)
            }
            is ResolvedType.Enum -> {
                resolveNamedType(type.name, index, opContext)
            }
            is ResolvedType.Union -> {
                resolveNamedType(type.name, index, opContext)
            }
            is ResolvedType.TypeReference -> {
                resolveNamedType(type.name, index, opContext)
            }
            is ResolvedType.FormattedType -> mapFormattedType(type.format)
            is ResolvedType.MapType -> {
                val valueType = resolveResolvedType(type.valueType, index, opContext)
                Map::class.asTypeName().parameterizedBy(String::class.asTypeName(), valueType)
            }
            is ResolvedType.TupleType -> {
                resolveNamedType(type.name, index, opContext)
            }
            is ResolvedType.Transferable -> resolveTransferable(type, index, opContext)
        }

    /**
     * Resolves a named type (Record, Enum, Union, TypeReference, TupleType) to a ClassName.
     * First checks the operation context (for inline nested types), then falls back to the
     * global type index (for component schemas).
     */
    private fun resolveNamedType(name: String, index: TypeIndex, opContext: OperationTypeContext?): ClassName {
        // Check operation context first (inline nested types)
        if (opContext != null && name.isNotEmpty()) {
            val nestedClassName = opContext.typeMap[name]
            if (nestedClassName != null) return nestedClassName
        }
        // Fall back to global type index (component schemas)
        return findClassNameByTypeName(name, index)
            ?: if (name.isNotEmpty()) ClassName(packageName, name)
            else throw IllegalStateException("Type has no name and is not in the type index")
    }

    private fun resolveTransferable(type: ResolvedType.Transferable, index: TypeIndex, opContext: OperationTypeContext? = null): TypeName {
        return when (type.transferableName) {
            "realtime/channel" -> {
                val realtimeChannel = ClassNames.realtimeChannel
                if (type.typeArgs.isNotEmpty()) {
                    realtimeChannel.parameterizedBy(type.typeArgs.map { resolveResolvedType(it, index, opContext) })
                } else {
                    realtimeChannel.parameterizedBy(JsonElement::class.asTypeName())
                }
            }
            "file-bucket/download" -> ClassNames.fileDownloadHandle
            "file-bucket/upload" -> ClassNames.fileUploadHandle
            "oidc/client" -> ClassNames.oidcClient
            else -> JsonElement::class.asTypeName()
        }
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

    private fun getTransferableSerializerName(type: ResolvedType.Transferable): String {
        val base = when (type.transferableName) {
            "realtime/channel" -> "RealtimeChannel"
            "file-bucket/download" -> "FileDownloadHandle"
            "file-bucket/upload" -> "FileUploadHandle"
            "oidc/client" -> "OidcClient"
            else -> "Unknown"
        }
        val suffix = if (type.typeArgs.isNotEmpty()) {
            type.typeArgs.joinToString("") { arg ->
                when (arg) {
                    is ResolvedType.Record -> arg.name
                    is ResolvedType.TypeReference -> arg.name
                    else -> "JsonElement"
                }
            }
        } else ""
        return "${base}${suffix}Serializer"
    }

    private fun collectTransferableEntries(model: CodegenModel, index: TypeIndex): List<TransferableSerializerGenerator.TransferableEntry> {
        val seen = mutableSetOf<String>()
        val entries = mutableListOf<TransferableSerializerGenerator.TransferableEntry>()

        fun visit(type: ResolvedType) {
            when (type) {
                is ResolvedType.Transferable -> {
                    if (redirectUrl == null && type.transferableName == "oidc/client") return
                    val serializerName = getTransferableSerializerName(type)
                    if (seen.add(serializerName)) {
                        val returnType = resolveTransferable(type, index)
                        entries.add(TransferableSerializerGenerator.TransferableEntry(
                            transferableName = type.transferableName,
                            typeArgs = type.typeArgs,
                            serializerName = serializerName,
                            returnType = returnType,
                        ))
                    }
                }
                is ResolvedType.Nullable -> visit(type.inner)
                is ResolvedType.ListType -> visit(type.elementType)
                is ResolvedType.Record -> type.fields.forEach { visit(it.type) }
                else -> {}
            }
        }

        for (typeDef in model.typeDefinitions) {
            when (val t = typeDef.type) {
                is ResolvedType.Record -> t.fields.forEach { visit(it.type) }
                else -> {}
            }
        }

        return entries
    }

    private fun mapPrimitive(kind: PrimitiveKind): TypeName = when (kind) {
        PrimitiveKind.STRING -> String::class.asTypeName()
        PrimitiveKind.BOOLEAN -> Boolean::class.asTypeName()
        PrimitiveKind.INTEGER -> Int::class.asTypeName()
        PrimitiveKind.NUMBER -> Double::class.asTypeName()
        PrimitiveKind.VOID -> Unit::class.asTypeName()
        PrimitiveKind.UNKNOWN -> Any::class.asTypeName()
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
     */
    private fun generateToJsonExpression(type: ResolvedType, expr: String, index: TypeIndex): CodeBlock {
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
                CodeBlock.of("%T.%M(%L)", ClassNames.blocksJson, MemberNames.encode, expr)
            }

            is ResolvedType.ListType -> {
                val arrayBody = generateJsonArrayBody(type, expr, index)
                CodeBlock.of("%M { %L }", MemberNames.buildJsonArray, arrayBody)
            }

            is ResolvedType.Nullable -> {
                generateToJsonExpression(type.inner, expr, index)
            }

            is ResolvedType.TypeReference -> {
                val resolvedType = resolveTypeReference(type.name, index)
                if (resolvedType != null) {
                    generateToJsonExpression(resolvedType, expr, index)
                } else {
                    CodeBlock.of("%T.%M(%L)", ClassNames.blocksJson, MemberNames.encode, expr)
                }
            }

            is ResolvedType.FormattedType -> {
                CodeBlock.of("%T(%L.toString())", ClassNames.jsonPrimitive, expr)
            }
            is ResolvedType.MapType -> {
                val valueToJson = generateToJsonExpression(type.valueType, "it.value", index)
                CodeBlock.of("%M { %L.forEach { %M(it.key, %L) } }", MemberNames.buildJsonObject, expr, MemberNames.put, valueToJson)
            }
            is ResolvedType.TupleType -> TODO("TupleType toJson not yet implemented")

            is ResolvedType.Transferable -> {
                throw UnsupportedOperationException(
                    "Transferable types (${type.transferableName}) cannot be serialized — they are read-only"
                )
            }
        }
    }

    /**
     * Generates the body of a `putJsonArray` / `buildJsonArray` lambda for a list type.
     * Uses `addAll(expr)` for simple primitive collections, or `expr.forEach { add(...) }` for complex types.
     */
    private fun generateJsonArrayBody(listType: ResolvedType.ListType, expr: String, index: TypeIndex): CodeBlock {
        val elementType = listType.elementType
        return when {
            elementType is ResolvedType.Primitive && elementType.kind in listOf(
                PrimitiveKind.STRING, PrimitiveKind.BOOLEAN, PrimitiveKind.INTEGER, PrimitiveKind.NUMBER
            ) -> CodeBlock.of("%M(%L)", MemberNames.addAll, expr)

            elementType is ResolvedType.Nullable && elementType.inner is ResolvedType.Primitive -> {
                CodeBlock.of("%L.forEach { %M(it) }", expr, MemberNames.add)
            }

            else -> {
                val elementExpr = generateToJsonElementExpression(elementType, "it", index)
                CodeBlock.of("%L.forEach { %M(%L) }", expr, MemberNames.add, elementExpr)
            }
        }
    }

    /**
     * Like [generateToJsonExpression], but guarantees the result is a JsonElement.
     * Primitives are wrapped in JsonPrimitive; complex types already return JsonElement.
     * Use this when the expression must be a JsonElement (e.g. inside JsonArray).
     */
    private fun generateToJsonElementExpression(type: ResolvedType, expr: String, index: TypeIndex): CodeBlock {
        val jsonPrimitiveClass = ClassNames.jsonPrimitive
        return when (type) {
            is ResolvedType.Primitive -> when (type.kind) {
                PrimitiveKind.STRING, PrimitiveKind.BOOLEAN, PrimitiveKind.INTEGER, PrimitiveKind.NUMBER ->
                    CodeBlock.of("%T(%L)", jsonPrimitiveClass, expr)
                else -> CodeBlock.of("%L", expr)
            }
            is ResolvedType.Nullable -> {
                val innerExpr = generateToJsonElementExpression(type.inner, expr, index)
                val jsonNull = ClassNames.jsonNull
                CodeBlock.of("if (%L != null) %L else %T", expr, innerExpr, jsonNull)
            }
            else -> generateToJsonExpression(type, expr, index)
        }
    }

    /**
     * Generates a KotlinPoet [CodeBlock] for hydrating a transferable type from a JsonElement descriptor.
     *
     * @param type The transferable type to hydrate
     * @param expr The expression string holding the JsonElement descriptor
     * @param index The type index for resolving type arguments
     */
    private fun generateTransferableFromJson(type: ResolvedType.Transferable, expr: String, index: TypeIndex, opContext: OperationTypeContext? = null): CodeBlock {
        return when (type.transferableName) {
            "realtime/channel" -> {
                if (type.typeArgs.isNotEmpty()) {
                    val typeArgName = (type.typeArgs.first() as? ResolvedType.TypeReference)?.name
                        ?: (type.typeArgs.first() as? ResolvedType.Record)?.name
                        ?: ""
                    val typeArgClassName = if (typeArgName.isNotEmpty()) {
                        resolveNamedType(typeArgName, index, opContext)
                    } else {
                        resolveResolvedType(type.typeArgs.first(), index, opContext) as? ClassName
                            ?: ClassName(packageName, "Unknown")
                    }

                    CodeBlock.of(
                        "%T.fromJson(%L) { %T.%M<%T>(it) }",
                        ClassNames.realtimeChannel, expr,
                        ClassNames.blocksJson, MemberNames.decode, typeArgClassName
                    )
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
                val url = redirectUrl
                    ?: error("OIDC operation reached codegen without redirectUrl configured")
                CodeBlock.of("%T.fromJson(%L, client, %S)", ClassNames.oidcClient, expr, url)
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
    }
}
