// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.generator

import com.aws.blocks.kotlin.model.ResolvedType
import com.aws.blocks.kotlin.model.UnionVariant
import com.squareup.kotlinpoet.AnnotationSpec
import com.squareup.kotlinpoet.ClassName
import com.squareup.kotlinpoet.CodeBlock
import com.squareup.kotlinpoet.FunSpec
import com.squareup.kotlinpoet.KModifier
import com.squareup.kotlinpoet.ParameterizedTypeName.Companion.parameterizedBy
import com.squareup.kotlinpoet.PropertySpec
import com.squareup.kotlinpoet.STRING
import com.squareup.kotlinpoet.TypeSpec
import com.squareup.kotlinpoet.asTypeName
import com.squareup.kotlinpoet.joinToCode

/**
 * An open enum: a string enum a response can carry, so a value a newer backend adds decodes
 * instead of throwing `SerializationException`.
 *
 * It is a sealed class whose known values are `data object`s (`Status.Todo`, spelled as an enum
 * constant would be), plus `Unknown`, which holds a value the client was generated without as the
 * server sent it. Every case has the wire string as `value`, and a generated string serializer
 * writes it back, so an unknown value round-trips. The companion's `entries` lists the known
 * cases in spec order. A `when` over the class is exhaustive with the known cases plus
 * `is Unknown`.
 */
internal object OpenEnumGenerator {
    private val primitiveSerialDescriptor = ClassName("kotlinx.serialization.descriptors", "PrimitiveSerialDescriptor")
    private val primitiveKindString = ClassName("kotlinx.serialization.descriptors", "PrimitiveKind", "STRING")

    /**
     * The sealed class [name] for an enum of [constants] (each a constant name and the literal it
     * serializes as). [literal] writes a wire string as a Kotlin string literal. [serialName]
     * names the serializer's descriptor; qualified, so it can't be a built-in type's name.
     */
    fun generate(
        name: String,
        constants: List<Pair<String, String>>,
        serialName: String,
        literal: (String) -> String,
    ): TypeSpec {
        // Compared without case: these are nested classes, and on a case-insensitive file system
        // `Unknown` and `UNKNOWN` would be one class file. The enum's own name is taken too.
        val taken = (constants.map { it.first } + name).map { it.lowercase() }.toSet()
        // A spec value named `unknown` keeps its constant; the fallback steps aside.
        val unknown = if ("unknown" in taken) free("UnknownValue", taken) else "Unknown"
        val serializer = free("Serializer", taken + unknown.lowercase())
        // A constant named `Companion` would clash with the default companion object's name.
        val companion = if ("companion" in taken) {
            free("Known", taken + unknown.lowercase() + serializer.lowercase())
        } else {
            null
        }
        val self = ClassName("", name)

        val builder = TypeSpec.classBuilder(name)
            .addModifiers(KModifier.SEALED)
            .addAnnotation(
                AnnotationSpec.builder(ClassNames.serializable)
                    .addMember("with = %N.%N::class", name, serializer)
                    .build(),
            )
            .addProperty(
                PropertySpec.builder("value", STRING, KModifier.ABSTRACT)
                    .build(),
            )

        for ((constant, wire) in constants) {
            builder.addType(
                TypeSpec.objectBuilder(constant)
                    .addModifiers(KModifier.DATA)
                    .superclass(self)
                    .addProperty(
                        PropertySpec.builder("value", STRING, KModifier.OVERRIDE)
                            .initializer("%L", literal(wire))
                            .build(),
                    )
                    .build(),
            )
        }

        builder.addType(
            TypeSpec.classBuilder(unknown)
                .addModifiers(KModifier.DATA)
                .superclass(self)
                .primaryConstructor(FunSpec.constructorBuilder().addParameter("value", STRING).build())
                .addProperty(PropertySpec.builder("value", STRING, KModifier.OVERRIDE).initializer("value").build())
                .build(),
        )

        val knownList = List::class.asTypeName().parameterizedBy(self)
        builder.addType(
            TypeSpec.companionObjectBuilder(companion)
                .addProperty(
                    PropertySpec.builder("entries", knownList)
                        // Lazy: the cases' objects extend this class, so one first touched (`X.A`)
                        // initializes the companion before it is assigned itself.
                        .delegate(
                            CodeBlock.of(
                                "lazy { listOf(%L) }",
                                constants.map { CodeBlock.of("%N", it.first) }.joinToCode(", "),
                            ),
                        )
                        .build(),
                )
                .addFunction(
                    FunSpec.builder("fromValue")
                        .addParameter("value", STRING)
                        .returns(self)
                        .addStatement("return entries.firstOrNull { it.value == value } ?: %N(value)", unknown)
                        .build(),
                )
                .build(),
        )

        builder.addType(
            TypeSpec.objectBuilder(serializer)
                .addSuperinterface(ClassNames.kSerializer.parameterizedBy(self))
                .addProperty(
                    PropertySpec.builder("descriptor", ClassNames.serialDescriptor, KModifier.OVERRIDE)
                        .initializer("%T(%S, %T)", primitiveSerialDescriptor, serialName, primitiveKindString)
                        .build(),
                )
                .addFunction(
                    FunSpec.builder("serialize")
                        .addModifiers(KModifier.OVERRIDE)
                        .addParameter("encoder", ClassNames.encoder)
                        .addParameter("value", self)
                        .addStatement("encoder.encodeString(value.value)")
                        .build(),
                )
                .addFunction(
                    FunSpec.builder("deserialize")
                        .addModifiers(KModifier.OVERRIDE)
                        .addParameter("decoder", ClassNames.decoder)
                        .returns(self)
                        .addStatement("return fromValue(decoder.decodeString())")
                        .build(),
                )
                .build(),
        )
        return builder.build()
    }

