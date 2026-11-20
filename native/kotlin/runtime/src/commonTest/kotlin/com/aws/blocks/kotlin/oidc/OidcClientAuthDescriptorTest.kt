// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
 * A client hydrated from the `oidc/client` descriptor a CDK Blocks `Auth` block's
 * `createOidcApi().getClient()` returns: the block's federation routes under one base path, and
 * its providers. The keys and paths are exactly what `packages/bb-auth` emits
 * (`oidc-client-api.test.ts` pins that side).
 */
class OidcClientAuthDescriptorTest {

    private val server = BlocksServer("local", "http://localhost:3001/cdk-blocks/api")

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
        put("sessionPath", "$base/session")
        put("refreshPath", "$base/exchange/refresh")
    }

    private fun authClient(
        http: HttpClient,
        providers: List<String>,
        base: String = "/cdk-blocks/auth",
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
    private class RelayingLauncher(private val query: String = "code=the-code") : OidcPlatformLauncher {
        var authorizeUrl: String? = null
            private set

        var reportedOutcome: OidcSignInOutcome? = null
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
                    return "$configuredRelayTo?$query&state=$state"
                }

                override suspend fun reportOutcome(outcome: OidcSignInOutcome) {
                    reportedOutcome = outcome
                }

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
            "POST /cdk-blocks/auth/authorize-params/google",
            "POST /cdk-blocks/auth/exchange",
            "POST /cdk-blocks/auth/signout",
        )
        // The IdP returns to the backend's callback, which relays to the app.
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe
            "http://localhost:3001/cdk-blocks/auth/callback"
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
        exchange["callbackUrl"]!!.jsonPrimitive.content shouldBe "http://localhost:3001/cdk-blocks/auth/callback"
        exchange["tokens"]!!.jsonPrimitive.content shouldBe "false"
    }

    @Test
    fun `a second block's own redirects move every route`() = runTest {
        val launcher = RelayingLauncher()
        val client = authClient(backend(), listOf("google"), base = "/cdk-blocks/auth/second")
            .also { it.platformLauncher = launcher }

        client.signIn("google")
        client.signOut()

        requests shouldBe listOf(
            "POST /cdk-blocks/auth/second/authorize-params/google",
            "POST /cdk-blocks/auth/second/exchange",
            "POST /cdk-blocks/auth/second/signout",
        )
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe
            "http://localhost:3001/cdk-blocks/auth/second/callback"
    }

    @Test
    fun `a callback the backend names other than callback is used exactly`() = runTest {
        var exchangeBody: String? = null
        val recording = HttpClient(MockEngine) {
            engine {
                addHandler { request ->
                    requests += "${request.method.value} ${request.url.encodedPath}"
                    val text = (request.body as? TextContent)?.text
                    val body = if (request.url.encodedPath.endsWith("/exchange")) {
                        exchangeBody = text
                        """{"user":{"userId":"u","username":"alice"}}"""
                    } else {
                        val csrf = Json.parseToJsonElement(text!!).jsonObject["csrf"]!!.jsonPrimitive.content
                        val state = Base64.UrlSafe.encode("""{"v":1,"csrf":"$csrf"}""".encodeToByteArray()).trimEnd('=')
                        """{"authorizeUrl":"https://idp.example.com/authorize","clientId":"cid",""" +
                            """"scopes":["openid"],"kind":"oidc","state":"$state.sig"}"""
                    }
                    respond(ByteReadChannel(body), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                }
            }
        }
        val launcher = RelayingLauncher()
        val client = OidcClient.fromJson<AnyProvider>(
            authBlockDescriptor(listOf("corp"), base = "/cdk-blocks/auth/sso", callbackPath = "/cdk-blocks/auth/sso/return"),
            recording, fixtureServer, "myapp://auth",
        ).also { it.platformLauncher = launcher }

        client.signIn("corp")

        requests shouldBe listOf(
            "POST /cdk-blocks/auth/sso/authorize-params/corp",
            "POST /cdk-blocks/auth/sso/exchange",
        )
        Url(launcher.authorizeUrl!!).parameters["redirect_uri"] shouldBe "http://localhost:3001/cdk-blocks/auth/sso/return"
        Json.parseToJsonElement(exchangeBody!!).jsonObject["callbackUrl"]!!.jsonPrimitive.content shouldBe
            "http://localhost:3001/cdk-blocks/auth/sso/return"
    }

    @Test
    fun `signIn encodes the provider id as the backend mounts it`() = runTest {
        val client = authClient(backend(), listOf("corp+eu", "a/b"))
            .also { it.platformLauncher = RelayingLauncher() }

        client.signIn("corp+eu")
        requests.first() shouldBe "POST /cdk-blocks/auth/authorize-params/corp%2Beu"

        requests.clear()
        client.signIn("a/b")
        requests.first() shouldBe "POST /cdk-blocks/auth/authorize-params/a%2Fb"
    }

    @Test
    fun `encodeUriComponent matches encodeURIComponent`() {
        encodeUriComponent("google") shouldBe "google"
        encodeUriComponent("corp+eu") shouldBe "corp%2Beu"
        encodeUriComponent("a:b@c,d;e=f\$g&h") shouldBe "a%3Ab%40c%2Cd%3Be%3Df%24g%26h"
        encodeUriComponent("-_.!~*'()") shouldBe "-_.!~*'()"
        encodeUriComponent("a b/é") shouldBe "a%20b%2F%C3%A9"
    }

    @Test
    fun `rejects a provider the block does not serve`() = runTest {
        val client = authClient(backend(), listOf("google"))
            .also { it.platformLauncher = RelayingLauncher() }

        shouldThrow<OidcUnknownProviderException> { client.signIn("github") }.provider shouldBe "github"
        requests shouldBe emptyList()
    }

    @Test
    fun `signIn checks the envelope's CSRF value before an error the callback carries`() = runTest {
        // The relayed state is the issued one, but its envelope carries another attempt's CSRF.
        val foreign = Base64.UrlSafe.encode("""{"v":1,"csrf":"another-attempt"}""".encodeToByteArray()).trimEnd('=')
        val backend = HttpClient(MockEngine) {
            engine {
                addHandler {
                    respond(
                        ByteReadChannel(
                            """{"authorizeUrl":"https://idp.example.com/authorize","clientId":"cid",""" +
                                """"scopes":["openid"],"kind":"oidc","state":"$foreign.sig"}""",
                        ),
                        HttpStatusCode.OK,
                        headersOf(HttpHeaders.ContentType, "application/json"),
                    )
                }
            }
        }
        val launcher = RelayingLauncher(query = "error=access_denied&error_description=Call+this+number")
        val client = authClient(backend, listOf("google"))
            .also { it.platformLauncher = launcher }

        shouldThrow<OidcCallbackException> { client.signIn("google") }.message shouldBe
            "CSRF mismatch in state envelope"
        launcher.reportedOutcome shouldBe
            OidcSignInOutcome.Failed("invalid_callback", "CSRF mismatch in state envelope")
    }

    @Test
    fun `signIn fails closed on a state envelope it cannot read`() = runTest {
        // None of these payloads decodes to a state: the first is not base64url, the second is
        // base64url of "not-json", and the third is base64url of {"v":1}, which has no csrf.
        for (unreadable in listOf("!!!.sig", "bm90LWpzb24.sig", "eyJ2IjoxfQ.sig")) {
            val launcher = RelayingLauncher()
            val backend = HttpClient(MockEngine) {
                engine {
                    addHandler { request ->
                        val body = if (request.url.encodedPath.contains("/authorize-params/")) {
                            """{"authorizeUrl":"https://idp.example.com/authorize","clientId":"cid",""" +
                                """"scopes":["openid"],"kind":"oidc","state":"$unreadable"}"""
                        } else {
                            """{"user":{"userId":"u","username":"alice"}}"""
                        }
                        respond(ByteReadChannel(body), HttpStatusCode.OK, headersOf(HttpHeaders.ContentType, "application/json"))
                    }
                }
            }
            val client = authClient(backend, listOf("google"))
                .also { it.platformLauncher = launcher }

            shouldThrow<OidcCallbackException> { client.signIn("google") }.message shouldBe
                "State envelope could not be read"
            client.authState.value shouldBe OidcAuthState.Loading
        }
    }
}
