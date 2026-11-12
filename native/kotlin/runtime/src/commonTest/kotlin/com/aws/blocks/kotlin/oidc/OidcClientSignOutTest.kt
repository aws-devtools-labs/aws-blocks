package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import com.aws.blocks.kotlin.InMemoryKeyValueStore
import com.aws.blocks.kotlin.PersistentCookiesStorage
import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.http.parseServerSetCookieHeader
import kotlinx.io.IOException
import io.ktor.utils.io.ByteReadChannel
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

/** [OidcClient.signOut] ends the backend's session and reports the identity provider's logout URL. */
class OidcClientSignOutTest {

    private val server = BlocksServer("local", "http://localhost:3001/aws-blocks/api")
    private val origin = Url("http://localhost:3001/")

    /** Every request the client made, as `"METHOD path?query body"`. */
    private val requests = mutableListOf<String>()

    private fun backend(
        status: HttpStatusCode,
        body: String = "{}",
        headers: Headers = headersOf(HttpHeaders.ContentType, "application/json"),
        cookies: CookiesStorage = PersistentCookiesStorage(InMemoryKeyValueStore()),
    ): HttpClient = HttpClient(MockEngine) {
        install(HttpCookies) { storage = cookies }
        engine {
            addHandler { request ->
                val text = (request.body as? TextContent)?.text
                requests += "${request.method.value} ${request.url.encodedPathAndQuery} $text"
                respond(content = ByteReadChannel(body), status = status, headers = headers)
            }
        }
    }

    /** A client signed in through a stubbed exchange, so a sign-out has a state to change. */
    private suspend fun signedIn(httpClient: HttpClient): OidcClient<AnyProvider> =
        OidcClient.forAuth(httpClient, server, listOf("google")).also {
            it.exchange("c", "v", "s", "", "google", "http://localhost:3001/aws-blocks/auth/callback")
            requests.clear()
        }

    private fun signedInBackend(signOutStatus: HttpStatusCode, signOutBody: String): HttpClient =
        HttpClient(MockEngine) {
            engine {
                addHandler { request ->
                    val text = (request.body as? TextContent)?.text
                    requests += "${request.method.value} ${request.url.encodedPathAndQuery} $text"
                    val (status, body) = if (request.url.encodedPath.endsWith("/exchange")) {
                        HttpStatusCode.OK to """{"user":{"userId":"google:1","username":"alice"}}"""
                    } else {
                        signOutStatus to signOutBody
                    }
                    respond(ByteReadChannel(body), status, headersOf(HttpHeaders.ContentType, "application/json"))
                }
            }
        }

    @Test
    fun `signOut asks for JSON and returns the logout URL`() = runTest {
        val client = signedIn(signedInBackend(HttpStatusCode.OK, """{"logoutUrl":"https://idp.example.com/logout"}"""))

        client.signOut() shouldBe "https://idp.example.com/logout"

        requests shouldBe listOf("POST /aws-blocks/auth/signout?format=json {}")
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `signOut returns null when the provider has no logout URL`() = runTest {
        val client = OidcClient.forAuth(backend(HttpStatusCode.OK), server, listOf("google"))

        client.signOut() shouldBe null

        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `an incomplete sign-out signs out locally and names the failure`() = runTest {
        val client = signedIn(
            signedInBackend(
                HttpStatusCode.ServiceUnavailable,
                """{"error":"Sign-out did not complete","name":"SignOutIncompleteException"}""",
            ),
        )

        val failure = shouldThrow<OidcSignOutException> { client.signOut() }

        failure.statusCode shouldBe 503
        failure.errorName shouldBe "SignOutIncompleteException"
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `any other failure throws and leaves the user signed in`() = runTest {
        val client = signedIn(signedInBackend(HttpStatusCode.Forbidden, """{"error":"Forbidden"}"""))
        val before = client.authState.value

        shouldThrow<OidcSignOutException> { client.signOut() }.statusCode shouldBe 403

        client.authState.value shouldBe before
    }

    /**
     * The jar the SDK ships, holding the session cookies of two `Auth` blocks. Each block names
     * its cookie after itself and sets it on `/`, so isolation rests on the names being distinct:
     * the jar replaces or removes a cookie by name and URL match.
     */
    private suspend fun twoBlockJar(): PersistentCookiesStorage =
        PersistentCookiesStorage(InMemoryKeyValueStore()).also {
            it.addCookie(origin, parseServerSetCookieHeader("blocks-session-auth=a; Path=/; HttpOnly"))
            it.addCookie(origin, parseServerSetCookieHeader("blocks-session-sso=b; Path=/; HttpOnly"))
        }

    @Test
    fun `signing out of one Auth block keeps another block's cookie`() = runTest {
        val jar = twoBlockJar()
        // The backend clears only the cookie of the block signed out of, as it sends it.
        val clearsSsoCookie = Headers.build {
            append(HttpHeaders.ContentType, "application/json")
            append(HttpHeaders.SetCookie, "blocks-session-sso=; Path=/; HttpOnly; Max-Age=0")
        }
        val client = OidcClient.forAuth(
            backend(HttpStatusCode.OK, headers = clearsSsoCookie, cookies = jar), server, listOf("corp"),
            callbackPath = "/aws-blocks/auth/sso/callback",
            signOutPath = "/aws-blocks/auth/sso/signout",
        )

        client.signOut()

        jar.get(origin).map { it.name } shouldBe listOf("blocks-session-auth")
    }

    @Test
    fun `signOut clears no cookie the backend did not`() = runTest {
        val jar = twoBlockJar()
        val client = OidcClient.forAuth(backend(HttpStatusCode.OK, cookies = jar), server, listOf("google"))

        client.signOut()

        jar.get(origin).map { it.name }.sorted() shouldBe listOf("blocks-session-auth", "blocks-session-sso")
    }

    @Test
    fun `a 503 that names no incomplete sign-out leaves the user signed in`() = runTest {
        val client = signedIn(signedInBackend(HttpStatusCode.ServiceUnavailable, """{"error":"Unavailable"}"""))
        val before = client.authState.value

        shouldThrow<OidcSignOutException> { client.signOut() }.errorName shouldBe null

        client.authState.value shouldBe before
    }

    @Test
    fun `a sign-out that never reaches the backend leaves the user signed in`() = runTest {
        var signedInYet = false
        val unreachable = HttpClient(MockEngine) {
            engine {
                addHandler { request ->
                    if (signedInYet) throw IOException("connection refused")
                    signedInYet = request.url.encodedPath.endsWith("/exchange")
                    respond(
                        ByteReadChannel("""{"user":{"userId":"google:1","username":"alice"}}"""),
                        HttpStatusCode.OK,
                        headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
            }
        }
        val client = signedIn(unreachable)
        val before = client.authState.value

        shouldThrow<IOException> { client.signOut() }

        client.authState.value shouldBe before
    }
}
