package com.aws.blocks.kotlin.model

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// ── Info Object Hierarchy ─────────────────────────────────────────

data class Contact(
    val name: String? = null,
    val url: String? = null,
    val email: String? = null,
)

data class License(
    val name: String,
    val url: String? = null,
)

data class Info(
    val title: String,
    val version: String,
    val description: String? = null,
    val termsOfService: String? = null,
    val contact: Contact? = null,
    val license: License? = null,
)

// ── Server Objects ────────────────────────────────────────────────

data class ServerVariable(
    val default: String,
    val description: String? = null,
    val enum: List<String> = emptyList(),
)

/** A single entry from the OpenRPC `servers` array. */
data class Server(
    val name: String,
    val url: String,
    val description: String? = null,
    val summary: String? = null,
    val variables: Map<String, ServerVariable> = emptyMap(),
)

// ── Method Metadata Classes ───────────────────────────────────────

data class ExternalDocumentation(
    val url: String,
    val description: String? = null,
)

data class Tag(
    val name: String,
    val summary: String? = null,
    val description: String? = null,
    val externalDocs: ExternalDocumentation? = null,
)

data class Link(
    val name: String,
    val summary: String? = null,
    val description: String? = null,
    val method: String? = null,
    val params: Map<String, Any>? = null,
    val server: Server? = null,
)

data class Error(
    val code: Int,
    val message: String,
    val data: TypeRef? = null,
)

data class ExamplePairing(
    val name: String,
    val summary: String? = null,
    val description: String? = null,
    val params: List<JsonElement> = emptyList(),
    val result: JsonElement? = null,
)

// ── ContentDescriptor (replaces Parameter) ────────────────────────

data class ContentDescriptor(
    val name: String,
    val schema: TypeRef,
    val description: String? = null,
    val summary: String? = null,
    val required: Boolean = false,
    val deprecated: Boolean = false,
)

// ── Field (modified: optional → required) ─────────────────────────

data class Field(
    val name: String,
    val type: TypeRef,
    val required: Boolean = false,
    val description: String? = null,
    val defaultValue: JsonElement? = null,
)

// ── Method (was MethodSignature) ──────────────────────────────────

data class Method(
    val name: String,
    val params: List<ContentDescriptor>,
    val result: ContentDescriptor? = null,
    val description: String? = null,
    val summary: String? = null,
    val tags: List<Tag> = emptyList(),
    val errors: List<Error> = emptyList(),
    val links: List<Link> = emptyList(),
    val examples: List<ExamplePairing> = emptyList(),
    val externalDocs: ExternalDocumentation? = null,
    val deprecated: Boolean = false,
    val paramStructure: String? = null,
)

// ── Root Model ────────────────────────────────────────────────────

/** Root model produced by the parser. */
data class RpcModel(
    val info: Info,
    val methods: List<Method>,
    val servers: List<Server> = emptyList(),
    val components: JsonObject? = null,
    val endpoint: String? = null,
)

/** A reference to a type, which can be primitive, inline, union, array, nullable, or imported. */
sealed interface TypeRef {
    data class Primitive(val tsType: String, val constraints: Constraints = Constraints.EMPTY) : TypeRef
    data class InlineObject(val fields: List<Field>, val additionalProperties: TypeRef? = null) : TypeRef
    /**
     * A string (or boolean) enum. [schemaName] is the component schema it was reached through by
     * a `${'$'}ref`, which makes it one named enum shared by every use; it is null for an inline enum.
     * [literals] are the values as the spec writes them, with their JSON types (`true`, `5`, `"a"`):
     * [values] holds their text, so a boolean `true` and a string `"true"` are told apart only here.
     */
    data class UnionLiteral(
        val values: List<String>,
        val schemaName: String? = null,
        val literals: List<JsonPrimitive> = values.map(::JsonPrimitive),
    ) : TypeRef
    data class ArrayType(val elementType: TypeRef, val constraints: Constraints = Constraints.EMPTY) : TypeRef
    data class MapType(val valueType: TypeRef) : TypeRef
    data class TupleType(val elements: List<TypeRef>) : TypeRef
    data class Nullable(val inner: TypeRef) : TypeRef
    data class Union(val members: List<TypeRef>) : TypeRef
    data class SchemaRef(val schemaName: String, val resolved: InlineObject, val description: String? = null) : TypeRef
    data class Transferable(val transferableName: String, val typeArgs: List<TypeRef>) : TypeRef
    data class ObjectWithOneOf(val fields: List<Field>, val oneOf: List<TypeRef>) : TypeRef
}
