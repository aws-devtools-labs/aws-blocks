package com.aws.blocks.kotlin.generator

import com.aws.blocks.kotlin.model.ResolvedType
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
        val taken = constants.map { it.first }.toSet()
        // A spec value named `unknown` keeps its constant; the fallback steps aside.
        val unknown = if ("Unknown" in taken) free("UnknownValue", taken) else "Unknown"
        val serializer = free("Serializer", taken + unknown)
        val self = ClassName("", name)

        val builder = TypeSpec.classBuilder(name)
            .addModifiers(KModifier.SEALED)
            .addAnnotation(
                AnnotationSpec.builder(ClassNames.serializable)
                    .addMember("with = %N.%N::class", name, serializer)
                    .build(),
            )
            .addKdoc("A string enum that keeps a value this client was generated without as [%N].\n", unknown)
            .addProperty(
                PropertySpec.builder("value", STRING, KModifier.ABSTRACT)
                    .addKdoc("The value as it is sent on the wire.\n")
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
                .addKdoc("A value this client was generated without, as the server sent it.\n")
                .superclass(self)
                .primaryConstructor(FunSpec.constructorBuilder().addParameter("value", STRING).build())
                .addProperty(PropertySpec.builder("value", STRING, KModifier.OVERRIDE).initializer("value").build())
                .build(),
        )

        val knownList = List::class.asTypeName().parameterizedBy(self)
        builder.addType(
            TypeSpec.companionObjectBuilder()
                .addProperty(
                    PropertySpec.builder("entries", knownList)
                        .addKdoc("The known values, in the spec's order.\n")
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
                        .addKdoc("The case for [value]: a known one, else [%N].\n", unknown)
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

    /** [base], or `base2`, `base3`, … while a constant has it. */
    private fun free(base: String, taken: Set<String>): String {
        if (base !in taken) return base
        var attempt = 2
        while ("$base$attempt" in taken) attempt++
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
        val names = mutableSetOf<String>()
        val followed = mutableSetOf<String>()
        fun walk(type: ResolvedType) {
            when (type) {
                is ResolvedType.Record -> {
                    names.add(type.name)
                    type.fields.forEach { walk(it.type) }
                    type.additionalPropertiesType?.let(::walk)
                }
                is ResolvedType.Enum -> names.add(type.name)
                is ResolvedType.Union -> {
                    names.add(type.name)
                    for (variant in type.variants) {
                        variant.fields.forEach { walk(it.type) }
                        variant.additionalPropertiesType?.let(::walk)
                        variant.embeddedUnion?.let(::walk)
                        variant.valueType?.let(::walk)
                        variant.payloadTypeName?.let { walk(ResolvedType.TypeReference(it)) }
                    }
                }
                is ResolvedType.TypeReference -> {
                    names.add(type.name)
                    if (followed.add(type.name)) definitions[type.name]?.let(::walk)
                }
                is ResolvedType.TupleType -> {
                    names.add(type.name)
                    type.elements.forEach(::walk)
                }
                is ResolvedType.ListType -> walk(type.elementType)
                is ResolvedType.MapType -> walk(type.valueType)
                is ResolvedType.Nullable -> walk(type.inner)
                is ResolvedType.Transferable ->
                    if (type.transferableName != "oidc/client") type.typeArgs.forEach(::walk)
                is ResolvedType.Primitive, is ResolvedType.FormattedType -> Unit
            }
        }
        results.forEach(::walk)
        return names
    }
}
