package com.aws.blocks.kotlin.model

/**
 * How a transferable uses one of its type arguments, which decides whether the values a spec
 * permits for it can become a closed type.
 *
 * Direction is a fact about the runtime type's own API — which of its members take the argument
 * and which return it — rather than anything the spec says, so it is declared here per tag.
 */
sealed interface TransferableTypeArg {

    /**
     * An argument the runtime decodes, whether or not it also encodes it. It has to represent
     * anything the backend may send, so it is generated from the spec's schema and never narrowed:
     * narrowing it would drop whatever arrives that the narrowed type can't hold.
     */
    data object Decoded : TransferableTypeArg

    /**
     * An argument the runtime only ever encodes. It has to express just what a caller may send, so
     * it is narrowed to the values the spec permits.
     *
     * [name] names the generated enum, which the generator has to supply because the spec gives
     * the values no name of their own.
     */
    data class Narrowed(val name: String) : TransferableTypeArg
}

/**
 * The declared type arguments of each tag, in the order the runtime type takes them.
 *
 * A tag absent here, including one a spec declares for a third-party binding, carries only
 * [TransferableTypeArg.Decoded] arguments — the treatment a transferable with no narrowing gets.
 */
private val declaredTypeArgs: Map<String, List<TransferableTypeArg>> = mapOf(
    // RealtimeChannel<T> deserializes T out of the socket; nothing sends one yet.
    "realtime/channel" to listOf(TransferableTypeArg.Decoded),
    // OidcClient<P> only ever sends a P, which is why its values can be narrowed to an enum.
    "oidc/client" to listOf(TransferableTypeArg.Narrowed(name = "Provider")),
)

/** How [transferableName] uses the type argument at [position]. */
fun transferableTypeArg(transferableName: String, position: Int): TransferableTypeArg =
    declaredTypeArgs[transferableName]?.getOrNull(position) ?: TransferableTypeArg.Decoded

/** Whether [transferableName] narrows the type argument at [position] to the spec's values. */
fun narrowsTypeArg(transferableName: String, position: Int): Boolean =
    transferableTypeArg(transferableName, position) is TransferableTypeArg.Narrowed
