package com.aws.blocks.kotlin

/**
 * The entry point to a Blocks backend.
 *
 * One instance holds one [BlocksClient], and therefore one HTTP engine, for every RPC call the
 * generated APIs make and for the [com.aws.blocks.kotlin.oidc.OidcClient] they hand out. File
 * handles and realtime channels still open their own. Generated code adds one extension property
 * per API namespace, so a single instance reaches all of them:
 *
 * ```
 * val blocks = Blocks()
 * val todos = blocks.api.listTodos()
 * val state = blocks.authApi.getAuthState()
 * ```
 *
 * `Blocks()` comes from generated code and follows the server the spec declares; pass one to
 * reach a different server from a multi-server spec, as in `Blocks(Servers.sandbox)`.
 *
 * Each access to a generated property builds a new wrapper over [client], so keep one where a
 * stable reference matters — a Compose parameter, say. The instance is what owns the engine, and
 * what to [close] once the backend is no longer in use.
 */
class Blocks(
    server: BlocksServer,
) : AutoCloseable {

    // Nothing public on this class may be a property, which is why the server is not one. A spec
    // may name a namespace anything, a member always wins over an extension of the same name, and
    // that leaves the generated accessor unreachable behind nothing louder than a compiler
    // warning. Functions are safe: a member function and an extension property can share a name.
    private val client: BlocksClient = BlocksClient(server)

    /**
     * The client every API generated for this instance runs its requests through, the same one on
     * every call. Generated extension properties read it; callers who need to issue a request the
     * spec does not describe can use it directly.
     *
     * This is a function rather than a property so that a spec may declare a namespace named
     * `client` without the generated accessor for it being shadowed. See the note above.
     */
    fun client(): BlocksClient = client

    /**
     * Shuts down the HTTP engine this instance owns. Requests issued through any API obtained from
     * it, and through any OIDC client it handed out, then fail with a
     * [com.aws.blocks.kotlin.exceptions.BlocksException] naming the closed instance. Closing more
     * than once does nothing.
     */
    override fun close() {
        client.close()
    }

    /**
     * Exists so generated code can add an `invoke` accessor for the server its spec declares,
     * letting callers write `Blocks()` without naming one.
     */
    companion object
}
