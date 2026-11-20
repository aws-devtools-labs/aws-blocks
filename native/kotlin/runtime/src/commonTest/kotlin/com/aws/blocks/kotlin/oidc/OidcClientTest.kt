// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.BlocksException
import com.aws.blocks.kotlin.exceptions.ClientClosedException
import com.aws.blocks.kotlin.exceptions.TransportException
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
import io.kotest.matchers.string.shouldNotContain
import io.kotest.matchers.types.shouldBeInstanceOf
import io.kotest.matchers.types.shouldBeSameInstanceAs
import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.Url
import io.ktor.http.content.TextContent
import io.ktor.http.headersOf
import io.ktor.serialization.kotlinx.json.json
import io.ktor.utils.io.ByteReadChannel
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.io.encoding.Base64
import kotlin.test.Test

class OidcClientTest {

    private fun createMockClient(
        exchangeResponse: String = """{"user":{"userId":"google:123","username":"alice"}}""",
        exchangeStatus: HttpStatusCode = HttpStatusCode.OK,
        signOutStatus: HttpStatusCode = HttpStatusCode.OK,
        authorizeParamsStatus: HttpStatusCode = HttpStatusCode.OK,
        authorizeParamsErrorResponse: String = "{}",
        onIssuedState: ((String) -> Unit)? = null,
        onAuthorizeParamsBody: ((String) -> Unit)? = null,
        onAuthorizeParamsPath: ((String) -> Unit)? = null,
        /** Stands in for a transport that never produced a response at all. */
        onExchange: (() -> Nothing)? = null,
    ): HttpClient {
        return HttpClient(MockEngine) {
            install(HttpCookies)
            install(ContentNegotiation) { json() }
            engine {
                addHandler { request ->
                    when {
                        request.url.encodedPath.contains("/auth/authorize-params/") &&
                            request.method == HttpMethod.Post -> {
                            onAuthorizeParamsPath?.invoke(request.url.encodedPath)
                            if (authorizeParamsStatus != HttpStatusCode.OK) {
                                respond(
                                    content = ByteReadChannel(authorizeParamsErrorResponse),
                                    status = authorizeParamsStatus,
                                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                                )
                            } else {
                                // Mirror the real backend: embed the request's CSRF in a signed
                                // state envelope so the client's verifyCsrf() check passes.
                                val csrf = Json.parseToJsonElement((request.body as TextContent).text)
                                    .jsonObject["csrf"]!!.jsonPrimitive.content
                                onAuthorizeParamsBody?.invoke((request.body as TextContent).text)
                                val state = signedStateEnvelope(csrf)
                                onIssuedState?.invoke(state)
                                respond(
                                    content = ByteReadChannel(authorizeParamsSuccessBody(state)),
                                    status = HttpStatusCode.OK,
                                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                                )
                            }
                        }
                        request.url.encodedPath.endsWith("/auth/exchange") -> {
                            onExchange?.invoke()
                            respond(
                                content = ByteReadChannel(exchangeResponse),
                                status = exchangeStatus,
                                headers = headersOf(HttpHeaders.ContentType, "application/json"),
                            )
                        }
                        request.url.encodedPath.endsWith("/auth/signout") -> {
                            respond(
                                content = ByteReadChannel("{}"),
                                status = signOutStatus,
                                headers = headersOf(HttpHeaders.ContentType, "application/json"),
                            )
                        }
                        else -> {
                            respond(
                                content = ByteReadChannel("{}"),
                                status = HttpStatusCode.OK,
                                headers = headersOf(HttpHeaders.ContentType, "application/json"),
                            )
                        }
                    }
                }
            }
        }
    }

    /**
     * Builds a state envelope shaped like the real backend's: base64url(JSON payload) + "." + signature.
     * The client only decodes the payload (before the '.') to verify the embedded CSRF.
     */
    private fun signedStateEnvelope(csrf: String): String {
        val payloadJson = """{"v":1,"csrf":"$csrf"}"""
        val encoded = Base64.UrlSafe.encode(payloadJson.encodeToByteArray()).trimEnd('=')
        return "$encoded.test-signature"
    }

    private fun authorizeParamsSuccessBody(state: String): String = """{
        "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
        "clientId": "test-client-id",
        "scopes": ["openid", "email"],
        "kind": "oidc-builtin",
        "state": "$state",
        "nonce": "server-generated-nonce"
    }"""

