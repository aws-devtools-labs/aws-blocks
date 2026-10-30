package com.aws.blocks.kotlin.generator

import com.aws.blocks.kotlin.NamingUtils
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
import com.squareup.kotlinpoet.TypeSpec

/**
 * Wire mapping for an open record: an object schema with `properties` *and*
 * `additionalProperties` (TypeScript `T & Record<string, V>`), such as `Auth`'s `signUp` action,
 * whose user attributes sit flat beside `username` and `password`.
 *
 * The generated class keeps its known properties typed and collects every other key in
 * `attributes: Map<String, V>`. On the wire those extra keys are flat: an `attributes` key
 * nested in the JSON would reach the server as one attribute named `attributes`. The
 * serialization plugin can't express that, so an open record gets a custom serializer
 * ([SERIALIZER_OBJECT]) and a private copy of its constructor ([FIELDS_CLASS]) that the plugin
 * serializes as usual, with the same annotations (transferable serializers, `@SerialName`) and
 * defaults. The serializer moves the copy's nested `attributes` object to the top level on
 * encode, and back on decode, so the known properties keep the plugin's handling and the extra
 * values decode with the same [kotlinx.serialization.json.Json] (an `OidcClient` value binds to
 * the calling client).
 *
 * A known property, or the union discriminator of a variant (`action`), is never an extra key:
 * on decode it isn't collected, and on encode an `attributes` entry with that name is dropped,
 * so the typed value wins, as in Swift and Dart.
 */
internal object OpenRecordSerializerGenerator {
    /**
     * The property, and constructor parameter, that holds the extra keys. It steps aside for a
     * known property of that name (`attributes_2`, see the generator's `extrasProperty`).
     */
    const val EXTRAS_PROPERTY = "attributes"

    /**
     * The nested custom serializer of an open record. Like [FIELDS_CLASS], it steps aside for a
     * property of that name (see [nestedTypeNames]).
     */
    const val SERIALIZER_OBJECT = "OpenRecordSerializer"

    /** The nested private copy of an open record's constructor, serialized by the plugin. */
    const val FIELDS_CLASS = "OpenRecordFields"

    /**
     * The names of the serializer and the fields class in an open record whose properties are
     * [propertyNames]: [SERIALIZER_OBJECT] and [FIELDS_CLASS], or `_2`, … where a property has one.
     */
    fun nestedTypeNames(propertyNames: Collection<String>): Pair<String, String> {
        val (serializer, fields) = NamingUtils.nestedTypeNamesBeside(propertyNames, listOf(SERIALIZER_OBJECT, FIELDS_CLASS))
        return serializer to fields
    }

    private val jsonEncoder = ClassName("kotlinx.serialization.json", "JsonEncoder")
    private val jsonObjectProperty = MemberName("kotlinx.serialization.json", "jsonObject")

    /**
     * `@Serializable(with = <ownerName>.OpenRecordSerializer::class)`, for the open record itself.
     * Written as names, not a [ClassName]: outside any enclosing type (a top-level model),
     * KotlinPoet would otherwise import `<ownerName>` from the default package.
     */
    fun serializableAnnotation(ownerName: String, serializerObject: String = SERIALIZER_OBJECT): AnnotationSpec =
        AnnotationSpec.builder(ClassNames.serializable)
            .addMember("with = %N.%N::class", ownerName, serializerObject)
            .build()

