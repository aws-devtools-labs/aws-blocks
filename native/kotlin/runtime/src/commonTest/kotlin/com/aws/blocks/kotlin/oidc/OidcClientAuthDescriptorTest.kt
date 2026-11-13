package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksServer
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.shouldBe
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
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.add
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/**
 * A client hydrated from the `oidc/client` descriptor an AWS Blocks `Auth` block's
 * `createOidcApi().getClient()` returns: the block's federation routes under one base path, and
 * its providers. The keys and paths are exactly what `packages/bb-auth` emits
 * (`oidc-client-api.test.ts` pins that side).
 */
class OidcClientAuthDescriptorTest {

    private val server = BlocksServer("local", "http://localhost:3001/aws-blocks/api")

    /** `Auth`'s descriptor for routes under [base], the directory of `redirects.callbackPath`. */
    private fun authDescriptor(providers: List<String>, base: String): JsonElement = buildJsonObject {
        put("__blocks", "oidc/client")
        putJsonArray("providers") { providers.forEach { add(it) } }
        putJsonObject("providerConfigs") {
            providers.forEach { id ->
                putJsonObject(id) {
                    put("authorizeUrl", "https://idp.example.com/authorize")
                    put("clientId", "cid")
                    putJsonArray("scopes") { add("openid") }
                    put("kind", "oidc-custom")
                }
            }
        }
        put("callbackPath", "$base/callback")
        put("exchangePath", "$base/exchange")
        put("signOutPath", "$base/signout")
        put("signInBasePath", "$base/signin")
        put("authorizeParamsBasePath", "$base/authorize-params")
    }

    private fun authClient(
        http: HttpClient,
        providers: List<String>,
        base: String = "/aws-blocks/auth",
    ): OidcClient<AnyProvider> = OidcClient.fromJson(authDescriptor(providers, base), http, server, "myapp://auth")

    /** Every request the client made, as `"METHOD path"`. */
    private val requests = mutableListOf<String>()

    /**
     * A backend that answers the relay routes wherever they are mounted: authorize-params (echoing
     * the CSRF in a state envelope, as the real one does), exchange and sign-out.
     */
    private fun backend(): HttpClient = HttpClient(MockEngine) {
        install(HttpCookies)
        install(ContentNegotiation) { json() }
        engine {
            addHandler { request ->
                requests += "${request.method.value} ${request.url.encodedPath}"
                val path = request.url.encodedPath
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
    fun `the client exposes the block's providers`() {
        val client = authClient(backend(), listOf("google", "okta"))

        client.providers shouldBe listOf("google", "okta")
    }

    @Test
    fun `signs in and out through the default Auth routes`() = runTest {
        val launcher = RelayingLauncher()
        val client = authClient(backend(), listOf("google"))
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
    fun `sends the relay target and the callback URL in the exchange`() = runTest {
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
        val client = authClient(recording, listOf("google"))
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
    fun `a second block's own redirects move every route`() = runTest {
        val launcher = RelayingLauncher()
        val client = authClient(backend(), listOf("google"), base = "/aws-blocks/auth/second")
            .also { it.platformLauncher = launcher }

        client.signIn("google")
        client.signOut()

        requests shouldBe listOf(
            "POST /aws-blocks/auth/second/authorize-params/google",
            "POST /aws-blocks/auth/second/exchange",
            "POST /aws-blocks/auth/second/signout",
        )
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe
            "http://localhost:3001/aws-blocks/auth/second/callback"
    }

    @Test
    fun `rejects a provider the block does not serve`() = runTest {
        val client = authClient(backend(), listOf("google"))
            .also { it.platformLauncher = RelayingLauncher() }

        shouldThrow<OidcUnknownProviderException> { client.signIn("github") }.provider shouldBe "github"
        requests shouldBe emptyList()
    }
}
