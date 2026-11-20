// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.CookieJarKey
import com.aws.blocks.kotlin.InMemoryKeyValueStore
import com.aws.blocks.kotlin.PersistentCookiesStorage
import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.TransportException
import com.aws.blocks.kotlin.exceptions.isBlocksError
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.types.shouldBeInstanceOf
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.http.parseServerSetCookieHeader
import io.ktor.utils.io.ByteReadChannel
import kotlin.test.Test
import kotlinx.coroutines.CancellationException
import kotlinx.io.IOException
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.test.runTest

/** [OidcClient.signOut] ends the backend's session and reports the identity provider's logout URL. */
class OidcClientSignOutTest {

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
        authBlockClient(httpClient, listOf("google")).also {
            it.exchange("c", "v", "s", "", "google", "http://localhost:3001/cdk-blocks/auth/callback")
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

        requests shouldBe listOf("POST /cdk-blocks/auth/signout?format=json {}")
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `a session read that answers after a sign-out leaves the user signed out`() = runTest {
        // The session read is held until the sign-out has finished, then reports the old session.
        val sessionCalled = CompletableDeferred<Unit>()
        val releaseSession = CompletableDeferred<Unit>()
        val http = HttpClient(MockEngine) {
            engine {
                addHandler { request ->
                    if (request.url.encodedPath.endsWith("/session")) {
                        sessionCalled.complete(Unit)
                        releaseSession.await()
                    }
                    respond(
                        ByteReadChannel("""{"user":{"userId":"google:1","username":"alice"}}"""),
                        HttpStatusCode.OK,
                        headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
            }
        }
        val client = authBlockClient(http, listOf("google"))

        val restore = async { client.restore() }
        sessionCalled.await()
        client.signOut()
        releaseSession.complete(Unit)

        restore.await()?.username shouldBe "alice"
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `signOut returns null when the provider has no logout URL`() = runTest {
        val client = authBlockClient(backend(HttpStatusCode.OK), listOf("google"))

        client.signOut() shouldBe null

        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `signOut returns null for a 2xx body that is not JSON`() = runTest {
        // A backend that ignores `?format=json` answers 204 with no body.
        val client = authBlockClient(backend(HttpStatusCode.NoContent, ""), listOf("google"))

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

        val failure = shouldThrow<ApiException> { client.signOut() }

        failure.status shouldBe 503
        failure.isBlocksError("SignOutIncompleteException") shouldBe true
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `any other failure signs out locally and throws`() = runTest {
        val client = signedIn(signedInBackend(HttpStatusCode.Forbidden, """{"error":"Forbidden"}"""))

        shouldThrow<ApiException> { client.signOut() }.status shouldBe 403

        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `a refusal that is not JSON signs out locally and is a transport failure`() = runTest {
        val client = signedIn(signedInBackend(HttpStatusCode.BadGateway, "<html>Bad Gateway</html>"))

        shouldThrow<TransportException> { client.signOut() }.statusCode shouldBe 502

        client.authState.value shouldBe OidcAuthState.SignedOut
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
        val client = authBlockClient(
            backend(HttpStatusCode.OK, headers = clearsSsoCookie, cookies = jar), listOf("corp"),
            base = "/cdk-blocks/auth/sso",
        )

        client.signOut()

        jar.get(origin).map { it.name } shouldBe listOf("blocks-session-auth")
    }

    @Test
    fun `a failed sign-out removes only the cookie the descriptor names`() = runTest {
        val jar = twoBlockJar()
        val http = backend(HttpStatusCode.InternalServerError, cookies = jar)
            .also { it.attributes.put(CookieJarKey, jar) }
        val descriptor = buildJsonObject {
            authBlockDescriptor(listOf("corp"), base = "/cdk-blocks/auth/sso").jsonObject.forEach { (k, v) -> put(k, v) }
            put("sessionCookieName", "blocks-session-sso")
        }
        val client = OidcClient.fromJson<AnyProvider>(descriptor, http, fixtureServer, "myapp://auth")

        runCatching { client.signOut() }.isFailure shouldBe true

        client.authState.value shouldBe OidcAuthState.SignedOut
        jar.get(origin).map { it.name } shouldBe listOf("blocks-session-auth")
    }

    @Test
    fun `signOut clears no cookie the backend did not`() = runTest {
        val jar = twoBlockJar()
        val client = authBlockClient(backend(HttpStatusCode.OK, cookies = jar), listOf("google"))

        client.signOut()

        jar.get(origin).map { it.name }.sorted() shouldBe listOf("blocks-session-auth", "blocks-session-sso")
    }

    @Test
    fun `a 503 that names no incomplete sign-out still signs out locally`() = runTest {
        val client = signedIn(signedInBackend(HttpStatusCode.ServiceUnavailable, """{"error":"Unavailable"}"""))

        shouldThrow<ApiException> { client.signOut() }.name shouldBe null

        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `a sign-out that never reaches the backend still signs out locally`() = runTest {
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

        val failure = shouldThrow<TransportException> { client.signOut() }
        failure.statusCode shouldBe null
        failure.cause.shouldBeInstanceOf<IOException>()

        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `a sign-out cancelled before any response leaves the state alone`() = runTest {
        var signedInYet = false
        val cancelled = HttpClient(MockEngine) {
            engine {
                addHandler { request ->
                    if (signedInYet) throw CancellationException("cancelled")
                    signedInYet = request.url.encodedPath.endsWith("/exchange")
                    respond(
                        ByteReadChannel("""{"user":{"userId":"google:1","username":"alice"}}"""),
                        HttpStatusCode.OK,
                        headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
            }
        }
        val client = signedIn(cancelled)

        shouldThrow<CancellationException> { client.signOut() }

        client.authState.value shouldBe OidcAuthState.SignedIn(OidcUser("google:1", "alice"))
    }
}