    /**
     * The two nested types an open record named [ownerName] needs.
     *
     * [parameters] and [properties] are the record's own constructor parameters and properties,
     * in order, ending with or containing [extrasProperty] ([EXTRAS_PROPERTY] unless a known
     * property has that name); every other parameter is a known property, whose wire name is in
     * [wireNames] (its spec name, written with `@SerialName`) or else its name. [serialName] names
     * the serializer's descriptor: the discriminator value for a variant of a sealed class (the
     * sealed serializer matches subclasses by it), the class name otherwise. [discriminator] is
     * the discriminator key of the enclosing union, if any.
     */
    fun nestedTypes(
        ownerName: String,
        serialName: String,
        parameters: List<ParameterSpec>,
        properties: List<PropertySpec>,
        discriminator: String?,
        extrasProperty: String = EXTRAS_PROPERTY,
        wireNames: Map<String, String> = emptyMap(),
        serializerObject: String = SERIALIZER_OBJECT,
        fieldsClassName: String = FIELDS_CLASS,
    ): List<TypeSpec> {
        val owner = ClassName("", ownerName)
        val fields = ClassName("", ownerName, fieldsClassName)
        val knownNames = parameters.map { it.name }.filter { it != extrasProperty }.map { wireNames[it] ?: it }

        val fieldsClass = TypeSpec.classBuilder(fieldsClassName)
            .addModifiers(KModifier.PRIVATE, KModifier.DATA)
            .addAnnotation(ClassNames.serializable)
            .primaryConstructor(FunSpec.constructorBuilder().addParameters(parameters).build())
            .addProperties(properties)
            .build()

        val fieldKeys = CodeBlock.builder().add("setOf(")
        knownNames.forEachIndexed { i, name ->
            if (i > 0) fieldKeys.add(", ")
            fieldKeys.add("%S", name)
        }
        fieldKeys.add(")")
        // An extra key is neither a property nor the enclosing union's discriminator.
        val isExtra = if (discriminator != null && discriminator !in knownNames) {
            CodeBlock.of("key !in fieldKeys && key != %S", discriminator)
        } else {
            CodeBlock.of("key !in fieldKeys")
        }

        val serializer = TypeSpec.objectBuilder(serializerObject)
            .addModifiers(KModifier.INTERNAL)
            .addSuperinterface(ClassNames.kSerializer.parameterizedBy(owner))
            .addKdoc(
                "Writes [%N] flat into the JSON object, beside the properties (the wire shape of\n" +
                    "`additionalProperties`), and reads every key that isn't a property%L back into it.\n",
                extrasProperty,
                if (discriminator != null && discriminator !in knownNames) " or `$discriminator`" else "",
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
            .addFunction(serialize(owner, fields, parameters, isExtra, extrasProperty))
            .addFunction(deserialize(owner, fields, parameters, isExtra, extrasProperty))
            .build()

        return listOf(fieldsClass, serializer)
    }

    private fun serialize(
        owner: ClassName,
        fields: ClassName,
        parameters: List<ParameterSpec>,
        isExtra: CodeBlock,
        extrasProperty: String,
    ): FunSpec {
        val args = CodeBlock.builder()
        parameters.forEachIndexed { i, p ->
            if (i > 0) args.add(", ")
            args.add("value.%N", p.name)
        }
        return FunSpec.builder("serialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("encoder", ClassNames.encoder)
            .addParameter("value", owner)
            .addStatement("val output = encoder as %T", jsonEncoder)
            .addStatement(
                "val fields = output.json.%M(%T.serializer(), %T(%L)).%M",
                MemberNames.encode,
                fields,
                fields,
                args.build(),
                jsonObjectProperty,
            )
            .beginControlFlow("val flat = %M", MemberNames.buildJsonObject)
            .addStatement("for ((key, element) in fields) if (key != %S) put(key, element)", extrasProperty)
            .addStatement(
                "fields[%S]?.%M?.forEach { (key, element) -> if (%L) put(key, element) }",
                extrasProperty,
                jsonObjectProperty,
                isExtra,
            )
            .endControlFlow()
            .addStatement("output.encodeJsonElement(flat)")
            .build()
    }

    private fun deserialize(
        owner: ClassName,
        fields: ClassName,
        parameters: List<ParameterSpec>,
        isExtra: CodeBlock,
        extrasProperty: String,
    ): FunSpec {
        val args = CodeBlock.builder()
        parameters.forEachIndexed { i, p ->
            if (i > 0) args.add(", ")
            args.add("fields.%N", p.name)
        }
        return FunSpec.builder("deserialize")
            .addModifiers(KModifier.OVERRIDE)
            .addParameter("decoder", ClassNames.decoder)
            .returns(owner)
            .addStatement("val input = decoder as %T", ClassNames.jsonDecoder)
            .addStatement("val flat = input.decodeJsonElement().%M", jsonObjectProperty)
            .beginControlFlow("val nested = %M", MemberNames.buildJsonObject)
            .addStatement("for ((key, element) in flat) if (key in fieldKeys) put(key, element)")
            .addStatement(
                "put(%S, %M { for ((key, element) in flat) if (%L) put(key, element) })",
                extrasProperty,
                MemberNames.buildJsonObject,
                isExtra,
            )
            .endControlFlow()
            .addStatement("val fields = input.json.%M(%T.serializer(), nested)", MemberNames.decode, fields)
            .addStatement("return %T(%L)", owner, args.build())
            .build()
    }
}
