@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.InternalBlocksApi
import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import java.net.InetAddress
import java.net.InetSocketAddress
import java.util.concurrent.Executors
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

internal actual fun createPlatformLauncher(): OidcPlatformLauncher = JvmOidcLauncher()

internal class JvmOidcLauncher(
    private val browserOpener: BrowserOpener = SystemBrowserOpener,
    private val timeout: Duration = 5.minutes,
) : OidcPlatformLauncher {
    /**
     * The relay target is a loopback address bound here, so [configuredRelayTo] is unused:
     * the port is assigned by the operating system for each sign-in attempt.
     */
    override suspend fun openSession(configuredRelayTo: String): OidcRedirectSession =
        JvmLoopbackSession(browserOpener, timeout)
}

/**
 * Receives the relay redirect on a loopback address bound for one sign-in attempt.
 *
 * The authorization code arrives over plaintext loopback HTTP, which is what native apps
 * are expected to do; PKCE is what protects the code, and binding to loopback keeps the
 * listener off the network.
 */
internal class JvmLoopbackSession(
    private val browserOpener: BrowserOpener,
    private val timeout: Duration,
) : OidcRedirectSession {

    private val redirect = CompletableDeferred<String>()
    private val executor = Executors.newSingleThreadExecutor()
    private val server: HttpServer =
        HttpServer.create(InetSocketAddress(InetAddress.getByName(LOOPBACK_HOST), 0), 0)

    override val relayTo: String

    init {
        server.createContext(CALLBACK_PATH) { exchange -> handle(exchange) }
        server.executor = executor
        server.start()
        relayTo = "http://$LOOPBACK_HOST:${server.address.port}$CALLBACK_PATH"
    }

    override suspend fun awaitRedirect(authorizeUrl: String): String {
        browserOpener.open(authorizeUrl)
        return withTimeoutOrNull(timeout) { redirect.await() }
            ?: throw OidcCancelledException(
                "Sign-in timed out after $timeout waiting for a redirect at $relayTo",
            )
    }

    override fun close() {
        server.stop(0)
        executor.shutdownNow()
    }

    private fun handle(exchange: HttpExchange) {
        val rawQuery = exchange.requestURI.rawQuery
        val params = queryParameterNames(rawQuery)
        if ("code" in params || "error" in params) {
            redirect.complete("$relayTo?$rawQuery")
            respond(exchange, HTTP_OK, COMPLETE_PAGE)
        } else {
            // Browsers also request things like /favicon.ico; only the real callback ends the wait.
            respond(exchange, HTTP_NOT_FOUND, NOT_FOUND_PAGE)
        }
    }

    private fun respond(exchange: HttpExchange, status: Int, body: String) {
        val bytes = body.encodeToByteArray()
        exchange.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun queryParameterNames(rawQuery: String?): Set<String> =
        rawQuery?.split('&')
            ?.mapNotNull { pair -> pair.substringBefore('=').takeIf { it.isNotEmpty() } }
            ?.toSet()
            ?: emptySet()

    private companion object {
        // The backend's relay allowlist permits loopback on any port, but matches the literal
        // address only — a `localhost` hostname is rejected.
        const val LOOPBACK_HOST = "127.0.0.1"
        const val CALLBACK_PATH = "/oidc/callback"
        const val HTTP_OK = 200
        const val HTTP_NOT_FOUND = 404
        const val COMPLETE_PAGE =
            "<html><body><p>Sign-in complete. You can close this window.</p></body></html>"
        const val NOT_FOUND_PAGE = "<html><body><p>Not found.</p></body></html>"
    }
}