    /** [base], or `base2`, `base3`, … while a name in [taken] (lowercased) has it, ignoring case. */
    fun free(base: String, taken: Set<String>): String {
        if (base.lowercase() !in taken) return base
        var attempt = 2
        while ("$base$attempt".lowercase() in taken) attempt++
        return "$base$attempt"
    }

    /**
     * The names of the types an operation's result declares directly in its operation object
     * (`Result`, or an enum, record or union the result is a list, map or optional of). The types
     * nested in them belong to the result too. An `oidc/client`'s type argument names the
     * providers a caller may pass, so it isn't a response position.
     */
    fun resultRootNames(result: ResolvedType): Set<String> {
        val names = mutableSetOf<String>()
        fun walk(type: ResolvedType) {
            when (type) {
                is ResolvedType.Record -> names.add(type.name)
                is ResolvedType.Enum -> names.add(type.name)
                is ResolvedType.Union -> names.add(type.name)
                is ResolvedType.TupleType -> names.add(type.name)
                is ResolvedType.ListType -> walk(type.elementType)
                is ResolvedType.MapType -> walk(type.valueType)
                is ResolvedType.Nullable -> walk(type.inner)
                is ResolvedType.Transferable ->
                    if (type.transferableName != "oidc/client") type.typeArgs.forEach(::walk)
                else -> Unit
            }
        }
        walk(result)
        return names
    }

    /**
     * Every named type an operation's result reaches, at any depth, following a reference into
     * [definitions]: records, union arms, lists, maps, optionals, tuples and transferable type
     * arguments (except an `oidc/client`'s).
     */
    fun reachableNames(results: List<ResolvedType>, definitions: Map<String, ResolvedType>): Set<String> {
        val open = mutableSetOf<String>()
        val closed = mutableSetOf<String>()
        val followedOpen = mutableSetOf<String>()
        val followedClosed = mutableSetOf<String>()
        fun walk(type: ResolvedType, isClosed: Boolean) {
            val names = if (isClosed) closed else open
            // An inline type counts only when it is the definition of its name, not one nested in an
            // operation or another schema that shares the name (a result's inline `mode` enum beside a
            // component `Mode` only a parameter uses).
            fun record(name: String, type: ResolvedType) {
                if (definitions[name] == type) names.add(name)
            }
            fun next(type: ResolvedType) = walk(type, isClosed)
            when (type) {
                is ResolvedType.Record -> {
                    record(type.name, type)
                    type.fields.forEach { next(it.type) }
                    type.additionalPropertiesType?.let(::next)
                }
                is ResolvedType.Enum -> record(type.name, type)
                is ResolvedType.Union -> {
                    record(type.name, type)
                    for (variant in type.variants) {
                        // Without a discriminator the arms are tried in turn, so an open enum inside an
                        // arm would let the first arm with matching keys take an object meant for a later
                        // one: everything such an arm reaches is closed, wherever else it appears.
                        val armClosed = isClosed ||
                            (type.discriminator == null && !isEnumSchemaArm(variant, definitions))
                        fun arm(type: ResolvedType) = walk(type, armClosed)
                        variant.fields.forEach { arm(it.type) }
                        variant.additionalPropertiesType?.let(::arm)
                        variant.embeddedUnion?.let(::arm)
                        variant.valueType?.let(::arm)
                        variant.payloadTypeName?.let { arm(ResolvedType.TypeReference(it)) }
                        variant.nestedTypes.forEach { arm(it.type) }
                    }
                }
                is ResolvedType.TypeReference -> {
                    names.add(type.name)
                    val followed = if (isClosed) followedClosed else followedOpen
                    if (followed.add(type.name)) definitions[type.name]?.let(::next)
                }
                is ResolvedType.TupleType -> {
                    record(type.name, type)
                    type.elements.forEach(::next)
                }
                is ResolvedType.ListType -> next(type.elementType)
                is ResolvedType.MapType -> next(type.valueType)
                is ResolvedType.Nullable -> next(type.inner)
                is ResolvedType.Transferable ->
                    if (type.transferableName != "oidc/client") type.typeArgs.forEach(::next)
                is ResolvedType.Primitive, is ResolvedType.FormattedType -> Unit
            }
        }
        results.forEach { walk(it, false) }
        return open - closed
    }

    /** An arm that is an enum schema matches by its literal values, so an open one stays safe. */
    private fun isEnumSchemaArm(variant: UnionVariant, definitions: Map<String, ResolvedType>): Boolean =
        variant.payloadTypeName?.let { definitions[it] is ResolvedType.Enum } == true

}
