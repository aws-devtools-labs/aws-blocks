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

    private fun getNoFollow(url: String): HttpURLConnection =
        (URI(url).toURL().openConnection() as HttpURLConnection).apply {
            instanceFollowRedirects = false
            connect()
        }

    private fun body(url: String): String =
        withRealConnection(url) { it.inputStream.readBytes().decodeToString() }

    private fun session(
        successPage: OidcLandingPage = OidcLandingPage.BuiltIn,
        errorPage: OidcLandingPage = OidcLandingPage.BuiltIn,
    ) = JvmLoopbackSession(
        BrowserOpener { },
        1.minutes,
        OidcSignInPlatformOptions(successPage = successPage, errorPage = errorPage),
    )

    @Test
    fun `relayTo is a live loopback address`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
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
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            withContext(Dispatchers.IO) { get("${session.relayTo}?code=abc123&state=xyz") } shouldBe 200
            redirect.await() shouldBe "${session.relayTo}?code=abc123&state=xyz"
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect accepts an error callback`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            withContext(Dispatchers.IO) { get("${session.relayTo}?error=access_denied&state=xyz") }
            redirect.await() shouldContain "error=access_denied"
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect ignores a callback with no state`() = runBlocking<Unit> {
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            // A stray local request must not end the wait and strand the real redirect.
            withContext(Dispatchers.IO) { get("${session.relayTo}?code=junk") } shouldBe 404
            withContext(Dispatchers.IO) { get("${session.relayTo}?code=abc123&state=xyz") } shouldBe 200
            redirect.await() shouldBe "${session.relayTo}?code=abc123&state=xyz"
        } finally {
            session.close()
        }
    }

    @Test
    fun `awaitRedirect opens the authorize url in the browser`() = runBlocking<Unit> {
        var opened: String? = null
        val session = JvmLoopbackSession(BrowserOpener { opened = it }, 1.minutes)
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize?x=1") }
            withContext(Dispatchers.IO) { get("${session.relayTo}?code=abc&state=xyz") }
            redirect.await()
            opened shouldBe "https://idp.example.com/authorize?x=1"
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
        val session = JvmLoopbackSession(BrowserOpener { }, 1.minutes)
        val port = URI(session.relayTo).port
        session.close()

        // Re-binding the same port proves the listener is gone.
        ServerSocket().use { socket ->
            socket.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), port))
            socket.localPort shouldBe port
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
            )
            try {
                session.relayTo shouldStartWith "http://127.0.0.1:"
                val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
                withContext(Dispatchers.IO) {
                    val connection = getNoFollow("${session.relayTo}?code=abc&state=xyz")
                    try {
                        connection.getHeaderField("Location") shouldBe "https://app.example.com/done"
                    } finally {
                        connection.disconnect()
                    }
                }
                redirect.await()
            } finally {
                session.close()
            }
        }

    @Test
    fun `built-in success page is served with the html content type`() = runBlocking<Unit> {
        val session = session()
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            val contentType = withContext(Dispatchers.IO) {
                withRealConnection("${session.relayTo}?code=abc&state=xyz") { connection ->
                    connection.responseCode shouldBe 200
                    val text = connection.inputStream.readBytes().decodeToString()
                    text shouldContain "Signed in"
                    text shouldContain "<link rel=\"icon\""
                    connection.getHeaderField("Content-Type")
                }
            }
            contentType shouldBe "text/html; charset=utf-8"
            redirect.await()
        } finally {
            session.close()
        }
    }

    @Test
    fun `success redirect strips the callback query`() = runBlocking<Unit> {
        val session = session(successPage = OidcLandingPage.Redirect("https://app.example.com/done"))
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            val location = withContext(Dispatchers.IO) {
                val connection = getNoFollow("${session.relayTo}?code=abc&state=xyz")
                try {
                    connection.responseCode shouldBe 302
                    connection.getHeaderField("Location")
                } finally {
                    connection.disconnect()
                }
            }
            location shouldBe "https://app.example.com/done"
            location shouldNotContain "abc"
            // The code still reaches the client even though the browser never saw it.
            redirect.await() shouldContain "code=abc"
        } finally {
            session.close()
        }
    }

    @Test
    fun `success html is served verbatim including non-ascii copy`() = runBlocking<Unit> {
        val document =
            "<!DOCTYPE html><html lang=\"fr\"><body><p>Connect\u00e9 \u2014 \u00e0 bient\u00f4t</p></body></html>"
        val session = session(successPage = OidcLandingPage.Html(document))
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            withContext(Dispatchers.IO) {
                body("${session.relayTo}?code=abc&state=xyz")
            } shouldBe document
            redirect.await()
        } finally {
            session.close()
        }
    }

    @Test
    fun `error redirect forwards the error parameters but not state`() = runBlocking<Unit> {
        val session =
            session(errorPage = OidcLandingPage.Redirect("https://app.example.com/failed?ref=1"))
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            val description = URLEncoder.encode("User said no", "UTF-8")
            val location = withContext(Dispatchers.IO) {
                val connection = getNoFollow(
                    "${session.relayTo}?error=access_denied&state=xyz&error_description=$description",
                )
                try {
                    connection.responseCode shouldBe 302
                    connection.getHeaderField("Location")
                } finally {
                    connection.disconnect()
                }
            }
            // Appended with & because the configured URL already carries a query.
            location shouldBe
                "https://app.example.com/failed?ref=1&error=access_denied&error_description=User%20said%20no"
            location shouldNotContain "state"
            redirect.await()
        } finally {
            session.close()
        }
    }

    @Test
    fun `built-in error page escapes the provider description`() = runBlocking<Unit> {
        val session = session()
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            val description = URLEncoder.encode("<script>alert(1)</script>", "UTF-8")
            val text = withContext(Dispatchers.IO) {
                body("${session.relayTo}?error=bad&state=xyz&error_description=$description")
            }
            text shouldContain "Sign-in failed"
            text shouldContain "&lt;script&gt;"
            text shouldNotContain "<script>alert"
            redirect.await()
        } finally {
            session.close()
        }
    }

    @Test
    fun `error html is served verbatim and carries no provider detail`() = runBlocking<Unit> {
        val document = "<!DOCTYPE html><html><body><p>Something went wrong</p></body></html>"
        val session = session(errorPage = OidcLandingPage.Html(document))
        try {
            val redirect = async { session.awaitRedirect("https://idp.example.com/authorize") }
            withContext(Dispatchers.IO) {
                body("${session.relayTo}?error=access_denied&state=xyz&error_description=nope")
            } shouldBe document
            redirect.await()
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
                val connection = getNoFollow("${session.relayTo}?ignored=1")
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

            withContext(Dispatchers.IO) { get("${session.relayTo}?code=abc&state=xyz") }
            redirect.await() shouldContain "code=abc"
        } finally {
            session.close()
        }
    }
}
