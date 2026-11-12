package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import io.ktor.utils.io.ByteReadChannel
import kotlin.test.Test
import kotlinx.io.IOException
import kotlinx.serialization.SerializationException
import kotlinx.coroutines.test.runTest

/** [OidcClient.restore] reads the backend's session for the client's cookie. */
class OidcClientRestoreTest {

    private val server = BlocksServer("local", "http://localhost:3001/aws-blocks/api")

    /** Every request the client made, as `"METHOD path"`. */
    private val requests = mutableListOf<String>()

    private fun backend(status: HttpStatusCode, body: String = "{}"): HttpClient = HttpClient(MockEngine) {
        engine {
            addHandler { request ->
                requests += "${request.method.value} ${request.url.encodedPath}"
                respond(
                    content = ByteReadChannel(body),
                    status = status,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
            }
        }
    }

    private fun client(status: HttpStatusCode, body: String = "{}") =
        OidcClient.forAuth(backend(status, body), server, listOf("google"))

    @Test
    fun `restore returns the session's user and signs in`() = runTest {
        val client = client(HttpStatusCode.OK, """{"user":{"userId":"google:123","username":"alice"}}""")

        val user = client.restore()

        user shouldBe OidcUser(userId = "google:123", username = "alice")
        client.authState.value shouldBe OidcAuthState.SignedIn(user!!)
        requests shouldBe listOf("GET /aws-blocks/auth/session")
    }

    @Test
    fun `restore reads the optional user fields an Auth block reports`() = runTest {
        val client = client(
            HttpStatusCode.OK,
            """{"user":{"userId":"alice","username":"alice","userSub":"https://idp.example.com:123",""" +
                """"signInProvider":"google","groups":["admins"],"attributes":{"email":"a@example.com"},""" +
                """"displayName":"Alice"}}""",
        )

        client.restore() shouldBe OidcUser(
            userId = "alice",
            username = "alice",
            userSub = "https://idp.example.com:123",
            signInProvider = "google",
            groups = listOf("admins"),
            attributes = mapOf("email" to "a@example.com"),
            displayName = "Alice",
        )
    }

    @Test
    fun `restore leaves the optional user fields empty when the backend omits them`() = runTest {
        val client = client(HttpStatusCode.OK, """{"user":{"userId":"alice","username":"alice"}}""")

        val user = client.restore()!!

        user.groups shouldBe emptyList()
        user.displayName shouldBe null
        user.userSub shouldBe null
    }

    @Test
    fun `restore returns null and signs out when there is no session`() = runTest {
        val client = client(HttpStatusCode.Unauthorized, """{"error":"Unauthorized"}""")

        client.restore() shouldBe null

        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `restore names a backend with no session route`() = runTest {
        val client = client(HttpStatusCode.NotFound)

        val failure = shouldThrow<OidcSessionException> { client.restore() }
        failure.statusCode shouldBe 404
        failure.message shouldContain "no session route"
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `restore throws on any other failure and leaves the state alone`() = runTest {
        val client = client(HttpStatusCode.InternalServerError)

        shouldThrow<OidcSessionException> { client.restore() }.statusCode shouldBe 500
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `restore reports the error name the backend sent`() = runTest {
        val client = client(HttpStatusCode.Forbidden, """{"error":"Forbidden","name":"NotAuthorizedException"}""")

        val failure = shouldThrow<OidcSessionException> { client.restore() }

        failure.statusCode shouldBe 403
        failure.errorName shouldBe "NotAuthorizedException"
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `restore reads the session beside a moved callback`() = runTest {
        val client = OidcClient.forAuth(
            backend(HttpStatusCode.Unauthorized), server, listOf("corp"),
            callbackPath = "/aws-blocks/auth/sso/callback",
            signOutPath = "/aws-blocks/auth/sso/signout",
        )

        client.restore()

        requests shouldBe listOf("GET /aws-blocks/auth/sso/session")
    }

    @Test
    fun `restore throws on a session body it cannot read and leaves the state alone`() = runTest {
        for (body in listOf("not json", """{"session":{}}""")) {
            val client = client(HttpStatusCode.OK, body)

            shouldThrow<SerializationException> { client.restore() }
            client.authState.value shouldBe OidcAuthState.Loading
        }
    }

    @Test
    fun `restore throws when the backend cannot be reached and leaves the state alone`() = runTest {
        val unreachable = HttpClient(MockEngine) {
            engine { addHandler { throw IOException("connection refused") } }
        }
        val client = OidcClient.forAuth(unreachable, server, listOf("google"))

        shouldThrow<IOException> { client.restore() }
        client.authState.value shouldBe OidcAuthState.Loading
    }
}
