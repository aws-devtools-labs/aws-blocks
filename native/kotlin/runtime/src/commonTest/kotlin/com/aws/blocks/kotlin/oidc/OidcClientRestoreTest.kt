// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.TransportException
import com.aws.blocks.kotlin.exceptions.isBlocksError
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
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
import kotlinx.serialization.json.jsonObject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest

/**
 * [OidcClient.restore] reads the backend's session for the client's cookie, on a client hydrated
 * from an `Auth` block's `oidc/client` descriptor.
 */
class OidcClientRestoreTest {

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
        authBlockClient(backend(status, body), listOf("google"))

    @Test
    fun `restore returns the session's user and signs in`() = runTest {
        val client = client(HttpStatusCode.OK, """{"user":{"userId":"google:123","username":"alice"}}""")

        val user = client.restore()

        user shouldBe OidcUser(userId = "google:123", username = "alice")
        client.authState.value shouldBe OidcAuthState.SignedIn(user!!)
        requests shouldBe listOf("GET /cdk-blocks/auth/session")
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
    fun `restore reports a session body that holds no user`() = runTest {
        val client = client(HttpStatusCode.OK, """{"session":{}}""")

        val failure = shouldThrow<TransportException> { client.restore() }

        failure.statusCode shouldBe 200
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `a session read that answers after a sign-in leaves the sign-in in place`() = runTest {
        // The session read is held until the exchange has finished, then answers 401.
        val sessionCalled = CompletableDeferred<Unit>()
        val releaseSession = CompletableDeferred<Unit>()
        val http = HttpClient(MockEngine) {
            engine {
                addHandler { request ->
                    val (status, body) = if (request.url.encodedPath.endsWith("/session")) {
                        sessionCalled.complete(Unit)
                        releaseSession.await()
                        HttpStatusCode.Unauthorized to "{}"
                    } else {
                        HttpStatusCode.OK to """{"user":{"userId":"google:1","username":"alice"}}"""
                    }
                    respond(ByteReadChannel(body), status, headersOf(HttpHeaders.ContentType, "application/json"))
                }
            }
        }
        val client = authBlockClient(http, listOf("google"))

        val restore = async { client.restore() }
        sessionCalled.await()
        val user = client.exchange("c", "v", "s", "", "google", "http://localhost:3001/cdk-blocks/auth/callback")
        releaseSession.complete(Unit)

        restore.await() shouldBe null
        client.authState.value shouldBe OidcAuthState.SignedIn(user)
    }

    @Test
    fun `restore names a backend with no session route`() = runTest {
        val client = client(HttpStatusCode.NotFound)

        val failure = shouldThrow<TransportException> { client.restore() }
        failure.statusCode shouldBe 404
        failure.message shouldContain "no session route"
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `restore throws on any other failure and leaves the state alone`() = runTest {
        val client = client(HttpStatusCode.InternalServerError)

        shouldThrow<ApiException> { client.restore() }.status shouldBe 500
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `restore reports a refusal that is not JSON as a transport failure`() = runTest {
        // A gateway's own error page, not the backend's `{ error, name }`.
        val client = client(HttpStatusCode.BadGateway, "<html>Bad Gateway</html>")

        shouldThrow<TransportException> { client.restore() }.statusCode shouldBe 502
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `restore reports the error name the backend sent`() = runTest {
        val client = client(HttpStatusCode.Forbidden, """{"error":"Forbidden","name":"NotAuthorizedException"}""")

        val failure = shouldThrow<ApiException> { client.restore() }

        failure.status shouldBe 403
        failure.isBlocksError("NotAuthorizedException") shouldBe true
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `restore reads the session beside a moved callback`() = runTest {
        val client = authBlockClient(backend(HttpStatusCode.Unauthorized), listOf("corp"), base = "/cdk-blocks/auth/sso")

        client.restore()

        requests shouldBe listOf("GET /cdk-blocks/auth/sso/session")
    }

    @Test
    fun `a descriptor from a server that sends no sessionPath still decodes`() = runTest {
        // A backend from before `sessionPath`: its descriptor has every other key.
        val descriptor = authBlockDescriptor(listOf("google"), sessionPath = null)
        descriptor.jsonObject.containsKey("sessionPath") shouldBe false

        val client = OidcClient.fromJson<AnyProvider>(descriptor, backend(HttpStatusCode.Unauthorized), fixtureServer, "myapp://auth")

        client.config.sessionPath shouldBe null
        client.restore()
        requests shouldBe listOf("GET /cdk-blocks/auth/session")
    }

    @Test
    fun `restore reads the session where the descriptor says`() = runTest {
        val client = authBlockClient(
            backend(HttpStatusCode.Unauthorized), listOf("google"), sessionPath = "/cdk-blocks/auth/me",
        )

        client.restore()

        requests shouldBe listOf("GET /cdk-blocks/auth/me")
    }

    @Test
    fun `a client decoded from a getClient result restores`() = runTest {
        // The path a generated getClient() takes: the RPC result decoded with OidcClient.json.
        val http = backend(HttpStatusCode.OK, """{"user":{"userId":"google:1","username":"alice"}}""")
        val json = OidcClient.json(http, fixtureServer, "myapp://auth")
        val client = json.decodeFromJsonElement(
            json.serializersModule.getContextual(OidcClient::class)!!,
            authBlockDescriptor(listOf("google")),
        )

        client.restore()?.username shouldBe "alice"
        client.authState.value shouldBe OidcAuthState.SignedIn(OidcUser("google:1", "alice"))
        requests shouldBe listOf("GET /cdk-blocks/auth/session")
    }

    @Test
    fun `restore throws on a session body it cannot read and leaves the state alone`() = runTest {
        for (body in listOf("not json", "{", "[]", "null")) {
            val client = client(HttpStatusCode.OK, body)

            shouldThrow<TransportException> { client.restore() }.statusCode shouldBe 200
            client.authState.value shouldBe OidcAuthState.Loading
        }
    }

    @Test
    fun `restore throws when the backend cannot be reached and leaves the state alone`() = runTest {
        val unreachable = HttpClient(MockEngine) {
            engine { addHandler { throw IOException("connection refused") } }
        }
        val client = authBlockClient(unreachable, listOf("google"))

        val failure = shouldThrow<TransportException> { client.restore() }
        failure.statusCode shouldBe null
        failure.cause.shouldBeInstanceOf<IOException>()
        client.authState.value shouldBe OidcAuthState.Loading
    }
}
