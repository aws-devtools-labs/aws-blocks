package com.aws.blocks.kotlin.oidc

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import io.ktor.http.Parameters
import io.ktor.http.URLBuilder
import io.ktor.http.parseQueryString
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
    override suspend fun openSession(
        configuredRelayTo: String,
        options: OidcSignInOptions,
    ): OidcRedirectSession = JvmLoopbackSession(browserOpener, timeout, options.platformOptions)
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
    private val options: OidcSignInPlatformOptions = OidcSignInPlatformOptions(),
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
        val params = parseQueryString(rawQuery ?: "")

        // Browsers request things like /favicon.ico, and any local process can reach this
        // port. Completing the wait is one-shot, so a request that cannot be the relay
        // redirect must not end it and strand the real one: the relay always sends `state`
        // alongside `code` or `error`, and the caller checks its value. A configured landing
        // page must not apply to such a request either.
        val isRelayRedirect = "state" in params && ("code" in params || "error" in params)
        if (!isRelayRedirect) {
            // No body: nothing legitimate renders it, so there is nothing to style and no
            // reason for an app to override it.
            sendEmpty(exchange, HTTP_NOT_FOUND)
            return
        }

        // Respond before completing: the caller's `finally` stops the server, and stop(0)
        // closes connections that are still open.
        if ("code" in params) {
            serve(exchange, options.successPage, OidcLoopbackPages.success())
        } else {
            serve(
                exchange,
                options.errorPage,
                OidcLoopbackPages.failure(params["error"], params["error_description"]),
                extraQuery = errorParameters(params),
            )
        }
        redirect.complete("$relayTo?$rawQuery")
    }

    private fun serve(
        exchange: HttpExchange,
        page: OidcLandingPage,
        builtIn: String,
        extraQuery: Parameters = Parameters.Empty,
    ) {
        when (page) {
            OidcLandingPage.BuiltIn -> respond(exchange, HTTP_OK, builtIn)
            is OidcLandingPage.Html -> respond(exchange, HTTP_OK, page.document)
            is OidcLandingPage.Redirect -> sendRedirect(exchange, withQuery(page.url, extraQuery))
        }
    }

    private fun respond(exchange: HttpExchange, status: Int, body: String) {
        val bytes = body.encodeToByteArray()
        exchange.responseHeaders.add("Content-Type", "text/html; charset=utf-8")
        exchange.sendResponseHeaders(status, bytes.size.toLong())
        exchange.responseBody.use { it.write(bytes) }
    }

    private fun sendRedirect(exchange: HttpExchange, url: String) {
        exchange.responseHeaders.add("Location", url)
        sendEmpty(exchange, HTTP_FOUND)
    }

    private fun sendEmpty(exchange: HttpExchange, status: Int) {
        exchange.sendResponseHeaders(status, NO_BODY)
        exchange.responseBody.close()
    }

    /**
     * The authorization code and `state` are deliberately absent: forwarding them would put
     * them in the landing page's access logs, its `Referer` header, and browser history.
     */
    private fun errorParameters(params: Parameters): Parameters = Parameters.build {
        params["error"]?.let { append("error", it) }
        params["error_description"]?.let { append("error_description", it) }
    }

    /** Leaves [url] untouched when there is nothing to add, so the app's value is preserved. */
    private fun withQuery(url: String, extra: Parameters): String {
        if (extra.isEmpty()) return url
        return URLBuilder(url).apply { parameters.appendAll(extra) }.buildString()
    }

    private companion object {
        // The backend's relay allowlist permits loopback on any port, but matches the literal
        // address only — a `localhost` hostname is rejected.
        const val LOOPBACK_HOST = "127.0.0.1"
        const val CALLBACK_PATH = "/oidc/callback"
        const val HTTP_OK = 200
        const val HTTP_FOUND = 302
        const val HTTP_NOT_FOUND = 404
        const val NO_BODY = -1L
    }
}
