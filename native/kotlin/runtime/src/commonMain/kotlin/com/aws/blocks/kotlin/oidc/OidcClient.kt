package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.json.BlocksJson
import io.ktor.client.HttpClient
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import kotlin.io.encoding.Base64
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.buildClassSerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.encodeToJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.plus

class OidcClient internal constructor(
    internal val config: OidcClientConfig,
    internal val httpClient: HttpClient,
    internal val server: BlocksServer,
    /** The descriptor this client was hydrated from, unchanged; `null` for one built by [forAuth]. */
    private val wireDescriptor: JsonObject? = null,
) {
    private val _authState = MutableStateFlow<OidcAuthState>(OidcAuthState.Loading)
    val authState: StateFlow<OidcAuthState> = _authState.asStateFlow()

    val providers: List<String> = config.providers
    @InternalBlocksApi
    var platformLauncher: OidcPlatformLauncher = createPlatformLauncher()

    // Blocks backend does not append padding
    private val base64 = Base64.UrlSafe.withPadding(Base64.PaddingOption.PRESENT_OPTIONAL)

    suspend fun signIn(provider: String): OidcUser {
        if (provider !in config.providers) {
            throw OidcUnknownProviderException(provider)
        }

        val csrf = Pkce.generateRandom()
        val verifier = Pkce.generateCodeVerifier()
        val challenge = Pkce.calculateCodeChallenge(verifier)

        // The session owns the relay target: a loopback launcher binds a socket to learn its
        // own port, which has to happen before the authorize-params request carries it.
        val session = platformLauncher.openSession(config.relayTo)
        try {
            // Step 1: POST to /auth/authorize-params/<provider> to get the signed state envelope.
            val params = fetchAuthorizeParams(provider, csrf, session.relayTo)

            // Step 2: Build the full authorize URL. redirect_uri points to the BACKEND's callback (HTTPS).
            val callbackUrl = server.rawRoute(config.callbackPath)
            val authorizeUrl = buildAuthorizeUrl(params, callbackUrl, challenge)

            // Step 3: Open the browser. After the user authenticates, the IdP redirects to the
            // backend's callback, the backend decodes the state envelope, and 302s to the relay target.
            val resultUri = session.awaitRedirect(authorizeUrl)

            // Step 4: Validate the callback.
            val resultParams = Url(resultUri).parameters

            val error = resultParams["error"]
            if (error != null) {
                val description = resultParams["error_description"] ?: ""
                throw OidcCallbackException("IdP error: $error — $description")
            }

            val code = resultParams["code"]
                ?: throw OidcCallbackException("Callback URI missing 'code' parameter")
            val returnedState = resultParams["state"]
                ?: throw OidcCallbackException("Callback URI missing 'state' parameter")

            if (returnedState != params.state) {
                throw OidcCallbackException("State mismatch in callback")
            }

            // Step 5: Verify the CSRF value inside the state envelope matches what we sent.
            verifyCsrf(returnedState, csrf)

            // Step 6: Exchange the code for tokens.
            return exchange(
                code = code,
                verifier = verifier,
                state = params.state,
                nonce = params.nonce ?: "",
                provider = provider,
                callbackUrl = callbackUrl,
                iss = resultParams["iss"]
            )
        } finally {
            session.close()
        }
    }

    suspend fun exchange(
        code: String,
        verifier: String,
        state: String,
        nonce: String,
        provider: String,
        callbackUrl: String,
        iss: String? = null
    ): OidcUser {
        if (provider !in config.providers) {
            throw OidcUnknownProviderException(provider)
        }

        val body = buildJsonObject {
            put("code", code)
            put("verifier", verifier)
            put("state", state)
            put("nonce", nonce)
            put("provider", provider)
            put("callbackUrl", callbackUrl)
            if (iss != null) put("iss", iss)
        }

        val exchangeUrl = server.rawRoute(config.exchangePath)
        val response = httpClient.post(exchangeUrl) {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }

        if (!response.status.isSuccess()) {
            throw OidcExchangeException("Exchange failed: HTTP ${response.status.value}")
        }

        val responseBody = Json.parseToJsonElement(response.bodyAsText()).jsonObject
        val userElement = responseBody["user"]
            ?: throw OidcExchangeException("Exchange response missing 'user' field")

        return BlocksJson.decodeFromJsonElement<OidcUser>(userElement).also {
            _authState.value = OidcAuthState.SignedIn(it)
        }
    }

    private suspend fun fetchAuthorizeParams(
        provider: String,
        csrf: String,
        relayTo: String
    ): AuthorizeParamsResponse {
        val body = buildJsonObject {
            put("csrf", csrf)
            put("relayTo", relayTo)
        }

        val authorizeUrl = server.rawRoute(config.authorizeParamsBasePath, provider)
        val response = httpClient.post(authorizeUrl) {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }

        if (!response.status.isSuccess()) {
            val errorBody = response.bodyAsText()
            throw OidcCallbackException("Failed to fetch authorize params: HTTP ${response.status.value} — $errorBody")
        }

        return BlocksJson.decodeFromJsonElement(Json.parseToJsonElement(response.bodyAsText()))
    }

    private fun buildAuthorizeUrl(params: AuthorizeParamsResponse, redirectUri: String, challenge: String): String =
        URLBuilder(params.authorizeUrl).apply {
            parameters.append("response_type", "code")
            parameters.append("client_id", params.clientId)
            parameters.append("redirect_uri", redirectUri)
            parameters.append("scope", params.scopes.joinToString(" "))
            parameters.append("state", params.state)
            parameters.append("code_challenge", challenge)
            parameters.append("code_challenge_method", "S256")
            if (params.nonce != null) {
                parameters.append("nonce", params.nonce)
            }
        }.buildString()

    private fun verifyCsrf(state: String, expectedCsrf: String) {
        // State is "state.signature" - get the state part
        val encodedPayloadJson = state.substringBefore('.')
        val json = base64.decode(encodedPayloadJson).decodeToString()
        val payload = BlocksJson.decodeFromString<StatePayload>(json)
        if (payload.csrf != expectedCsrf) {
            throw OidcCallbackException("CSRF mismatch in state envelope")
        }
    }

    suspend fun signOut() {
        val signOutUrl = server.rawRoute(config.signOutPath)
        httpClient.post(signOutUrl) {
            contentType(ContentType.Application.Json)
        }
        _authState.value = OidcAuthState.SignedOut
    }

    /**
     * This client's `{ "__blocks": "oidc/client", … }` descriptor: the one it was hydrated from,
     * unchanged, or, for a client built by [forAuth], its paths and providers. A generated client
     * sends an OIDC client parameter this way.
     */
    fun toJson(): JsonObject = wireDescriptor ?: buildJsonObject {
        put("__blocks", "oidc/client")
        for ((key, value) in BlocksJson.encodeToJsonElement(config).jsonObject) put(key, value)
    }

    companion object {
        /**
         * Where an AWS Blocks `Auth` block serves its federation routes, unless the backend moves
         * them with `redirects.callbackPath` (the routes live in that path's directory).
         */
        const val DEFAULT_AUTH_BASE_PATH: String = "/aws-blocks/auth"

        /**
         * Creates a client for the federation routes of an AWS Blocks `Auth` block.
         *
         * `Auth` serves the relay sign-in routes at fixed paths under [basePath]
         * (`authorize-params/<provider>`, `callback`, `exchange`, `signout`), so the client needs no
         * server-supplied descriptor:
         *
         * ```kotlin
         * val oidc = OidcClient.forAuth(
         *     BlocksClient(Servers.local),
         *     providers = listOf("google"),
         *     relayTo = "com.example.app://auth",
         * )
         * val user = oidc.signIn("google")
         * ```
         *
         * Signing in stores the backend's session cookie in the cookie storage every generated API
         * client shares, so `requireAuth`-gated methods are authenticated afterwards.
         *
         * @param blocksClient the client whose server and HTTP session to use.
         * @param providers the provider ids configured in the backend's `oidcProviders` (the record
         *   keys). [signIn] rejects any other id.
         * @param relayTo the custom-scheme URL the backend relays the sign-in result to. It must be
         *   listed in the backend's `redirects.allowedRelayOrigins` and registered with the platform
         *   (the Gradle plugin's `oidc { relayTo }`). The desktop (JVM) launcher relays to a loopback
         *   address of its own instead.
         * @param basePath the directory of the backend's `redirects.callbackPath`. Leave the default
         *   unless the backend changes `callbackPath`.
         */
        fun forAuth(
            blocksClient: BlocksClient,
            providers: List<String>,
            relayTo: String,
            basePath: String = DEFAULT_AUTH_BASE_PATH,
        ): OidcClient = forAuth(blocksClient.httpClient, blocksClient.server, providers, relayTo, basePath)

        internal fun forAuth(
            httpClient: HttpClient,
            server: BlocksServer,
            providers: List<String>,
            relayTo: String,
            basePath: String = DEFAULT_AUTH_BASE_PATH,
        ): OidcClient {
            require(basePath.startsWith("/")) { "basePath must start with '/': \"$basePath\"" }
            val base = basePath.trimEnd('/')
            val config = OidcClientConfig(
                providers = providers,
                providerConfigs = emptyMap(),
                exchangePath = "$base/exchange",
                signOutPath = "$base/signout",
                signInBasePath = "$base/signin",
                authorizeParamsBasePath = "$base/authorize-params",
                callbackPath = "$base/callback",
                relayTo = relayTo,
            )
            return OidcClient(config, httpClient, server)
        }

        fun fromJson(element: JsonElement, blocksClient: BlocksClient, relayTo: String): OidcClient {
            return fromJson(element, blocksClient.httpClient, blocksClient.server, relayTo)
        }

        internal fun fromJson(
            element: JsonElement,
            httpClient: HttpClient,
            server: BlocksServer,
            relayTo: String
        ): OidcClient {
            val config = BlocksJson.decodeFromJsonElement<OidcClientConfig>(element)
                .copy(relayTo = relayTo)
            return OidcClient(config, httpClient, server, element as? JsonObject)
        }

        /**
         * A [Json] that decodes values holding OIDC clients at any depth (a model property, a
         * list element, a map value), hydrating each `oidc/client` descriptor into an [OidcClient]
         * bound to [blocksClient] and [relayTo], as [fromJson] does for a single descriptor. It
         * is otherwise configured like [BlocksJson].
         *
         * Generated clients mark every [OidcClient] inside a model `@Contextual` and decode the
         * results of operations that return one with this [Json]:
         *
         * ```kotlin
         * val menu: LoginMenu = OidcClient.json(blocksClient, "com.example.app://auth")
         *     .decodeFromJsonElement(result)
         * ```
         *
         * Decoding such a model with plain [BlocksJson] throws a
         * [kotlinx.serialization.SerializationException], because there's no client to bind the
         * OIDC client to. Encoding an OIDC client with this [Json] writes its descriptor
         * ([OidcClient.toJson]), which is how a generated client sends a model holding one as a
         * parameter. (OIDC clients used to be read-only: encoding one threw
         * [UnsupportedOperationException].)
         *
         * @param blocksClient the client whose server and HTTP session each OIDC client uses.
         * @param relayTo the custom-scheme URL the backend relays the sign-in result to (see
         *   [forAuth]).
         */
        fun json(blocksClient: BlocksClient, relayTo: String): Json =
            json(blocksClient.httpClient, blocksClient.server, relayTo)

        internal fun json(httpClient: HttpClient, server: BlocksServer, relayTo: String): Json =
            Json(from = BlocksJson) {
                serializersModule = BlocksJson.serializersModule + SerializersModule {
                    contextual(OidcClient::class, OidcClientSerializer(httpClient, server, relayTo))
                }
            }
    }
}

/** Hydrates an `oidc/client` descriptor into an [OidcClient] bound to one server and HTTP session. */
internal class OidcClientSerializer(
    private val httpClient: HttpClient,
    private val server: BlocksServer,
    private val relayTo: String,
) : KSerializer<OidcClient> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("com.aws.blocks.kotlin.oidc.OidcClient")

    override fun deserialize(decoder: Decoder): OidcClient {
        val jsonDecoder = decoder as? JsonDecoder
            ?: throw SerializationException("An OidcClient can only be decoded from JSON")
        return OidcClient.fromJson(jsonDecoder.decodeJsonElement(), httpClient, server, relayTo)
    }

    override fun serialize(encoder: Encoder, value: OidcClient) {
        val jsonEncoder = encoder as? JsonEncoder
            ?: throw SerializationException("An OidcClient can only be encoded to JSON")
        jsonEncoder.encodeJsonElement(value.toJson())
    }
}
