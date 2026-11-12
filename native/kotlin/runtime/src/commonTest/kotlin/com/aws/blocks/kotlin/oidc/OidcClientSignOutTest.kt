package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.http.Cookie
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
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
        cookies: AcceptAllCookiesStorage = AcceptAllCookiesStorage(),
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

    @Test
    fun `signing out of one Auth block keeps another block's cookie`() = runTest {
        val jar = AcceptAllCookiesStorage()
        jar.addCookie(origin, Cookie("blocks-session-auth", "a", path = "/"))
        jar.addCookie(origin, Cookie("blocks-session-sso", "b", path = "/"))
        // The backend clears only the cookie of the block signed out of.
        val clearsAuthCookie = Headers.build {
            append(HttpHeaders.ContentType, "application/json")
            append(HttpHeaders.SetCookie, "blocks-session-auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT")
        }
        val client = OidcClient.forAuth(backend(HttpStatusCode.OK, headers = clearsAuthCookie, cookies = jar), server, listOf("google"))

        client.signOut()

        jar.get(origin).map { it.name } shouldBe listOf("blocks-session-sso")
    }

    @Test
    fun `signOut clears no cookie the backend did not`() = runTest {
        val jar = AcceptAllCookiesStorage()
        jar.addCookie(origin, Cookie("blocks-session-auth", "a", path = "/"))
        jar.addCookie(origin, Cookie("blocks-session-sso", "b", path = "/"))
        val client = OidcClient.forAuth(backend(HttpStatusCode.OK, cookies = jar), server, listOf("google"))

        client.signOut()

        jar.get(origin).map { it.name }.sorted() shouldBe listOf("blocks-session-auth", "blocks-session-sso")
    }
}
