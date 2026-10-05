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
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put

class OidcClient internal constructor(
    private val config: OidcClientConfig,
    private val httpClient: HttpClient,
    private val server: BlocksServer
) {
    private val _authState = MutableStateFlow<OidcAuthState>(OidcAuthState.Loading)
    val authState: StateFlow<OidcAuthState> = _authState.asStateFlow()

    val providers: List<String> = config.providers
    @InternalBlocksApi
    var platformLauncher: OidcPlatformLauncher = createPlatformLauncher()

    // Blocks backend does not append padding
    private val base64 = Base64.UrlSafe.withPadding(Base64.PaddingOption.PRESENT_OPTIONAL)

    /**
     * Signs the user in through [provider], opening the system browser and suspending until
     * the flow finishes.
     *
     * ```kotlin
     * val user = client.signIn("google")
     * ```
     *
     * @param provider one of [providers]; anything else throws [OidcUnknownProviderException].
     * @param options per-attempt settings. Only the JVM target has any, controlling what the
     *   browser is shown once sign-in finishes; see `OidcSignInPlatformOptions` in `jvmMain`.
     * @return the signed-in user, which also becomes the value of [authState].
     * @throws OidcUnknownProviderException if [provider] is not one the backend configured.
     * @throws OidcCancelledException if the user abandoned the flow, or it timed out.
     * @throws OidcCallbackException if the identity provider reported an error, or the
     *   callback's state or CSRF value did not match what was sent.
     * @throws OidcExchangeException if the backend rejected the authorization code.
     */
    suspend fun signIn(
        provider: String,
        options: OidcSignInOptions = OidcSignInOptions(),
    ): OidcUser {
        if (provider !in config.providers) {
            throw OidcUnknownProviderException(provider)
        }

        val csrf = Pkce.generateRandom()
        val verifier = Pkce.generateCodeVerifier()
        val challenge = Pkce.calculateCodeChallenge(verifier)

        // The session owns the relay target: a loopback launcher binds a socket to learn its
        // own port, which has to happen before the authorize-params request carries it.
        val session = platformLauncher.openSession(config.relayTo, options)
        try {
            // Step 1: POST to /auth/authorize-params/<provider> to get the signed state envelope.
            val params = fetchAuthorizeParams(provider, csrf, session.relayTo)

            // Step 2: Build the full authorize URL. redirect_uri points to the BACKEND's callback (HTTPS).
            val callbackUrl = server.rawRoute(config.callbackPath)
            val authorizeUrl = buildAuthorizeUrl(params, callbackUrl, challenge)

            // Step 3: Open the browser. After the user authenticates, the IdP redirects to the
            // backend's callback, the backend decodes the state envelope, and 302s to the relay target.
            val resultUri = session.awaitRedirect(authorizeUrl)

            // Steps 4-6 decide the outcome, and the session cannot know it before they run:
            // a callback carrying a `code` still fails if the state or CSRF value does not
            // match, or if the exchange is rejected.
            val user = try {
                completeSignIn(resultUri, params, csrf, verifier, provider, callbackUrl)
            } catch (failure: Throwable) {
                session.reportOutcome(failureOutcome(failure, resultUri))
                throw failure
            }
            session.reportOutcome(OidcSignInOutcome.Succeeded)
            return user
        } finally {
            session.close()
        }
    }

    private suspend fun completeSignIn(
        resultUri: String,
        params: AuthorizeParamsResponse,
        csrf: String,
        verifier: String,
        provider: String,
        callbackUrl: String,
    ): OidcUser {
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
    }

    /**
     * Describes [failure] for the user. The identity provider's own values are preferred when
     * it reported the failure; anything rejected locally gets a short code of ours instead,
     * since the provider said nothing about it.
     */
    private fun failureOutcome(failure: Throwable, resultUri: String): OidcSignInOutcome.Failed {
        val resultParams = runCatching { Url(resultUri).parameters }.getOrNull()
        val idpError = resultParams?.get("error")
        return if (idpError != null) {
            OidcSignInOutcome.Failed(idpError, resultParams["error_description"])
        } else {
            val code = if (failure is OidcExchangeException) "exchange_failed" else "invalid_callback"
            OidcSignInOutcome.Failed(code, failure.message)
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

    companion object {
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
            return OidcClient(config, httpClient, server)
        }
    }
}
