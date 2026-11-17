package com.aws.blocks.kotlin.model

/**
 * Which way one of a transferable's type arguments crosses the wire.
 *
 * Direction is a fact about the runtime type's own API — which of its members take the argument and
 * which return it — rather than anything the spec says, so it is declared here per tag.
 *
 * It decides how faithful a generated type has to be. An argument the runtime returns has to
 * represent anything the backend may send, so narrowing it would drop whatever arrives that the
 * narrowed type can't hold. One the runtime only takes has to express just what a caller may send,
 * so it can be narrowed to the values the spec permits.
 */
sealed interface TransferableTypeArg {

    /** Returned by the runtime, so generated from the spec's schema and never narrowed. */
    data object Out : TransferableTypeArg

    /** Both taken and returned, which needs everything [Out] does. */
    data object InOut : TransferableTypeArg

    /**
     * Only ever taken by the runtime, so narrowed to the values the spec permits.
     *
     * [name] names the generated enum, which the generator has to supply because the spec gives
     * the values no name of their own. Only this direction has one: the others are generated from
     * the spec's schema, which names them from where they appear.
     */
    data class In(val name: String) : TransferableTypeArg
}

/**
 * The declared type arguments of each tag, in the order the runtime type takes them.
 *
 * A tag absent here, including one a spec declares for a third-party binding, carries only
 * [TransferableTypeArg.Out] arguments — the treatment a transferable with no narrowing gets.
 */
private val declaredTypeArgs: Map<String, List<TransferableTypeArg>> = mapOf(
    // RealtimeChannel<T> returns T out of the socket; nothing sends one yet.
    "realtime/channel" to listOf(TransferableTypeArg.Out),
    // OidcClient<P> only ever takes a P, which is why its values can be narrowed to an enum.
    "oidc/client" to listOf(TransferableTypeArg.In(name = "Provider")),
)

/** How [transferableName] uses the type argument at [position]. */
fun transferableTypeArg(transferableName: String, position: Int): TransferableTypeArg =
    declaredTypeArgs[transferableName]?.getOrNull(position) ?: TransferableTypeArg.Out

/** Whether [transferableName] narrows the type argument at [position] to the spec's values. */
fun narrowsTypeArg(transferableName: String, position: Int): Boolean =
    transferableTypeArg(transferableName, position) is TransferableTypeArg.In
