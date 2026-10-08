package com.aws.blocks.kotlin.oidc

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.string.shouldStartWith
import java.net.HttpURLConnection
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.URI
import java.net.URLEncoder
import kotlin.test.Test
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.minutes
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withContext

class JvmLoopbackSessionTest {

    private fun get(url: String): Int = withRealConnection(url) { it.responseCode }

    private fun <T> withRealConnection(url: String, block: (HttpURLConnection) -> T): T {
        val connection = URI(url).toURL().openConnection() as HttpURLConnection
        return try {
            block(connection)
        } finally {
            connection.disconnect()
        }
    }

    /**
     * A callback request that has not been sent yet. `connect()` does not flush the request,
     * so reading [HttpURLConnection.responseCode] is what both sends it and waits for the
     * response — which the session only writes once an outcome has been reported.
     */
    private fun pending(session: JvmLoopbackSession, query: String): HttpURLConnection =
        (URI("${session.relayTo}?$query").toURL().openConnection() as HttpURLConnection)
            .apply { instanceFollowRedirects = false }

    private fun session(
        successPage: OidcLandingPage = OidcLandingPage.BuiltIn,
        errorPage: OidcLandingPage = OidcLandingPage.BuiltIn,
    ) = JvmLoopbackSession(
        BrowserOpener { },
        1.minutes,
        OidcSignInPlatformOptions(successPage = successPage, errorPage = errorPage),
    )

    /**
     * Drives a full callback: the request arrives, the session hands it to the caller, the
     * caller reports [outcome], and only then is the browser answered. The returned connection
     * is the browser's, and the caller disconnects it.
     */
    private suspend fun callback(
        session: JvmLoopbackSession,
        query: String,
        outcome: OidcSignInOutcome = OidcSignInOutcome.Succeeded,
    ): HttpURLConnection = coroutineScope {
        val connection = pending(session, query)
        val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
        val sent = async(Dispatchers.IO) { connection.responseCode }
        redirect.await()
        withContext(Dispatchers.IO) { session.reportOutcome(outcome) }
        sent.await()
        connection
    }

    private suspend fun callbackBody(
        session: JvmLoopbackSession,
        query: String,
        outcome: OidcSignInOutcome = OidcSignInOutcome.Succeeded,
    ): String {
        val connection = callback(session, query, outcome)
        return try {
            withContext(Dispatchers.IO) {
                (connection.errorStream ?: connection.inputStream).readBytes().decodeToString()
            }
        } finally {
            connection.disconnect()
        }
    }

