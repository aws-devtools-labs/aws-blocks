package com.aws.blocks.kotlin.generator

import com.aws.blocks.kotlin.NamingUtils
import com.squareup.kotlinpoet.AnnotationSpec
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.TypeSpec

/**
 * Wire mapping for a tuple: a schema with `prefixItems` (or array-form `items`), such as
 * TypeScript's `[number, number]` (`DistributedTable`'s `where.between`).
 *
 * The generated class keeps one property per element (`item0`, `item1`, …), but on the wire a
 * tuple is a JSON array of their values, in order: `[1, 2]`, never `{"item0":1,"item1":2}`. The
 * serialization plugin writes a class as an object, so a tuple gets a custom serializer
 * ([SERIALIZER_OBJECT]) that writes and reads the array, each element with the
 * [kotlinx.serialization.json.Json] coding the tuple (an `OidcClient` value binds to the calling
 * client). An element missing from a shorter array (an optional element, TypeScript
 * `[string, number?]`) decodes as `null`.
 */
internal object TupleSerializerGenerator {
    /** The nested custom serializer of a tuple. It steps aside for a property of that name. */
    const val SERIALIZER_OBJECT = "TupleSerializer"

    private val jsonArrayClass = ClassName("kotlinx.serialization.json", "JsonArray")
    private val serializationException = ClassName("kotlinx.serialization", "SerializationException")

    /** The name of the serializer in a tuple whose properties are [propertyNames]. */
    fun serializerName(propertyNames: Collection<String>): String =
        NamingUtils.nestedTypeNamesBeside(propertyNames, listOf(SERIALIZER_OBJECT)).single()

    /** `@Serializable(with = <ownerName>.<serializerObject>::class)`, written as names (see [OpenRecordSerializerGenerator]). */
    fun serializableAnnotation(ownerName: String, serializerObject: String): AnnotationSpec =
        AnnotationSpec.builder(ClassNames.serializable)
            .addMember("with = %N.%N::class", ownerName, serializerObject)
            .build()

    /**
     * The serializer object [serializerObject] for the tuple [ownerName], whose elements are its
     * [properties] in order, each read and written with its [UnionSerializerGenerator.ValueCoding].
     */
    fun generate(
        ownerName: String,
        serializerObject: String,
        properties: List<Pair<String, UnionSerializerGenerator.ValueCoding>>,
    ): TypeSpec {
        val owner = ClassName("", ownerName)
        val count = properties.size
        val serialize = CodeBlock.builder()
            .addStatement(
                "val output = encoder as? %T ?: throw %T(%S)",
                ClassNames.jsonEncoder,
                serializationException,
                "$ownerName can only be written as JSON",
            )
            .beginControlFlow("val element = %M", MemberNames.buildJsonArray)
        for ((property, coding) in properties) {
            val value = CodeBlock.of("value.%N", property)
            val encoded = if (coding.serializer != null) {
                CodeBlock.of("output.json.%M(%L, %L)", MemberNames.encode, coding.serializer, value)
            } else {
                CodeBlock.of("output.json.%M<%T>(%L)", MemberNames.encode, coding.type, value)
            }
            serialize.addStatement("add(%L)", encoded)
        }
        serialize.endControlFlow().addStatement("output.encodeJsonElement(element)")

        val deserialize = CodeBlock.builder()
            .addStatement(
                "val input = decoder as? %T ?: throw %T(%S)",
                ClassNames.jsonDecoder,
                serializationException,
                "$ownerName can only be read from JSON",
            )
            .addStatement(
                "val element = input.decodeJsonElement() as? %T ?: throw %T(%S)",
                jsonArrayClass,
                serializationException,
                "$ownerName is a JSON array of $count element${if (count == 1) "" else "s"}",
            )
            .add("return %T(\n", owner)
            .indent()
        for ((i, pair) in properties.withIndex()) {
            val coding = pair.second
            val element = CodeBlock.of("element.getOrElse(%L) { %T }", i, ClassNames.jsonNull)
            val decoded = if (coding.serializer != null) {
                CodeBlock.of("input.json.%M(%L, %L)", MemberNames.decode, coding.serializer, element)
            } else {
                CodeBlock.of("input.json.%M<%T>(%L)", MemberNames.decode, coding.type, element)
            }
            deserialize.add("%L,\n", decoded)
        }
        deserialize.unindent().add(")\n")

        return TypeSpec.objectBuilder(serializerObject)
            .addSuperinterface(ClassNames.kSerializer.parameterizedBy(owner))
            .addKdoc("Reads and writes [%N] as a JSON array of its elements, in order.\n", ownerName)
            .addProperty(
                PropertySpec.builder("descriptor", ClassNames.serialDescriptor, KModifier.OVERRIDE)
                    .initializer("%M(%S)", MemberNames.buildClassSerialDescriptor, ownerName)
                    .build(),
            )
            .addFunction(
                FunSpec.builder("serialize")
                    .addModifiers(KModifier.OVERRIDE)
                    .addParameter("encoder", ClassNames.encoder)
                    .addParameter("value", owner)
                    .addCode(serialize.build())
                    .build(),
            )
            .addFunction(
                FunSpec.builder("deserialize")
                    .addModifiers(KModifier.OVERRIDE)
                    .addParameter("decoder", ClassNames.decoder)
                    .returns(owner)
                    .addCode(deserialize.build())
                    .build(),
            )
            .build()
    }
}
