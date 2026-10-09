package com.aws.blocks.kotlin.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// ── Primitive Kind ────────────────────────────────────────────────

enum class PrimitiveKind {
    STRING, BOOLEAN, INTEGER, NUMBER, VOID, UNKNOWN
}

// ── Format Kind ──────────────────────────────────────────────────

enum class FormatKind {
    DATE_TIME,  // kotlinx.datetime.Instant
    DATE,       // kotlinx.datetime.LocalDate
    TIME,       // kotlinx.datetime.LocalTime
    UUID,       // kotlin.uuid.Uuid
}

// ── ResolvedType Sealed Hierarchy ─────────────────────────────────

/** A fully resolved, language-independent type ready for translation to any target language. */
sealed interface ResolvedType {

    /** Primitive types: String, Boolean, Int, Double, Unit, Any */
    data class Primitive(val kind: PrimitiveKind, val constraints: Constraints = Constraints.EMPTY) : ResolvedType

    /** A type whose Kotlin representation is determined by its JSON Schema `format` keyword. */
    data class FormattedType(val format: FormatKind, val constraints: Constraints = Constraints.EMPTY) : ResolvedType

    /** Named record type with resolved fields. */
    data class Record(
        val name: String,
        val fields: List<ResolvedField>,
        val description: String? = null,
        val additionalPropertiesType: ResolvedType? = null,
    ) : ResolvedType

    /** Enum type with string literal values. */
    data class Enum(
        val name: String,
        val values: List<String>,
    ) : ResolvedType

    /** List/array type. */
    data class ListType(val elementType: ResolvedType, val constraints: Constraints = Constraints.EMPTY) : ResolvedType

    /** Map type (object with additionalProperties). */
    data class MapType(val valueType: ResolvedType) : ResolvedType

    /** Tuple type (fixed-length heterogeneous list). */
    data class TupleType(val name: String, val elements: List<ResolvedType>) : ResolvedType

    /** Nullable wrapper. */
    data class Nullable(val inner: ResolvedType) : ResolvedType

    /** Sealed/union type with variant members. */
    data class Union(
        val name: String,
        val variants: List<UnionVariant>,
        val discriminator: DiscriminatorInfo?,
    ) : ResolvedType

    /** Reference to a named type defined elsewhere in the model. */
    data class TypeReference(val name: String) : ResolvedType

    /** A transferable type that maps to a hydrated live object (e.g., RealtimeChannel, FileDownloadHandle). */
    data class Transferable(val transferableName: String, val typeArgs: List<ResolvedType>) : ResolvedType
}

// ── Supporting Types ──────────────────────────────────────────────

data class ResolvedField(
    val name: String,
    val type: ResolvedType,
    val required: Boolean,
    val description: String? = null,
    val constraints: Constraints = Constraints.EMPTY,
    val defaultValue: JsonElement? = null,
)

/**
 * One arm of a union. An object arm has [fields] (and maybe [additionalPropertiesType] or an
 * [embeddedUnion]); on the wire it is that JSON object. Two other kinds carry no fields:
 *
 * - a **value arm** ([valueType] set): a string, number, boolean, `unknown`, formatted string,
 *   array, map or transferable, or a nullable of one. On the wire it is that bare JSON value
 *   (`"abc"`, `[1, 2]`), so its Kotlin class holds it as `value`.
 * - a **literal arm** ([literal] set): a `const` or an `enum` arm, matched by its exact JSON
 *   literals (`true`, `5`, `"auto"`).
 *
 * [discriminatorLiteral] is [discriminatorValue] with the JSON type the spec gives it (`false`,
 * not `"false"`).
 */
data class UnionVariant(
    val name: String,
    val fields: List<ResolvedField>,
    val discriminatorValue: String? = null,
    val embeddedUnion: ResolvedType.Union? = null,
    val payloadTypeName: String? = null,
    val additionalPropertiesType: ResolvedType? = null,
    val nestedTypes: List<NestedTypeNode> = emptyList(),
    val valueType: ResolvedType? = null,
    val literal: List<JsonPrimitive>? = null,
    val discriminatorLiteral: JsonPrimitive? = null,
)

data class DiscriminatorInfo(
    val fieldName: String,
    /** Discriminator value → variant name */
    val variants: Map<String, String>,
    val type: DiscriminatorType = DiscriminatorType.STRING,
)

/** The JSON type of a union's discriminator values. */
enum class DiscriminatorType {
    /** Every value is a JSON string: kotlinx's `@JsonClassDiscriminator` reads and writes it. */
    STRING,
    /** Every value is a JSON boolean. */
    BOOLEAN,
    /** Numbers, or a mix of JSON types. */
    OTHER,
}

data class ServerDefinition(
    val name: String,
    val url: String,
)

// ── Root Model and Structure ──────────────────────────────────────

data class CodegenModel(
    val apiNamespaces: List<ApiNamespace>,
    val typeDefinitions: List<TypeDefinition>,
    val servers: List<ServerDefinition>,
    val endpoint: String?,
)

data class ApiNamespace(
    val name: String,
    val operations: List<Operation>,
)

/**
 * One method of an [ApiNamespace]. [name] is its local name (after the namespace), and
 * [rpcMethod] the spec's method name, which a call sends as the JSON-RPC `method` exactly: a
 * method with no dot is grouped under `_default`, but its wire name is still `ping`.
 */
data class Operation(
    val name: String,
    val parameters: List<OperationParameter>,
    val result: OperationResult,
    val description: String?,
    val nestedTypes: List<NestedTypeNode> = emptyList(),
    val rpcMethod: String = name,
)

data class NestedTypeNode(
    val name: String,
    val type: ResolvedType,
    val children: List<NestedTypeNode> = emptyList(),
)

data class OperationParameter(
    val name: String,
    val type: ResolvedType,
    val required: Boolean,
    val description: String?,
)

data class OperationResult(
    val type: ResolvedType,
    val description: String?
)

data class TypeDefinition(
    val name: String,
    val type: ResolvedType,
    val shortName: String = name,
    val parentSchema: String? = null,
)

