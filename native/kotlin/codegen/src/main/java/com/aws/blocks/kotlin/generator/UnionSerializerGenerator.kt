package com.aws.blocks.kotlin.generator

import com.aws.blocks.kotlin.NamingUtils
import com.aws.blocks.kotlin.model.DiscriminatorInfo
import com.aws.blocks.kotlin.model.DiscriminatorType
import com.aws.blocks.kotlin.model.FormatKind
import com.aws.blocks.kotlin.model.PrimitiveKind
import com.aws.blocks.kotlin.model.ResolvedType
import com.aws.blocks.kotlin.model.UnionVariant
import com.squareup.kotlinpoet.AnnotationSpec
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.MemberName
import com.squareup.kotlinpoet.ParameterSpec
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.SET
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.TypeName
import com.squareup.kotlinpoet.TypeSpec
import com.squareup.kotlinpoet.asTypeName
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.longOrNull

/**
 * Wire mapping for the unions kotlinx's own sealed-class serializer gets wrong.
 *
 * kotlinx writes a sealed class as an object with a string discriminator (`"type"` by default,
 * or the `@JsonClassDiscriminator` key) whose value is the subclass's `@SerialName`. That is the
 * spec's wire format only for a union discriminated by a JSON **string**, all of whose arms are
 * objects. Every other union gets a custom serializer ([serializerName]) instead:
 *
 * - **no discriminator** (`anyOf [string, {text}]`): each arm is its bare JSON value (`"abc"`,
 *   `{"text":"t"}`). Decoding inspects the JSON element and tries the arms in spec order, as
 *   Swift does: a value arm by its JSON kind (string, number, boolean, array, object, a
 *   transferable's `__blocks` tag), a literal arm by its exact literal, an object arm by its
 *   required keys. The first arm whose shape matches and whose decode succeeds wins; a value no
 *   arm matches throws a [kotlinx.serialization.SerializationException] that names the union.
 * - **a boolean or numeric discriminator** (`isUpdated: true`): the discriminator is written and
 *   matched with the JSON type the spec gives it, never as a string.
 * - **a string discriminator with value or literal arms** (`oneOf [string, {kind:"a"}]`): the
 *   value arms decode first, then an object decodes by its discriminator.
 *
 * Every arm decodes with the [kotlinx.serialization.json.Json] decoding the union (so an
 * `OidcClient` inside it binds to the calling client), and encodes with the encoding one.
 */
internal object UnionSerializerGenerator {
    /** The property of a value arm's class that holds the value. */
    const val VALUE_PROPERTY = "value"

    private val jsonEncoder = ClassName("kotlinx.serialization.json", "JsonEncoder")
    private val jsonObjectClass = ClassName("kotlinx.serialization.json", "JsonObject")
    private val jsonArrayClass = ClassName("kotlinx.serialization.json", "JsonArray")
    private val serializationException = ClassName("kotlinx.serialization", "SerializationException")
    // `kotlin.IllegalArgumentException` (KotlinPoet would write `java.lang.`, which isn't common code).
    private val illegalArgument = ClassName("kotlin", "IllegalArgumentException")
    private val jsonObjectProperty = MemberName("kotlinx.serialization.json", "jsonObject")
    private val booleanOrNullProperty = MemberName("kotlinx.serialization.json", "booleanOrNull")
    private val intOrNullProperty = MemberName("kotlinx.serialization.json", "intOrNull")
    private val doubleOrNullProperty = MemberName("kotlinx.serialization.json", "doubleOrNull")

    /** The nested serializer object of a union named [unionName]. */
    fun serializerName(unionName: String): String = "${unionName}Serializer"

    /**
     * Whether [union] needs the custom serializer: kotlinx's sealed serializer is right only for
     * a union discriminated by a JSON string whose arms are all objects.
     */
    fun needsCustomSerializer(union: ResolvedType.Union): Boolean {
        val discriminator = union.discriminator ?: return true
        if (discriminator.type != DiscriminatorType.STRING) return true
        return union.variants.any { it.isBare }
    }