    @Test
    fun `relayTo is a live loopback address`() = runBlocking<Unit> {
        val session = session()
        try {
            session.relayTo shouldStartWith "http://127.0.0.1:"
            session.relayTo shouldContain "/oidc/callback"
            // A bare GET with no auth parameters is not the callback.
            withContext(Dispatchers.IO) { get(session.relayTo) } shouldBe 404
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect returns the full callback url`() = runBlocking<Unit> {
        val session = session()
        try {
            val connection = pending(session, "code=abc123&state=xyz")
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            val sent = async(Dispatchers.IO) { connection.responseCode }
            redirect.await() shouldBe "${session.relayTo}?code=abc123&state=xyz"
            withContext(Dispatchers.IO) { session.reportOutcome(OidcSignInOutcome.Succeeded) }
            sent.await() shouldBe 200
            connection.disconnect()
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect accepts an error callback`() = runBlocking<Unit> {
        val session = session()
        try {
            val connection = pending(session, "error=access_denied&state=xyz")
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            val sent = async(Dispatchers.IO) { connection.responseCode }
            redirect.await() shouldContain "error=access_denied"
            withContext(Dispatchers.IO) {
                session.reportOutcome(OidcSignInOutcome.Failed("access_denied", null))
            }
            sent.await()
            connection.disconnect()
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect ignores a callback with no state`() = runBlocking<Unit> {
        val session = session()
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            // A stray local request must not end the wait and strand the real redirect.
            withContext(Dispatchers.IO) { get("${session.relayTo}?code=junk") } shouldBe 404

            val connection = pending(session, "code=abc123&state=xyz")
            val sent = async(Dispatchers.IO) { connection.responseCode }
            redirect.await() shouldBe "${session.relayTo}?code=abc123&state=xyz"
            withContext(Dispatchers.IO) { session.reportOutcome(OidcSignInOutcome.Succeeded) }
            sent.await() shouldBe 200
            connection.disconnect()
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect opens the authorize url in the browser`() = runBlocking<Unit> {
        var opened: String? = null
        val session = JvmLoopbackSession(BrowserOpener { opened = it }, 1.minutes)
        try {
            val connection = pending(session, "code=abc&state=xyz")
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize?x=1") }
            val sent = async(Dispatchers.IO) { connection.responseCode }
            redirect.await()
            opened shouldBe "https://idp.example.com/authorize?x=1"
            withContext(Dispatchers.IO) { session.reportOutcome(OidcSignInOutcome.Succeeded) }
            sent.await()
            connection.disconnect()
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect times out as a cancellation`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 50.milliseconds)
        try {
            val error = shouldThrow<OidcCancelledException> {
                session.awaitRedirect("https://idp.example.com/authorize")
            }
            error.message!! shouldContain "timed out"
            error.message!! shouldContain session.relayTo
        } finally {
            session.close()
        }
    }

    @Test
    fun `close releases the port`() = runBlocking<Unit> {
        val session = session()
        val port = URI(session.relayTo).port
        session.close()

        // Re-binding the same port proves the listener is gone.
        ServerSocket().use { socket ->
            socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
            socket.localPort shouldBe port
        }
    }

    @Test
    fun `the callback is handed over before the browser is answered`() = runBlocking<Unit> {
        val session = session()
        try {
            val connection = pending(session, "code=abc&state=xyz")
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            val sent = async(Dispatchers.IO) { connection.responseCode }
            // Nothing has been written yet, because no outcome has been reported, but the
            // caller already has the callback — so a failure while responding cannot lose it.
            redirect.await() shouldContain "code=abc"
            withContext(Dispatchers.IO) { session.reportOutcome(OidcSignInOutcome.Succeeded) }
            sent.await()
            connection.disconnect()
        } finally {
            session.close()
        }
    }

    @Test
    fun `a code the caller rejects shows the failure page, not the success page`() =
        runBlocking<Unit> {
            val session = session()
            try {
                val text = callbackBody(
                    session,
                    "code=abc&state=xyz",
                    OidcSignInOutcome.Failed("invalid_callback", "State mismatch in callback"),
                )
                text shouldContain "Sign-in failed"
                text shouldContain "State mismatch in callback"
                text shouldNotContain "Signed in"
            } finally {
                session.close()
            }
        }

    @Test
    fun `a code the caller rejects redirects to the error page`() = runBlocking<Unit> {
        val session = session(
            successPage = OidcLandingPage.Redirect("https://app.example.com/done"),
            errorPage = OidcLandingPage.Redirect("https://app.example.com/failed"),
        )
        try {
            val connection = callback(
                session,
                "code=abc&state=xyz",
                OidcSignInOutcome.Failed("exchange_failed", "Exchange failed: HTTP 400"),
            )
            try {
                connection.responseCode shouldBe 302
                connection.getHeaderField("Location") shouldBe
                    "https://app.example.com/failed?error=exchange_failed" +
                    "&error_description=Exchange+failed%3A+HTTP+400"
            } finally {
                connection.disconnect()
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun `built-in success page is served with the html content type`() = runBlocking<Unit> {
        val session = session()
        try {
            val connection = callback(session, "code=abc&state=xyz")
            try {
                connection.responseCode shouldBe 200
                connection.getHeaderField("Content-Type") shouldBe "text/html; charset=utf-8"
                val text = withContext(Dispatchers.IO) {
                    connection.inputStream.readBytes().decodeToString()
                }
                text shouldContain "Signed in"
                text shouldContain "<link rel=\"icon\""
            } finally {
                connection.disconnect()
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun `success redirect strips the callback query`() = runBlocking<Unit> {
        val session = session(successPage = OidcLandingPage.Redirect("https://app.example.com/done"))
        try {
            val connection = callback(session, "code=abc&state=xyz")
            try {
                connection.responseCode shouldBe 302
                val location = connection.getHeaderField("Location")
                location shouldBe "https://app.example.com/done"
                location shouldNotContain "abc"
            } finally {
                connection.disconnect()
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun `success html is served verbatim including non-ascii copy`() = runBlocking<Unit> {
        val document =
            "<!DOCTYPE html><html lang=\"fr\"><body><p>Connecté — à bientôt</p></body></html>"
        val session = session(successPage = OidcLandingPage.Html(document))
        try {
            callbackBody(session, "code=abc&state=xyz") shouldBe document
        } finally {
            session.close()
        }
    }

    @Test
    fun `error redirect forwards the error parameters but not state`() = runBlocking<Unit> {
        val session =
            session(errorPage = OidcLandingPage.Redirect("https://app.example.com/failed?ref=1"))
        try {
            val description = URLEncoder.encode("User said no", "UTF-8")
            val connection = callback(
                session,
                "error=access_denied&state=xyz&error_description=$description",
                OidcSignInOutcome.Failed("access_denied", "User said no"),
            )
            try {
                connection.responseCode shouldBe 302
                val location = connection.getHeaderField("Location")
                // Appended with & because the configured URL already carries a query.
                location shouldBe
                    "https://app.example.com/failed?ref=1&error=access_denied" +
                    "&error_description=User+said+no"
                location shouldNotContain "state"
            } finally {
                connection.disconnect()
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun `error redirect replaces error parameters the app already set`() = runBlocking<Unit> {
        val session = session(
            errorPage = OidcLandingPage.Redirect("https://app.example.com/failed?error=unknown"),
        )
        try {
            val connection = callback(
                session,
                "error=access_denied&state=xyz",
                OidcSignInOutcome.Failed("access_denied", null),
            )
            try {
                connection.getHeaderField("Location") shouldBe
                    "https://app.example.com/failed?error=access_denied"
            } finally {
                connection.disconnect()
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun `error redirect keeps the fragment after the appended query`() = runBlocking<Unit> {
        val session =
            session(errorPage = OidcLandingPage.Redirect("https://app.example.com/failed#done"))
        try {
            val connection = callback(
                session,
                "error=nope&state=xyz",
                OidcSignInOutcome.Failed("nope", null),
            )
            try {
                connection.getHeaderField("Location") shouldBe
                    "https://app.example.com/failed?error=nope#done"
            } finally {
                connection.disconnect()
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun `a non-ascii redirect url is percent-encoded in the Location header`() = runBlocking<Unit> {
        val session =
            session(successPage = OidcLandingPage.Redirect("https://app.example.com/connecté"))
        try {
            val connection = callback(session, "code=abc&state=xyz")
            try {
                // The header goes out one byte per character, so it has to be ASCII already.
                connection.getHeaderField("Location") shouldBe
                    "https://app.example.com/connect%C3%A9"
            } finally {
                connection.disconnect()
            }
        } finally {
            session.close()
        }
    }

    @Test
    fun `built-in error page escapes the provider description`() = runBlocking<Unit> {
        val session = session()
        try {
            val text = callbackBody(
                session,
                "error=bad&state=xyz",
                OidcSignInOutcome.Failed("bad", "<script>alert(1)</script>"),
            )
            text shouldContain "Sign-in failed"
            text shouldContain "&lt;script&gt;"
            text shouldNotContain "<script>alert"
        } finally {
            session.close()
        }
    }

    @Test
    fun `error html is served verbatim and carries no provider detail`() = runBlocking<Unit> {
        val document = "<!DOCTYPE html><html><body><p>Something went wrong</p></body></html>"
        val session = session(errorPage = OidcLandingPage.Html(document))
        try {
            callbackBody(
                session,
                "error=access_denied&state=xyz",
                OidcSignInOutcome.Failed("access_denied", "nope"),
            ) shouldBe document
        } finally {
            session.close()
        }
    }

    @Test
    fun `a probe gets an empty 404 and does not end the wait`() = runBlocking<Unit> {
        val session = session(successPage = OidcLandingPage.Redirect("https://app.example.com/done"))
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            withContext(Dispatchers.IO) {
                val connection = pending(session, "ignored=1").apply { responseCode }
                try {
                    // A configured redirect must not apply to a probe, and the fallback
                    // carries no body.
                    connection.responseCode shouldBe 404
                    connection.getHeaderField("Location") shouldBe null
                    val errorBody = connection.errorStream?.readBytes()?.decodeToString() ?: ""
                    errorBody shouldBe ""
                } finally {
                    connection.disconnect()
                }
            }
            redirect.isCompleted shouldBe false

            val connection = pending(session, "code=abc&state=xyz")
            val sent = async(Dispatchers.IO) { connection.responseCode }
            redirect.await() shouldContain "code=abc"
            withContext(Dispatchers.IO) { session.reportOutcome(OidcSignInOutcome.Succeeded) }
            sent.await()
            connection.disconnect()
        } finally {
            session.close()
        }
    }

    @Test
    fun `openSession ignores the configured relay target and threads the options through`() =
        runBlocking<Unit> {
            val launcher = JvmOidcLauncher(BrowserOpener { }, 1.minutes)
            val session = launcher.openSession(
                "myapp://auth/callback",
                OidcSignInOptions(
                    OidcSignInPlatformOptions(
                        successPage = OidcLandingPage.Redirect("https://app.example.com/done"),
                    ),
                ),
            ) as JvmLoopbackSession
            try {
                session.relayTo shouldStartWith "http://127.0.0.1:"
                val connection = callback(session, "code=abc&state=xyz")
                try {
                    connection.getHeaderField("Location") shouldBe "https://app.example.com/done"
                } finally {
                    connection.disconnect()
                }
            } finally {
                session.close()
            }
        }
}
