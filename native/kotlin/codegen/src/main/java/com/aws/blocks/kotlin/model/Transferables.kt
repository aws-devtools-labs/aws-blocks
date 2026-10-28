package com.aws.blocks.kotlin.model

/**
 * Which way a transferable's type argument crosses the wire.
 *
 * This decides both the conversion a generated type needs and how faithful it has to be. An
 * argument the runtime decodes has to represent anything the backend might send, so narrowing it
 * drops payloads. One the runtime only encodes has to express just what a caller may send, so it
 * can be narrowed to the values the spec permits.
 */
enum class TypeArgDirection {
    /** Decoded from the wire, so generated as a type the runtime deserializes into. */
    OUT,

    /** Encoded to the wire, so it may be narrowed to the values the spec permits. */
    IN,

    /** Both decoded and encoded, which needs everything [OUT] does. */
    IN_OUT,
}

/**
 * One of a transferable's type arguments, by position.
 *
 * Direction is a fact about the runtime type's own API — which of its members take the argument
 * and which return it — rather than anything the spec says, so it is declared here per tag.
 *
 * [name] names a narrowed type, which the generator has to name itself because the spec gives the
 * values no name of their own. An [TypeArgDirection.OUT] argument is named from where it appears.
 */
data class TransferableTypeArg(
    val direction: TypeArgDirection,
    val name: String,
)

/**
 * The declared type arguments of each tag, in the order the runtime type takes them.
 *
 * A tag absent here, including one a spec declares for a third-party binding, carries only
 * [TypeArgDirection.OUT] arguments — the treatment a transferable with no narrowing gets.
 */
private val declaredTypeArgs: Map<String, List<TransferableTypeArg>> = mapOf(
    // RealtimeChannel<T> deserializes T out of the socket; nothing sends one yet.
    "realtime/channel" to listOf(TransferableTypeArg(TypeArgDirection.OUT, name = "Message")),
    // OidcClient<P> only ever sends a P, which is why its values can be narrowed to an enum.
    "oidc/client" to listOf(TransferableTypeArg(TypeArgDirection.IN, name = "Provider")),
)

/** How [transferableName] uses the type argument at [position]. */
fun transferableTypeArg(transferableName: String, position: Int): TransferableTypeArg =
    declaredTypeArgs[transferableName]?.getOrNull(position)
        ?: TransferableTypeArg(TypeArgDirection.OUT, name = "Result")

/** Whether [transferableName] narrows the type argument at [position] to the spec's values. */
fun narrowsTypeArg(transferableName: String, position: Int): Boolean =
    transferableTypeArg(transferableName, position).direction == TypeArgDirection.IN