    /** A value or literal arm: on the wire it is a bare JSON value, not an object. */
    val UnionVariant.isBare: Boolean get() = valueType != null || literal != null

    /** A literal arm with one literal is a `data object`; one with several holds the value it matched. */
    val UnionVariant.isSingleLiteral: Boolean get() = literal?.size == 1

    /** `@Serializable(with = <unionName>.<unionName>Serializer::class)`, written as names (see [OpenRecordSerializerGenerator]). */
    fun serializableAnnotation(unionName: String): AnnotationSpec =
        AnnotationSpec.builder(ClassNames.serializable)
            .addMember("with = %N.%N::class", unionName, serializerName(unionName))
            .build()

    /**
     * The Kotlin type of a literal arm with several literals: the JSON type they share
     * (`String`, `Boolean`, `Double`), or `JsonPrimitive` for a mix.
     */
    fun literalValueType(literals: List<JsonPrimitive>): TypeName = when {
        literals.all { it.isString } -> String::class.asTypeName()
        literals.all { it.booleanOrNull != null } -> Boolean::class.asTypeName()
        literals.all { it.doubleOrNull != null } -> Double::class.asTypeName()
        else -> ClassNames.jsonPrimitive
    }

    /**
     * How the serializer reads and writes one value arm: [type] is the Kotlin type of its value,
     * [serializer] the serializer it needs when a reified call can't find one (a transferable
     * inside lists and maps), else null.
     */
    data class ValueCoding(val type: TypeName, val serializer: CodeBlock?)

    /**
     * The serializer object for [union], named [unionName]. [valueCoding] gives the coding of
     * each value arm (and of a literal arm with several literals).
     */
    fun generate(
        unionName: String,
        union: ResolvedType.Union,
        valueCoding: (UnionVariant) -> ValueCoding,
    ): TypeSpec {
        val owner = ClassName("", unionName)
        val discriminator = union.discriminator
        val arms = union.variants.map { describe(it, discriminator) }
        val expected = if (arms.size < 2) arms.joinToString() else arms.dropLast(1).joinToString("; ") + "; or " + arms.last()
        return TypeSpec.objectBuilder(serializerName(unionName))
            .addSuperinterface(ClassNames.kSerializer.parameterizedBy(owner))
            .addKdoc(
                if (discriminator == null) {
                    "Reads and writes [%N] as the bare JSON value of its variant. It has no discriminator, so a\n" +
                        "value decodes to the first variant, in spec order, whose JSON shape it has.\n"
                } else {
                    "Reads and writes [%N] with its discriminator `${discriminator.fieldName}` as the JSON value\n" +
                        "the spec gives it.\n"
                },
                unionName,
            )
            .addProperty(
                PropertySpec.builder("descriptor", ClassNames.serialDescriptor, KModifier.OVERRIDE)
                    .initializer("%M(%S)", MemberNames.buildClassSerialDescriptor, unionName)
                    .build(),
            )
            .addFunction(serialize(unionName, owner, union, valueCoding))
            .addFunction(deserialize(unionName, owner, union, valueCoding, expected))
            .build()
    }