    private val testDescriptor = """
        {
            "__blocks": "oidc/client",
            "providers": ["google"],
            "providerConfigs": {
                "google": {
                    "authorizeUrl": "https://accounts.google.com/o/oauth2/v2/auth",
                    "clientId": "test-client-id",
                    "scopes": ["openid", "email"],
                    "kind": "oidc-builtin"
                }
            },
            "exchangePath": "/auth/exchange",
            "signOutPath": "/auth/signout",
            "signInBasePath": "/auth/signin",
            "authorizeParamsBasePath": "/auth/authorize-params",
            "callbackPath": "/auth/callback"
        }
    """.trimIndent()

    private val localServer = BlocksServer("local", "http://localhost:3001")

    /**
     * Stands in for a platform launcher. [onAwaitRedirect] receives the authorize URL and
     * returns the relay redirect the browser would have produced.
     */
    private class FakeLauncher(
        private val sessionRelayTo: String = "myapp://auth/callback",
        private val onAwaitRedirect: suspend (String) -> String,
    ) : OidcPlatformLauncher {
        var closeCount = 0
            private set

        /** What `signIn` forwarded, so a test can tell a dropped argument from a passed one. */
        var receivedOptions: OidcSignInOptions? = null
            private set

        var reportedOutcome: OidcSignInOutcome? = null
            private set

        override suspend fun openSession(
            configuredRelayTo: String,
            options: OidcSignInOptions,
        ): OidcRedirectSession {
            receivedOptions = options
            return object : OidcRedirectSession {
                override val relayTo: String = sessionRelayTo
                override suspend fun awaitRedirect(authorizeUrl: String): String =
                    onAwaitRedirect(authorizeUrl)

                override suspend fun reportOutcome(outcome: OidcSignInOutcome) {
                    reportedOutcome = outcome
                }

                override fun close() {
                    closeCount++
                }
            }
        }
    }

