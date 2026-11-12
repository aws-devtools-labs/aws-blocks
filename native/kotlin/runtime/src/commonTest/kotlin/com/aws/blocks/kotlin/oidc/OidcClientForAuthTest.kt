package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldContain
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
import kotlin.io.encoding.Base64
import kotlin.test.Test
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * [OidcClient.forAuth] builds a client from the `Auth` block's fixed federation routes, with no
 * server-supplied descriptor.
 */
class OidcClientForAuthTest {

    private val server = BlocksServer("local", "http://localhost:3001/aws-blocks/api")

    /** Every request the client made, as `"METHOD path"`. */
    private val requests = mutableListOf<String>()

    /**
     * A backend that answers the relay routes wherever they are mounted: authorize-params (echoing
     * the CSRF in a state envelope, as the real one does), exchange and sign-out.
     */
    private fun backend(observe: (path: String, body: String?) -> Unit = { _, _ -> }): HttpClient = HttpClient(MockEngine) {
        install(HttpCookies)
        install(ContentNegotiation) { json() }
        engine {
            addHandler { request ->
                requests += "${request.method.value} ${request.url.encodedPath}"
                val path = request.url.encodedPath
                observe(path, (request.body as? TextContent)?.text)
                val body = when {
                    path.contains("/authorize-params/") && request.method == HttpMethod.Post -> {
                        val csrf = Json.parseToJsonElement((request.body as TextContent).text)
                            .jsonObject["csrf"]!!.jsonPrimitive.content
                        val payload = """{"v":1,"csrf":"$csrf"}"""
                        val state = Base64.UrlSafe.encode(payload.encodeToByteArray()).trimEnd('=') + ".sig"
                        """{"authorizeUrl":"https://idp.example.com/authorize","clientId":"cid",""" +
                            """"scopes":["openid"],"kind":"oidc","state":"$state","nonce":"n"}"""
                    }
                    path.endsWith("/exchange") ->
                        """{"user":{"userId":"https://idp.example.com:123","username":"alice"}}"""
                    else -> "{}"
                }
                respond(
                    content = ByteReadChannel(body),
                    status = HttpStatusCode.OK,
                    headers = headersOf(HttpHeaders.ContentType, "application/json"),
                )
            }
        }
    }

    /** Relays the issued state straight back, as the backend's callback would. */
    private class RelayingLauncher : OidcPlatformLauncher {
        var authorizeUrl: String? = null
            private set

        override suspend fun openSession(
            configuredRelayTo: String,
            options: OidcSignInOptions,
        ): OidcRedirectSession =
            object : OidcRedirectSession {
                override val relayTo: String = configuredRelayTo

                override suspend fun awaitRedirect(authorizeUrl: String): String {
                    this@RelayingLauncher.authorizeUrl = authorizeUrl
                    val state = Url(authorizeUrl).parameters["state"]
                    return "$configuredRelayTo?code=the-code&state=$state"
                }

                override suspend fun reportOutcome(outcome: OidcSignInOutcome) = Unit

                override fun close() = Unit
            }
    }

    @Test
    fun `forAuth exposes the given providers`() {
        val client = OidcClient.forAuth(backend(), server, listOf("google", "okta"), "myapp://auth")

        client.providers shouldBe listOf("google", "okta")
    }

    @Test
    fun `forAuth signs in and out through the default Auth routes`() = runTest {
        val launcher = RelayingLauncher()
        val client = OidcClient.forAuth(backend(), server, listOf("google"), "myapp://auth")
            .also { it.platformLauncher = launcher }

        val user = client.signIn("google")
        client.signOut()

        user.username shouldBe "alice"
        requests shouldBe listOf(
            "POST /aws-blocks/auth/authorize-params/google",
            "POST /aws-blocks/auth/exchange",
            "POST /aws-blocks/auth/signout",
        )
        // The IdP returns to the backend's callback, which relays to the app.
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe
            "http://localhost:3001/aws-blocks/auth/callback"
        client.authState.value shouldBe OidcAuthState.SignedOut
    }

