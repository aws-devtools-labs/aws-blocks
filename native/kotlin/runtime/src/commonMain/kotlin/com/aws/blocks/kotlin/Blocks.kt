package com.aws.blocks.kotlin

/**
 * The entry point to a Blocks backend.
 *
 * One instance holds one [BlocksClient], and therefore one HTTP engine and connection pool, for
 * every API generated from the spec. Generated code adds one extension property per API namespace,
 * so a single instance reaches all of them:
 *
 * ```
 * val blocks = Blocks(Servers.local)
 * val todos = blocks.api.listTodos()
 * val user = blocks.authCognito.currentUser()
 * ```
 *
 * Those properties build a thin wrapper over [client] on each access, so holding on to one of them
 * buys nothing. Hold the instance instead, for as long as the backend is in use, and [close] it
 * once it is not.
 */
class Blocks(
    val server: BlocksServer,
) : AutoCloseable {

    /**
     * The client every API generated for [server] runs its requests through. Generated extension
     * properties read it; callers who need to issue a request the spec does not describe can use
     * it directly.
     */
    val client: BlocksClient = BlocksClient(server)

    /**
     * Shuts down the HTTP engine this instance owns. Requests issued through any API obtained from
     * it fail afterwards, so close it only once the backend is no longer in use.
     */
    override fun close() {
        client.httpClient.close()
    }
}