    @Test
    fun `fromJson parses providers`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.providers shouldBe listOf("google")
    }

    @Test
    fun `signing out on a closed client reports that rather than cancelling the caller`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        // The client shares the entry point's engine, so closing the entry point closes this too.
        httpClient.close()

        val failure = shouldThrow<BlocksException> { client.signOut() }

        failure.message!! shouldContain "closed"
        // A sign-out that could not reach the backend must not report itself as done.
        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `exchange transitions to signed in`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")

        val user = client.exchange(
            code = "auth-code-123",
            verifier = "test-verifier",
            state = "test-state",
            nonce = "test-nonce",
            provider = "google",
            callbackUrl = "http://localhost:3001/auth/callback",
        )

        user.userId shouldBe "google:123"
        user.username shouldBe "alice"
        client.authState.value shouldBe OidcAuthState.SignedIn(user)
    }

    @Test
    fun `signOut transitions to signed out`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")

        client.exchange(
            code = "auth-code-123",
            verifier = "test-verifier",
            state = "test-state",
            nonce = "test-nonce",
            provider = "google",
            callbackUrl = "http://localhost:3001/auth/callback",
        )

        client.signOut()
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `initial state is loading`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")

        client.authState.value shouldBe OidcAuthState.Loading
    }

    // --- signIn tests ---

    @Test
    fun `signIn fetches authorize params and builds correct URL`() = runTest {
        var capturedUrl: String? = null
        var issuedState: String? = null
        val httpClient = createMockClient(onIssuedState = { issuedState = it })
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher { authorizeUrl ->
            capturedUrl = authorizeUrl
            "myapp://auth/callback?code=test-code&state=$issuedState"
        }

        val user = client.signIn("google")

        user.userId shouldBe "google:123"
        client.authState.value shouldBe OidcAuthState.SignedIn(user)

        val url = Url(capturedUrl!!)
        url.host shouldBe "accounts.google.com"
        url.parameters["response_type"] shouldBe "code"
        url.parameters["client_id"] shouldBe "test-client-id"
        url.parameters["redirect_uri"] shouldBe "http://localhost:3001/auth/callback"
        url.parameters["scope"] shouldBe "openid email"
        url.parameters["state"] shouldBe issuedState
        url.parameters["nonce"] shouldBe "server-generated-nonce"
        url.parameters["code_challenge_method"] shouldBe "S256"
        url.parameters["code_challenge"].shouldNotBeNull()
    }

    @Test
    fun `signIn throws when provider not configured`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher { "" }

        val exception = shouldThrow<OidcUnknownProviderException> {
            client.signIn("unknown-provider")
        }
        exception.provider shouldBe "unknown-provider"
    }

    @Test
    fun `signIn forwards the caller's options to the launcher`() = runTest {
        var issuedState: String? = null
        val httpClient = createMockClient(onIssuedState = { issuedState = it })
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher {
            "myapp://auth/callback?code=test-code&state=$issuedState"
        }
        client.platformLauncher = launcher
        val options = OidcSignInOptions()

        client.signIn("google", options)

        // Dropping the argument would still compile, because the interface defaults it.
        launcher.receivedOptions shouldBeSameInstanceAs options
    }

    @Test
    fun `signIn reports a succeeded outcome`() = runTest {
        var issuedState: String? = null
        val httpClient = createMockClient(onIssuedState = { issuedState = it })
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher {
            "myapp://auth/callback?code=test-code&state=$issuedState"
        }
        client.platformLauncher = launcher

        client.signIn("google")

        launcher.reportedOutcome shouldBe OidcSignInOutcome.Succeeded
    }

    @Test
    fun `signIn reports the idp's values when the idp rejected the attempt`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher {
            "myapp://auth/callback?error=access_denied&error_description=User+cancelled" +
                "&state=${Url(it).parameters["state"]}"
        }
        client.platformLauncher = launcher

        shouldThrow<OidcCallbackException> { client.signIn("google") }

        launcher.reportedOutcome shouldBe
            OidcSignInOutcome.Failed("access_denied", "User cancelled")
    }

    @Test
    fun `signIn reports a failed outcome when it rejects a callback carrying a code`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher {
            "myapp://auth/callback?code=test-code&state=wrong-state"
        }
        client.platformLauncher = launcher

        shouldThrow<OidcCallbackException> { client.signIn("google") }

        // A code alone is not success: the outcome has to say so, or the browser is told the
        // wrong thing.
        launcher.reportedOutcome shouldBe
            OidcSignInOutcome.Failed("invalid_callback", "State mismatch in callback")
    }

    @Test
    fun `signIn prefers the idp error when the callback carries both code and error`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher {
            "myapp://auth/callback?code=test-code&error=server_error" +
                "&state=${Url(it).parameters["state"]}"
        }
        client.platformLauncher = launcher

        shouldThrow<OidcCallbackException> { client.signIn("google") }

        launcher.reportedOutcome shouldBe OidcSignInOutcome.Failed("server_error", null)
    }

    @Test
    fun `signIn throws on state mismatch`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher {
            "myapp://auth/callback?code=test-code&state=wrong-state"
        }

        val exception = shouldThrow<OidcCallbackException> {
            client.signIn("google")
        }
        exception.message shouldBe "State mismatch in callback"
    }

    @Test
    fun `signIn ignores an error from a callback without the issued state`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        // Any page that can reach the relay target could send this, so its text goes nowhere.
        val launcher = FakeLauncher {
            "myapp://auth/callback?error=access_denied&error_description=Call+this+number&state=forged"
        }
        client.platformLauncher = launcher

        val exception = shouldThrow<OidcCallbackException> { client.signIn("google") }

        exception.message shouldBe "State mismatch in callback"
        launcher.reportedOutcome shouldBe
            OidcSignInOutcome.Failed("invalid_callback", "State mismatch in callback")
    }

    @Test
    fun `signIn ignores an error from a callback with no state`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher { "myapp://auth/callback?error=access_denied" }
        client.platformLauncher = launcher

        shouldThrow<OidcCallbackException> { client.signIn("google") }

        launcher.reportedOutcome shouldBe
            OidcSignInOutcome.Failed("invalid_callback", "Callback URI missing 'state' parameter")
    }

    @Test
    fun `signIn throws on IdP error`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher {
            "myapp://auth/callback?error=access_denied&error_description=User+cancelled" +
                "&state=${Url(it).parameters["state"]}"
        }

        val exception = shouldThrow<OidcCallbackException> {
            client.signIn("google")
        }
        exception.message shouldBe "IdP error: access_denied — User cancelled"
    }

    @Test
    fun `signIn throws when authorize-params request fails`() = runTest {
        val httpClient = createMockClient(
            authorizeParamsStatus = HttpStatusCode.BadRequest,
            authorizeParamsErrorResponse = """{"error":"invalid_relay","reason":"unknown-origin"}""",
        )
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher { "" }

        shouldThrow<OidcCallbackException> {
            client.signIn("google")
        }
    }

    @Test
    fun `signIn throws OidcCancelledException when launcher cancels`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher { throw OidcCancelledException() }

        shouldThrow<OidcCancelledException> {
            client.signIn("google")
        }
    }

    @Test
    fun `signIn throws when callback is missing code parameter`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher {
            "myapp://auth/callback?state=${Url(it).parameters["state"]}"
        }

        val exception = shouldThrow<OidcCallbackException> {
            client.signIn("google")
        }
        exception.message shouldBe "Callback URI missing 'code' parameter"
    }

    @Test
    fun `signIn throws when callback is missing state parameter`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher {
            "myapp://auth/callback?code=test-code"
        }

        val exception = shouldThrow<OidcCallbackException> {
            client.signIn("google")
        }
        exception.message shouldBe "Callback URI missing 'state' parameter"
    }

    @Test
    fun `exchange throws on HTTP error`() = runTest {
        val httpClient = createMockClient(
            exchangeStatus = HttpStatusCode.InternalServerError,
        )
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")

        val exception = shouldThrow<OidcExchangeException> {
            client.exchange(
                code = "auth-code",
                verifier = "verifier",
                state = "state",
                nonce = "nonce",
                provider = "google",
                callbackUrl = "http://localhost:3001/auth/callback",
            )
        }
        exception.message shouldBe "Exchange failed: HTTP 500"
    }

    @Test
    fun `exchange throws when response is missing user field`() = runTest {
        val httpClient = createMockClient(
            exchangeResponse = """{"session":"abc"}""",
        )
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")

        val exception = shouldThrow<OidcExchangeException> {
            client.exchange(
                code = "auth-code",
                verifier = "verifier",
                state = "state",
                nonce = "nonce",
                provider = "google",
                callbackUrl = "http://localhost:3001/auth/callback",
            )
        }
        exception.message shouldBe "Exchange response missing 'user' field"
    }

    @Test
    fun `signIn sends correct body to authorize-params endpoint`() = runTest {
        var capturedBody: String? = null
        val httpClient = HttpClient(MockEngine) {
            install(HttpCookies)
            install(ContentNegotiation) { json() }
            engine {
                addHandler { request ->
                    when {
                        request.url.encodedPath.contains("/auth/authorize-params/") -> {
                            val body = (request.body as TextContent).text
                            capturedBody = body
                            // Echo the request's CSRF back inside a signed state envelope so
                            // the client's verifyCsrf() check passes (mirrors the real backend).
                            val csrf = Json.parseToJsonElement(body)
                                .jsonObject["csrf"]!!.jsonPrimitive.content
                            respond(
                                content = ByteReadChannel(authorizeParamsSuccessBody(signedStateEnvelope(csrf))),
                                status = HttpStatusCode.OK,
                                headers = headersOf(HttpHeaders.ContentType, "application/json"),
                            )
                        }
                        request.url.encodedPath.endsWith("/auth/exchange") -> {
                            respond(
                                content = ByteReadChannel("""{"user":{"userId":"google:123","username":"alice"}}"""),
                                status = HttpStatusCode.OK,
                                headers = headersOf(HttpHeaders.ContentType, "application/json"),
                            )
                        }
                        else -> {
                            respond(
                                content = ByteReadChannel("{}"),
                                status = HttpStatusCode.OK,
                                headers = headersOf(HttpHeaders.ContentType, "application/json"),
                            )
                        }
                    }
                }
            }
        }

        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher { authorizeUrl ->
            // Reflect the issued state back from the authorize URL so it matches the envelope.
            val state = Url(authorizeUrl).parameters["state"]
            "myapp://auth/callback?code=test-code&state=$state"
        }

        client.signIn("google")

        val body = Json.parseToJsonElement(capturedBody!!).jsonObject
        body["relayTo"]?.jsonPrimitive?.content shouldBe "myapp://auth/callback"
        body["csrf"]?.jsonPrimitive?.content.shouldNotBeNull()
    }

    @Test
    fun `signOut throws on a server error after signing out locally`() = runTest {
        val httpClient = createMockClient(signOutStatus = HttpStatusCode.InternalServerError)
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")

        client.exchange(
            code = "auth-code",
            verifier = "verifier",
            state = "state",
            nonce = "nonce",
            provider = "google",
            callbackUrl = "http://localhost:3001/auth/callback",
        )

        shouldThrow<ApiException> { client.signOut() }.status shouldBe 500
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `signIn does not change auth state on failure`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        client.platformLauncher = FakeLauncher { throw OidcCancelledException() }

        client.authState.value shouldBe OidcAuthState.Loading

        runCatching { client.signIn("google") }

        client.authState.value shouldBe OidcAuthState.Loading
    }

    @Test
    fun `signIn closes the session when the exchange fails`() = runTest {
        var issuedState: String? = null
        val httpClient = createMockClient(
            exchangeStatus = HttpStatusCode.InternalServerError,
            onIssuedState = { issuedState = it },
        )
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher { "myapp://auth/callback?code=c&state=$issuedState" }
        client.platformLauncher = launcher

        shouldThrow<OidcExchangeException> { client.signIn("google") }

        launcher.closeCount shouldBe 1
        // The callback was fine; saying otherwise would send an app's error page down the
        // wrong branch.
        launcher.reportedOutcome shouldBe
            OidcSignInOutcome.Failed("exchange_failed", "Exchange failed: HTTP 500")
    }

    @Test
    fun `signIn reports an exchange that failed before it reached the backend`() = runTest {
        var issuedState: String? = null
        val httpClient = createMockClient(
            onIssuedState = { issuedState = it },
            onExchange = { throw IllegalStateException("Connection refused: /10.0.0.1:443") },
        )
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher { "myapp://auth/callback?code=c&state=$issuedState" }
        client.platformLauncher = launcher

        val failure = shouldThrow<OidcExchangeException> { client.signIn("google") }

        // The engine's own exception stays reachable as the cause of a TransportException.
        val transport = failure.cause.shouldBeInstanceOf<TransportException>()
        transport.statusCode shouldBe null
        transport.cause.shouldBeInstanceOf<IllegalStateException>()
        // An unreachable backend is still an exchange failure, and the transport's own message
        // is written for a developer: the description is a fixed one, because it would otherwise
        // reach the landing page and the query of a configured redirect.
        launcher.reportedOutcome shouldBe
            OidcSignInOutcome.Failed("exchange_failed", "Exchange failed: the request did not complete")
        failure.message!! shouldNotContain "10.0.0.1"
    }

    @Test
    fun `signIn reports a cancelled outcome when the caller stops waiting`() = runTest {
        var issuedState: String? = null
        val httpClient = createMockClient(
            onIssuedState = { issuedState = it },
            onExchange = { throw CancellationException("screen left composition") },
        )
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "myapp://auth/callback")
        val launcher = FakeLauncher { "myapp://auth/callback?code=c&state=$issuedState" }
        client.platformLauncher = launcher

        shouldThrow<CancellationException> { client.signIn("google") }

        // The user abandoned the flow; the callback was not bad.
        launcher.reportedOutcome shouldBe OidcSignInOutcome.Failed("cancelled", null)
        launcher.closeCount shouldBe 1
    }

    @Test
    fun `signIn sends the session relay target rather than the configured one`() = runTest {
        var capturedRelayTo: String? = null
        var issuedState: String? = null
        val httpClient = createMockClient(
            onIssuedState = { issuedState = it },
            onAuthorizeParamsBody = { body ->
                capturedRelayTo = Json.parseToJsonElement(body)
                    .jsonObject["relayTo"]?.jsonPrimitive?.content
            },
        )
        val element = Json.parseToJsonElement(testDescriptor)
        val client = OidcClient.fromJson<AnyProvider>(element, httpClient, localServer, "configured://ignored")
        client.platformLauncher = FakeLauncher(sessionRelayTo = "http://127.0.0.1:9999/oidc/callback") {
            "http://127.0.0.1:9999/oidc/callback?code=test-code&state=$issuedState"
        }

        client.signIn("google")

        capturedRelayTo shouldBe "http://127.0.0.1:9999/oidc/callback"
    }

    // --- typed providers ---

    /** Stands in for the enum a spec that named its providers generates. */
    private enum class GeneratedProvider(override val providerName: String) : OidcProvider {
        Google("google"),
        MySso("my-sso"),
        Unconfigured("not-a-provider"),
    }

    private val typedDescriptor = testDescriptor.replace(
        """"providers": ["google"]""",
        """"providers": ["google", "my-sso"]""",
    )

    @Test
    fun `a typed client signs in with the name its provider carries`() = runTest {
        var capturedPath: String? = null
        var issuedState: String? = null
        val httpClient = createMockClient(
            onIssuedState = { issuedState = it },
            onAuthorizeParamsPath = { capturedPath = it },
        )
        val element = Json.parseToJsonElement(typedDescriptor)
        val client = OidcClient.fromJson<GeneratedProvider>(
            element,
            httpClient,
            localServer,
            "myapp://auth/callback",
        )
        client.platformLauncher = FakeLauncher {
            "myapp://auth/callback?code=test-code&state=$issuedState"
        }

        val user = client.signIn(GeneratedProvider.MySso)

        capturedPath shouldBe "/auth/authorize-params/my-sso"
        client.authState.value shouldBe OidcAuthState.SignedIn(user)
    }

    @Test
    fun `a typed client rejects a provider the backend does not configure`() = runTest {
        val httpClient = createMockClient()
        val element = Json.parseToJsonElement(typedDescriptor)
        val client = OidcClient.fromJson<GeneratedProvider>(
            element,
            httpClient,
            localServer,
            "myapp://auth/callback",
        )
        client.platformLauncher = FakeLauncher { "" }

        val exception = shouldThrow<OidcUnknownProviderException> {
            client.signIn(GeneratedProvider.Unconfigured)
        }
        exception.provider shouldBe "not-a-provider"
    }

    @Test
    fun `a typed client exchanges with the name its provider carries`() = runTest {
        var capturedProvider: String? = null
        val httpClient = HttpClient(MockEngine) {
            install(HttpCookies)
            install(ContentNegotiation) { json() }
            engine {
                addHandler { request ->
                    capturedProvider = Json.parseToJsonElement((request.body as TextContent).text)
                        .jsonObject["provider"]?.jsonPrimitive?.content
                    respond(
                        content = ByteReadChannel("""{"user":{"userId":"my-sso:1","username":"alice"}}"""),
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
            }
        }
        val element = Json.parseToJsonElement(typedDescriptor)
        val client = OidcClient.fromJson<GeneratedProvider>(
            element,
            httpClient,
            localServer,
            "myapp://auth/callback",
        )

        client.exchange(
            code = "auth-code-123",
            verifier = "test-verifier",
            state = "test-state",
            nonce = "test-nonce",
            provider = GeneratedProvider.MySso,
            callbackUrl = "http://localhost:3001/auth/callback",
        )

        capturedProvider shouldBe "my-sso"
    }

    private fun newClient(httpClient: HttpClient): OidcClient<AnyProvider> =
        OidcClient.fromJson(Json.parseToJsonElement(testDescriptor), httpClient, localServer, "myapp://auth/callback")

    @Test
    fun `a refused exchange carries the backend's name and status as the cause`() = runTest {
        val client = newClient(
            createMockClient(
                exchangeStatus = HttpStatusCode.BadRequest,
                exchangeResponse = """{"error":"Provider google is not configured","name":"ProviderNotConfigured"}""",
            ),
        )

        val failure = shouldThrow<OidcExchangeException> {
            client.exchange("c", "v", "s", "n", "google", "https://app/cb")
        }

        failure.message shouldBe "Exchange failed: HTTP 400"
        val cause = failure.cause.shouldBeInstanceOf<ApiException>()
        cause.name shouldBe "ProviderNotConfigured"
        cause.status shouldBe 400
        cause.message shouldBe "Provider google is not configured"
    }

    @Test
    fun `a refused exchange with a body that is not a JSON object carries a TransportException`() = runTest {
        for (body in listOf("<html>bad gateway</html>", "[1]", "", "\"text\"")) {
            val client = newClient(createMockClient(exchangeStatus = HttpStatusCode.BadGateway, exchangeResponse = body))

            val failure = shouldThrow<OidcExchangeException> {
                client.exchange("c", "v", "s", "n", "google", "https://app/cb")
            }

            val cause = failure.cause.shouldBeInstanceOf<TransportException>()
            cause.statusCode shouldBe 502
            cause.message shouldBe "HTTP 502"
        }
    }

    @Test
    fun `a refused authorize-params request carries the backend's name and status as the cause`() = runTest {
        val client = newClient(
            createMockClient(
                authorizeParamsStatus = HttpStatusCode.BadRequest,
                authorizeParamsErrorResponse = """{"error":"Relay origin not allowed","name":"InvalidRelay"}""",
            ),
        )
        client.platformLauncher = FakeLauncher { "" }

        val failure = shouldThrow<OidcCallbackException> { client.signIn("google") }

        // The body is not in the message: it would reach the landing page.
        failure.message shouldBe "Failed to fetch authorize params: HTTP 400"
        val cause = failure.cause.shouldBeInstanceOf<ApiException>()
        cause.name shouldBe "InvalidRelay"
        cause.status shouldBe 400
    }

    @Test
    fun `a malformed 2xx exchange body is an OidcExchangeException`() = runTest {
        for (body in listOf("<html>captive portal</html>", "[]", """{"user":"nope"}""")) {
            val client = newClient(createMockClient(exchangeResponse = body))

            val failure = shouldThrow<OidcExchangeException> {
                client.exchange("c", "v", "s", "n", "google", "https://app/cb")
            }

            failure.message shouldBe "Exchange failed: the response was not understood"
            failure.cause.shouldBeInstanceOf<TransportException>().statusCode shouldBe 200
            client.authState.value shouldBe OidcAuthState.Loading
        }
    }

    @Test
    fun `a malformed 2xx authorize-params body is an OidcCallbackException`() = runTest {
        val httpClient = HttpClient(MockEngine {
            respond("<html>captive portal</html>", HttpStatusCode.OK)
        })
        val client = newClient(httpClient)
        client.platformLauncher = FakeLauncher { "" }

        val failure = shouldThrow<OidcCallbackException> { client.signIn("google") }

        failure.cause.shouldBeInstanceOf<TransportException>()
        failure.message!! shouldNotContain "captive"
    }

    @Test
    fun `a connection failure while fetching authorize params is an OidcCallbackException`() = runTest {
        val client = newClient(HttpClient(MockEngine { throw IllegalStateException("Connection refused") }))
        client.platformLauncher = FakeLauncher { "" }

        val failure = shouldThrow<OidcCallbackException> { client.signIn("google") }

        failure.message!! shouldNotContain "refused"
        failure.cause.shouldBeInstanceOf<TransportException>().cause.shouldBeInstanceOf<IllegalStateException>()
    }

    @Test
    fun `signOut reports a connection failure as a TransportException`() = runTest {
        val client = newClient(HttpClient(MockEngine { throw IllegalStateException("Connection refused") }))

        val failure = shouldThrow<TransportException> { client.signOut() }

        failure.statusCode shouldBe null
    }

    @Test
    fun `a cancellation passes through the OIDC requests`() = runTest {
        val client = newClient(HttpClient(MockEngine { throw CancellationException("cancelled") }))
        client.platformLauncher = FakeLauncher { "" }

        shouldThrow<CancellationException> { client.signOut() }
        shouldThrow<CancellationException> { client.restore() }
        shouldThrow<CancellationException> { client.exchange("c", "v", "s", "n", "google", "https://app/cb") }
        shouldThrow<CancellationException> { client.signIn("google") }
    }

    @Test
    fun `a closed client throws ClientClosedException from every OIDC request`() = runTest {
        val httpClient = createMockClient()
        val client = newClient(httpClient)
        client.platformLauncher = FakeLauncher { "" }
        httpClient.close()

        shouldThrow<ClientClosedException> { client.signIn("google") }
        shouldThrow<ClientClosedException> { client.exchange("c", "v", "s", "n", "google", "https://app/cb") }
        shouldThrow<ClientClosedException> { client.signOut() }
        shouldThrow<ClientClosedException> { client.restore() }
    }
}