    private fun serialize(
        unionName: String,
        owner: ClassName,
        union: ResolvedType.Union,
        valueCoding: (UnionVariant) -> ValueCoding,
    ): FunSpec {
        val discriminator = union.discriminator
        val body = CodeBlock.builder()
            .addStatement(
                "val output = encoder as? %T ?: throw %T(%S)",
                jsonEncoder,
                serializationException,
                "$unionName can only be written as JSON",
            )
            .beginControlFlow("val element = when (value)")
        for (variant in union.variants) {
            val literal = variant.literal
            val discriminatorLiteral = variant.discriminatorLiteral
            when {
                variant.isSingleLiteral -> body.addStatement("is %N -> %L", variant.name, jsonLiteral(literal!!.single()))
                variant.isBare -> {
                    val coding = valueCoding(variant)
                    body.addStatement("is %N -> %L", variant.name, encodeValue(coding, "value.$VALUE_PROPERTY"))
                }
                discriminator != null && discriminatorLiteral != null -> {
                    body.beginControlFlow("is %N -> %M", variant.name, MemberNames.buildJsonObject)
                    body.addStatement("put(%S, %L)", discriminator.fieldName, jsonLiteral(discriminatorLiteral))
                    if (!variant.isFieldless) {
                        body.addStatement(
                            "output.json.%M(%N.serializer(), value).%M.forEach { (key, field) -> put(key, field) }",
                            MemberNames.encode,
                            variant.name,
                            jsonObjectProperty,
                        )
                    }
                    body.endControlFlow()
                }
                variant.isFieldless -> body.addStatement("is %N -> %T(emptyMap())", variant.name, jsonObjectClass)
                else -> body.addStatement("is %N -> output.json.%M(%N.serializer(), value)", variant.name, MemberNames.encode, variant.name)
            }
        }
        body.endControlFlow()
            .addStatement("output.encodeJsonElement(element)")
        return FunSpec.builder("serialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("encoder", ClassNames.encoder)
            .addParameter("value", owner)
            .addCode(body.build())
            .build()
    }

    private fun deserialize(
        unionName: String,
        owner: ClassName,
        union: ResolvedType.Union,
        valueCoding: (UnionVariant) -> ValueCoding,
        expected: String,
    ): FunSpec {
        val discriminator = union.discriminator
        val body = CodeBlock.builder()
            .addStatement(
                "val input = decoder as? %T ?: throw %T(%S)",
                ClassNames.jsonDecoder,
                serializationException,
                "$unionName can only be read from JSON",
            )
            .addStatement("val element = input.decodeJsonElement()")
        // Arms whose decode can fail after their shape matched; the last failure is the cause.
        val tried = union.variants.filter { variant ->
            when {
                variant.isSingleLiteral -> false
                variant.isBare -> true
                discriminator != null && variant.discriminatorLiteral != null -> false
                else -> !variant.isFieldless
            }
        }
        if (tried.isNotEmpty()) body.addStatement("var failure: %T? = null", ClassName("kotlin", "Throwable"))

        // Spec order. In a discriminated union the value and literal arms go first, before the
        // object is read by its discriminator.
        val ordered = if (discriminator == null) {
            union.variants
        } else {
            union.variants.filter { it.isBare } + union.variants.filterNot { it.isBare }
        }
        val discriminated = mutableListOf<UnionVariant>()
        for (variant in ordered) {
            val literal = variant.literal
            when {
                variant.isSingleLiteral ->
                    body.addStatement("if (element == %L) return %N", jsonLiteral(literal!!.single()), variant.name)
                variant.isBare -> {
                    val coding = valueCoding(variant)
                    val predicate = if (literal != null) {
                        literalSetCheck(literal)
                    } else {
                        valuePredicate(variant.valueType!!)
                    }
                    body.beginControlFlow("if (%L)", predicate)
                    tryReturn(body, CodeBlock.of("%N(%L)", variant.name, decodeValue(coding)))
                    body.endControlFlow()
                }
                discriminator != null && variant.discriminatorLiteral != null -> discriminated.add(variant)
                variant.isFieldless -> body.addStatement("if (element is %T) return %N", jsonObjectClass, variant.name)
                else -> {
                    body.beginControlFlow("if (%L)", objectPredicate(variant))
                    tryReturn(
                        body,
                        CodeBlock.of("input.json.%M(%N.serializer(), element)", MemberNames.decode, variant.name),
                    )
                    body.endControlFlow()
                }
            }
        }
        if (discriminator != null && discriminated.isNotEmpty()) {
            body.beginControlFlow("if (element is %T)", jsonObjectClass)
            if (discriminated.any { !it.isFieldless }) {
                body.addStatement("val fields = %T(element - %S)", jsonObjectClass, discriminator.fieldName)
            }
            body.beginControlFlow("when (element[%S])", discriminator.fieldName)
            for (variant in discriminated) {
                val literal = jsonLiteral(variant.discriminatorLiteral!!)
                if (variant.isFieldless) {
                    body.addStatement("%L -> return %N", literal, variant.name)
                } else {
                    body.addStatement(
                        "%L -> return input.json.%M(%N.serializer(), fields)",
                        literal,
                        MemberNames.decode,
                        variant.name,
                    )
                }
            }
            body.addStatement("else -> {}")
            body.endControlFlow()
            body.endControlFlow()
        }
        val message = "No variant of $unionName matches this JSON value; expected $expected"
        if (tried.isNotEmpty()) {
            body.addStatement("throw %T(%S, failure)", serializationException, message)
        } else {
            body.addStatement("throw %T(%S)", serializationException, message)
        }
        return FunSpec.builder("deserialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("decoder", ClassNames.decoder)
            .returns(owner)
            .addCode(body.build())
            .build()
    }

    private val UnionVariant.isFieldless: Boolean
        get() = fields.isEmpty() && embeddedUnion == null && additionalPropertiesType == null

    private fun tryReturn(body: CodeBlock.Builder, decode: CodeBlock) {
        body.beginControlFlow("try")
            .addStatement("return %L", decode)
            .nextControlFlow("catch (e: %T)", illegalArgument)
            .addStatement("failure = e")
            .endControlFlow()
    }

    private fun decodeValue(coding: ValueCoding): CodeBlock =
        if (coding.serializer != null) {
            CodeBlock.of("input.json.%M(%L, element)", MemberNames.decode, coding.serializer)
        } else {
            CodeBlock.of("input.json.%M<%T>(element)", MemberNames.decode, coding.type)
        }

    private fun encodeValue(coding: ValueCoding, value: String): CodeBlock =
        if (coding.serializer != null) {
            CodeBlock.of("output.json.%M(%L, %L)", MemberNames.encode, coding.serializer, value)
        } else {
            CodeBlock.of("output.json.%M<%T>(%L)", MemberNames.encode, coding.type, value)
        }

    /** The JSON element test for a value arm of [type]. */
    private fun valuePredicate(type: ResolvedType): CodeBlock = when (type) {
        is ResolvedType.Nullable ->
            CodeBlock.of("element is %T || %L", ClassNames.jsonNull, valuePredicate(type.inner))
        is ResolvedType.Primitive -> when (type.kind) {
            PrimitiveKind.STRING -> stringPredicate()
            PrimitiveKind.BOOLEAN -> nonStringPrimitive(booleanOrNullProperty)
            PrimitiveKind.INTEGER -> nonStringPrimitive(intOrNullProperty)
            PrimitiveKind.NUMBER -> nonStringPrimitive(doubleOrNullProperty)
            PrimitiveKind.UNKNOWN, PrimitiveKind.VOID -> CodeBlock.of("true")
        }
        is ResolvedType.FormattedType -> stringPredicate()
        is ResolvedType.ListType, is ResolvedType.TupleType -> CodeBlock.of("element is %T", jsonArrayClass)
        is ResolvedType.Transferable -> CodeBlock.of(
            "element is %T && element[%S] == %T(%S)",
            jsonObjectClass,
            "__blocks",
            ClassNames.jsonPrimitive,
            type.transferableName,
        )
        else -> CodeBlock.of("element is %T", jsonObjectClass)
    }

    private fun stringPredicate(): CodeBlock =
        CodeBlock.of("element is %T && element.isString", ClassNames.jsonPrimitive)

    private fun nonStringPrimitive(parsed: MemberName): CodeBlock =
        CodeBlock.of("element is %T && !element.isString && element.%M != null", ClassNames.jsonPrimitive, parsed)

    private fun literalSetCheck(literals: List<JsonPrimitive>): CodeBlock {
        val set = CodeBlock.builder().add("element in setOf(")
        literals.forEachIndexed { i, literal ->
            if (i > 0) set.add(", ")
            set.add(jsonLiteral(literal))
        }
        return set.add(")").build()
    }

    /** An object arm matches a JSON object that has every one of its required keys. */
    private fun objectPredicate(variant: UnionVariant): CodeBlock {
        val code = CodeBlock.builder().add("element is %T", jsonObjectClass)
        for (field in variant.fields.filter { it.required }) code.add(" && %S in element", field.name)
        return code.build()
    }

    /** `JsonPrimitive(<literal>)`, with the literal's JSON type. */
    fun jsonLiteral(literal: JsonPrimitive): CodeBlock = when {
        literal.isString -> CodeBlock.of("%T(%S)", ClassNames.jsonPrimitive, literal.content)
        literal.booleanOrNull != null -> CodeBlock.of("%T(%L)", ClassNames.jsonPrimitive, literal.booleanOrNull)
        literal.longOrNull != null -> CodeBlock.of("%T(%LL)", ClassNames.jsonPrimitive, literal.longOrNull)
        literal.doubleOrNull != null -> CodeBlock.of("%T(%L)", ClassNames.jsonPrimitive, literal.doubleOrNull)
        else -> CodeBlock.of("%T", ClassNames.jsonNull)
    }

    /** One arm, for the error message of a value that matches none. */
    private fun describe(variant: UnionVariant, discriminator: DiscriminatorInfo?): String {
        val literal = variant.literal
        val discriminatorLiteral = variant.discriminatorLiteral
        return when {
            literal != null -> literal.joinToString(" or ") { it.toString() }
            variant.valueType != null -> describe(variant.valueType)
            discriminator != null && discriminatorLiteral != null ->
                "an object with \"${discriminator.fieldName}\": $discriminatorLiteral"
            else -> {
                val keys = variant.fields.filter { it.required }.map { "\"${it.name}\"" }
                if (keys.isEmpty()) "an object" else "an object with ${keys.joinToString(", ")}"
            }
        }
    }

    private fun describe(type: ResolvedType): String = when (type) {
        is ResolvedType.Nullable -> "null or ${describe(type.inner)}"
        is ResolvedType.Primitive -> when (type.kind) {
            PrimitiveKind.STRING -> "a string"
            PrimitiveKind.BOOLEAN -> "a boolean"
            PrimitiveKind.INTEGER -> "an integer"
            PrimitiveKind.NUMBER -> "a number"
            PrimitiveKind.UNKNOWN, PrimitiveKind.VOID -> "any value"
        }
        is ResolvedType.FormattedType -> when (type.format) {
            FormatKind.DATE_TIME -> "a date-time string"
            FormatKind.DATE -> "a date string"
            FormatKind.TIME -> "a time string"
            FormatKind.UUID -> "a UUID string"
        }
        is ResolvedType.ListType, is ResolvedType.TupleType -> "an array"
        is ResolvedType.MapType -> "an object"
        is ResolvedType.Transferable -> "a ${type.transferableName} transferable"
        else -> "an object"
    }
}

/**
 * Wire mapping for a hybrid arm: an object arm with its own properties *and* a nested `oneOf`
 * (`Auth`'s `confirmSignIn`: `{ action, session }` plus one of `{ challenge: "code", code }`, …).
 * JSON Schema reads that as **one flat object**; the generated class holds the nested union in a
 * property named after its discriminator (`challenge: Challenge`), which the plugin would write as
 * a nested object (`"challenge": {"challenge": "code", …}`), and the server rejects.
 *
 * The arm gets a custom serializer ([SERIALIZER_OBJECT]) and a private copy of its other
 * properties ([FIELDS_CLASS]), serialized by the plugin with the same annotations and defaults.
 * Encoding writes the copy's keys and the nested union's keys (its discriminator included) into
 * one object; decoding reads the copy from the arm's own keys and the nested union from the rest.
 * The enclosing union's discriminator (`action`) is the enclosing serializer's: kotlinx writes it
 * beside these keys, and it is left out of the nested union's input.
 */
internal object HybridArmSerializerGenerator {
    /** The nested custom serializer of a hybrid arm. */
    const val SERIALIZER_OBJECT = "HybridArmSerializer"

    /** The nested private copy of a hybrid arm's own properties, serialized by the plugin. */
    const val FIELDS_CLASS = "HybridArmFields"

    /** The parameter and locals of the generated `deserialize`. */
    private val DECODER_NAMES = setOf("decoder", "input", "flat", "fields")

    private val jsonEncoder = ClassName("kotlinx.serialization.json", "JsonEncoder")
    private val jsonObjectClass = ClassName("kotlinx.serialization.json", "JsonObject")
    private val serializationException = ClassName("kotlinx.serialization", "SerializationException")
    private val jsonObjectProperty = MemberName("kotlinx.serialization.json", "jsonObject")

    /** `@Serializable(with = <ownerName>.HybridArmSerializer::class)`. */
    fun serializableAnnotation(ownerName: String, serializerObject: String = SERIALIZER_OBJECT): AnnotationSpec =
        AnnotationSpec.builder(ClassNames.serializable)
            .addMember("with = %N.%N::class", ownerName, serializerObject)
            .build()

    /**
     * The names of the serializer and the fields class in a hybrid arm whose properties are
     * [propertyNames]: [SERIALIZER_OBJECT] and [FIELDS_CLASS], or `_2`, … where a property has one.
     */
    fun nestedTypeNames(propertyNames: Collection<String>): Pair<String, String> {
        val (serializer, fields) = NamingUtils.nestedTypeNamesBeside(propertyNames, listOf(SERIALIZER_OBJECT, FIELDS_CLASS))
        return serializer to fields
    }

    /**
     * The two nested types a hybrid arm named [ownerName] needs. [parameters] and [properties] are
     * its constructor parameters and properties; [unionProperty] is the one holding the nested
     * union, of type [unionName]. [serialName] names the descriptor: the arm's discriminator value
     * (the enclosing sealed serializer matches subclasses by it). [discriminator] is the
     * enclosing union's discriminator key, if any. [wireNames] maps a property renamed for Kotlin
     * (written with `@SerialName`) to its wire name; any other property's wire name is its name.
     */
    fun nestedTypes(
        ownerName: String,
        serialName: String,
        parameters: List<ParameterSpec>,
        properties: List<PropertySpec>,
        unionProperty: String,
        unionName: String,
        discriminator: String?,
        wireNames: Map<String, String> = emptyMap(),
        serializerObject: String = SERIALIZER_OBJECT,
        fieldsClassName: String = FIELDS_CLASS,
    ): List<TypeSpec> {
        val owner = ClassName("", ownerName)
        val fields = ClassName("", ownerName, fieldsClassName)
        val ownParameters = parameters.filter { it.name != unionProperty }
        val ownProperties = properties.filter { it.name != unionProperty }

        val fieldsClass = TypeSpec.classBuilder(fieldsClassName)
            .addModifiers(KModifier.PRIVATE, KModifier.DATA)
            .addAnnotation(ClassNames.serializable)
            .primaryConstructor(FunSpec.constructorBuilder().addParameters(ownParameters).build())
            .addProperties(ownProperties)
            .build()

        // Wire names of the arm's own properties (an escaped keyword keeps its name on the wire).
        val fieldKeys = CodeBlock.builder().add("setOf(")
        ownParameters.forEachIndexed { i, p ->
            if (i > 0) fieldKeys.add(", ")
            fieldKeys.add("%S", wireNames[p.name] ?: p.name)
        }
        fieldKeys.add(")")
        val isUnionKey = if (discriminator != null) {
            CodeBlock.of("key !in fieldKeys && key != %S", discriminator)
        } else {
            CodeBlock.of("key !in fieldKeys")
        }

        val ownArgs = CodeBlock.builder()
        ownParameters.forEachIndexed { i, p ->
            if (i > 0) ownArgs.add(", ")
            ownArgs.add("value.%N", p.name)
        }
        // The decoder's local for the nested union is named after its property, unless that is one
        // of the decoder's own names (a nested union discriminated by `fields`): then it steps aside.
        val unionLocal = NamingUtils.claim(unionProperty, DECODER_NAMES.toMutableSet())
        val constructorArgs = CodeBlock.builder()
        parameters.forEachIndexed { i, p ->
            if (i > 0) constructorArgs.add(", ")
            if (p.name == unionProperty) {
                constructorArgs.add("%N = %N", p.name, unionLocal)
            } else {
                constructorArgs.add("%N = fields.%N", p.name, p.name)
            }
        }

        val serialize = FunSpec.builder("serialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("encoder", ClassNames.encoder)
            .addParameter("value", owner)
            .addStatement(
                "val output = encoder as? %T ?: throw %T(%S)",
                jsonEncoder,
                serializationException,
                "$ownerName can only be written as JSON",
            )
            .addStatement(
                "val fields = output.json.%M(%T.serializer(), %T(%L)).%M",
                MemberNames.encode,
                fields,
                fields,
                ownArgs.build(),
                jsonObjectProperty,
            )
            .addStatement(
                "val union = output.json.%M(%N.serializer(), value.%N).%M",
                MemberNames.encode,
                unionName,
                unionProperty,
                jsonObjectProperty,
            )
            .addStatement("output.encodeJsonElement(%T(fields + union))", jsonObjectClass)
            .build()

        val deserialize = FunSpec.builder("deserialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("decoder", ClassNames.decoder)
            .returns(owner)
            .addStatement(
                "val input = decoder as? %T ?: throw %T(%S)",
                ClassNames.jsonDecoder,
                serializationException,
                "$ownerName can only be read from JSON",
            )
            .addStatement("val flat = input.decodeJsonElement().%M", jsonObjectProperty)
            .addStatement(
                "val fields = input.json.%M(%T.serializer(), %T(flat.filterKeys { it in fieldKeys }))",
                MemberNames.decode,
                fields,
                jsonObjectClass,
            )
            .addStatement(
                "val %N = input.json.%M(%N.serializer(), %T(flat.filterKeys { key -> %L }))",
                unionLocal,
                MemberNames.decode,
                unionName,
                jsonObjectClass,
                isUnionKey,
            )
            .addStatement("return %T(%L)", owner, constructorArgs.build())
            .build()

        val serializer = TypeSpec.objectBuilder(serializerObject)
            .addModifiers(KModifier.INTERNAL)
            .addSuperinterface(ClassNames.kSerializer.parameterizedBy(owner))
            .addKdoc(
                "Writes [%N] and the arm's own properties as one flat JSON object, the hybrid arm's wire shape.\n",
                unionProperty,
            )
            .addProperty(
                PropertySpec.builder("fieldKeys", SET.parameterizedBy(STRING), KModifier.PRIVATE)
                    .initializer(fieldKeys.build())
                    .build(),
            )
            .addProperty(
                PropertySpec.builder("descriptor", ClassNames.serialDescriptor, KModifier.OVERRIDE)
                    .initializer("%M(%S)", MemberNames.buildClassSerialDescriptor, serialName)
                    .build(),
            )
            .addFunction(serialize)
            .addFunction(deserialize)
            .build()

        return listOf(fieldsClass, serializer)
    }
}
