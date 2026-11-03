package com.aws.blocks.kotlin

import io.ktor.client.engine.HttpClientEngine

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
 * reach a different server from a multi-server spec, as in `Blocks(Servers.sandbox)`. Pass a
 * [BlocksConfig] to configure anything else:
 *
 * ```
 * val blocks = Blocks(
 *     BlocksConfig(
 *         server = Servers.prod,
 *         platformConfig = BlocksPlatformConfig(/* target-specific values */),
 *     ),
 * )
 * ```
 *
 * The instance also owns the cookie jar its session lives in, which is why two instances
 * configured with different storage hold different sessions. On the JVM, an instance configured
 * with no storage location keeps its session in memory and forgets it when the process ends — see
 * [BlocksPlatformConfig].
 *
 * Each access to a generated property builds a new wrapper over [client], so keep one where a
 * stable reference matters — a Compose parameter, say. The instance is what owns the engine, and
 * what to [close] once the backend is no longer in use.
 */
class Blocks internal constructor(
    config: BlocksConfig,
    engine: HttpClientEngine?,
) : AutoCloseable {

    /** Configures the instance. [BlocksConfig.platformConfig] carries the target-specific values. */
    constructor(config: BlocksConfig) : this(config, engine = null)

    /** Reaches [server] with every other value left at its default. */
    constructor(server: BlocksServer) : this(BlocksConfig(server), engine = null)

    // Nothing public on this class may be a property, which is why the server is not one. A spec
    // may name a namespace anything, a member always wins over an extension of the same name, and
    // that leaves the generated accessor unreachable behind nothing louder than a compiler
    // warning. Functions are safe: a member function and an extension property can share a name.
    private val cookies = cookieJar(config.platformConfig)

    private val client: BlocksClient = BlocksClient(config.server, defaultHttpClient(engine, cookies))

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
     * Drops everything this instance has stored, including the session cookie.
     *
     * This is not how to sign out. A sign-out is a call to the backend's own sign-out, which
     * revokes the session server-side and expires the cookie as part of its response; dropping
     * the cookie here instead leaves a live session on the server that the caller believes is
     * gone. This exists so a test suite can start from a clean slate on the targets where storage
     * cannot be pointed somewhere disposable — Android and iOS, where the OS supplies the
     * location. On the JVM, configure a [BlocksPlatformConfig.storageLocation] in a temporary
     * directory instead.
     */
    @InternalBlocksApi
    suspend fun clearStoredState() {
        cookies.clear()
    }

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
