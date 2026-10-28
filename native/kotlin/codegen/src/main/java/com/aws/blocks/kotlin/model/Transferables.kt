package com.aws.blocks.kotlin.model

/**
 * What a transferable's `x-blocks-type-args[0]` means, which decides whether it becomes a type.
 *
 * The spec carries both meanings in the same field, so the role can't be read off a type argument
 * itself: a realtime channel of string-literal messages and an OIDC client's provider names are
 * both a string enum in the spec.
 */
enum class TypeArgRole {
    /**
     * A payload that crosses the wire, generated as a type the runtime decodes into. A nested
     * transferable hydrates too, so its argument is generated wherever it appears.
     */
    DATA,

    /**
     * The values a hydrated client accepts for a parameter, generated as an enum of them that
     * types the client. Only generated for an operation's own result: a transferable in any other
     * position doesn't hydrate, so nothing could reference the enum.
     */
    PARAMETER_VALUES,
}

/**
 * How a transferable tag's type argument is treated, independent of target language.
 *
 * [typeArgName] names the generated type for a [TypeArgRole.PARAMETER_VALUES] argument, since the
 * spec gives it no name of its own.
 */
data class TransferableTypeArg(
    val role: TypeArgRole,
    val typeArgName: String,
)

/**
 * Tags whose type argument isn't a payload. A tag absent here is [TypeArgRole.DATA], which is the
 * behaviour for a transferable that declares no type argument at all.
 */
private val typeArgRoles: Map<String, TransferableTypeArg> = mapOf(
    "oidc/client" to TransferableTypeArg(TypeArgRole.PARAMETER_VALUES, typeArgName = "Provider"),
)

/** How [transferableName]'s type argument is treated. */
fun transferableTypeArg(transferableName: String): TransferableTypeArg =
    typeArgRoles[transferableName] ?: TransferableTypeArg(TypeArgRole.DATA, typeArgName = "Result")