    @Test
    fun `forAuth sends the relay target and the callback URL in the exchange`() = runTest {
        var exchangeBody: String? = null
        var authorizeParamsBody: String? = null
        val recording = HttpClient(MockEngine) {
            install(ContentNegotiation) { json() }
            engine {
                addHandler { request ->
                    val text = (request.body as? TextContent)?.text
                    val path = request.url.encodedPath
                    val body = if (path.endsWith("/exchange")) {
                        exchangeBody = text
                        """{"user":{"userId":"u","username":"alice"}}"""
                    } else {
                        authorizeParamsBody = text
                        val csrf = Json.parseToJsonElement(text!!).jsonObject["csrf"]!!.jsonPrimitive.content
                        val payload = """{"v":1,"csrf":"$csrf"}"""
                        val state = Base64.UrlSafe.encode(payload.encodeToByteArray()).trimEnd('=') + ".sig"
                        """{"authorizeUrl":"https://idp.example.com/authorize","clientId":"cid",""" +
                            """"scopes":["openid"],"kind":"oidc","state":"$state"}"""
                    }
                    respond(
                        content = ByteReadChannel(body),
                        status = HttpStatusCode.OK,
                        headers = headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
            }
        }
        val client = OidcClient.forAuth(recording, server, listOf("google"), "myapp://auth")
            .also { it.platformLauncher = RelayingLauncher() }

        client.signIn("google")

        Json.parseToJsonElement(authorizeParamsBody!!).jsonObject["relayTo"]!!.jsonPrimitive.content shouldBe
            "myapp://auth"
        val exchange = Json.parseToJsonElement(exchangeBody!!).jsonObject
        exchange["provider"]!!.jsonPrimitive.content shouldBe "google"
        exchange["code"]!!.jsonPrimitive.content shouldBe "the-code"
        exchange["callbackUrl"]!!.jsonPrimitive.content shouldBe "http://localhost:3001/aws-blocks/auth/callback"
    }

    @Test
    fun `forAuth derives the routes from the callback's directory`() = runTest {
        val launcher = RelayingLauncher()
        val client = OidcClient.forAuth(
            backend(), server, listOf("google"), "myapp://auth",
            callbackPath = "/aws-blocks/auth/sso/callback",
            signOutPath = "/aws-blocks/auth/sso/signout",
        ).also { it.platformLauncher = launcher }

        client.signIn("google")
        client.signOut()

        requests shouldBe listOf(
            "POST /aws-blocks/auth/sso/authorize-params/google",
            "POST /aws-blocks/auth/sso/exchange",
            "POST /aws-blocks/auth/sso/signout",
        )
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe
            "http://localhost:3001/aws-blocks/auth/sso/callback"
    }

    @Test
    fun `forAuth keeps a callback file name of the backend's choosing`() = runTest {
        var exchangeBody: String? = null
        val launcher = RelayingLauncher()
        val client = OidcClient.forAuth(
            backend { path, body -> if (path.endsWith("/exchange")) exchangeBody = body },
            server, listOf("google"), "myapp://auth",
            callbackPath = "/aws-blocks/auth/oidc-return",
        ).also { it.platformLauncher = launcher }

        client.signIn("google")

        requests shouldBe listOf("POST /aws-blocks/auth/authorize-params/google", "POST /aws-blocks/auth/exchange")
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe
            "http://localhost:3001/aws-blocks/auth/oidc-return"
        Json.parseToJsonElement(exchangeBody!!).jsonObject["callbackUrl"]!!.jsonPrimitive.content shouldBe
            "http://localhost:3001/aws-blocks/auth/oidc-return"
    }

    @Test
    fun `forAuth signs out at a sign-out path outside the callback's directory`() = runTest {
        val client = OidcClient.forAuth(
            backend(), server, listOf("google"), "myapp://auth",
            callbackPath = "/aws-blocks/auth/sso/callback",
            signOutPath = "/aws-blocks/auth/logout",
        )

        client.signOut()

        requests shouldBe listOf("POST /aws-blocks/auth/logout")
    }

    @Test
    fun `forAuth resolves routes against an API Gateway stage`() = runTest {
        val staged = BlocksServer("prod", "https://x.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/api")
        val launcher = RelayingLauncher()
        val client = OidcClient.forAuth(backend(), staged, listOf("google"), "myapp://auth")
            .also { it.platformLauncher = launcher }

        client.signIn("google")

        requests shouldBe listOf(
            "POST /prod/aws-blocks/auth/authorize-params/google",
            "POST /prod/aws-blocks/auth/exchange",
        )
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe
            "https://x.execute-api.us-east-1.amazonaws.com/prod/aws-blocks/auth/callback"
    }

    @Test
    fun `forAuth rejects a provider it was not given`() = runTest {
        val client = OidcClient.forAuth(backend(), server, listOf("google"), "myapp://auth")
            .also { it.platformLauncher = RelayingLauncher() }

        shouldThrow<OidcUnknownProviderException> { client.signIn("github") }.provider shouldBe "github"
        requests shouldBe emptyList()
    }

    @Test
    fun `forAuth rejects a path the backend would refuse`() {
        val refused = listOf(
            "/login" to OidcClient.DEFAULT_SIGN_OUT_PATH,
            "aws-blocks/auth/callback" to OidcClient.DEFAULT_SIGN_OUT_PATH,
            "/aws-blocks/auth/" to OidcClient.DEFAULT_SIGN_OUT_PATH,
            "/aws-blocks/auth/callback/" to OidcClient.DEFAULT_SIGN_OUT_PATH,
            "/aws-blocks/authx/callback" to OidcClient.DEFAULT_SIGN_OUT_PATH,
            OidcClient.DEFAULT_CALLBACK_PATH to "/signout",
            OidcClient.DEFAULT_CALLBACK_PATH to "/aws-blocks/auth",
        )
        for ((callbackPath, signOutPath) in refused) {
            shouldThrow<IllegalArgumentException> {
                OidcClient.forAuth(backend(), server, listOf("google"), "myapp://auth", callbackPath, signOutPath)
            }
        }
        requests shouldBe emptyList()
    }

    @Test
    fun `forAuth needs no relay target to be built`() {
        OidcClient.forAuth(backend(), server, listOf("google")).providers shouldBe listOf("google")
    }

    @Test
    fun `signIn without a relay target fails before any request`() = runTest {
        val client = OidcClient.forAuth(backend(), server, listOf("google"))
            .also { it.platformLauncher = RelayingLauncher() }

        shouldThrow<IllegalStateException> { client.signIn("google") }.message shouldContain "relayTo"
        requests shouldBe emptyList()
    }
}
