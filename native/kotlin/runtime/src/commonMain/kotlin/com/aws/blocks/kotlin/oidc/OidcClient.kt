// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.BlocksServer
import com.aws.blocks.kotlin.CLOSED_MESSAGE
import com.aws.blocks.kotlin.CookieJarKey
import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.exceptions.BlocksException
import com.aws.blocks.kotlin.exceptions.ClientClosedException
import com.aws.blocks.kotlin.exceptions.TransportException
import com.aws.blocks.kotlin.json.BlocksJson
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.request.post
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Cookie
import io.ktor.http.HttpStatusCode
import io.ktor.http.URLBuilder
import io.ktor.http.Url
import io.ktor.http.appendEncodedPathSegments
import io.ktor.http.contentType
import io.ktor.http.isSuccess
import io.ktor.util.date.GMTDate
import kotlin.io.encoding.Base64
import kotlinx.atomicfu.atomic
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.NonCancellable
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.withContext
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
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.plus

/**
 * Signs a user in with one of the backend's OIDC providers.
 *
 * [P] is the providers this client signs in with. A spec that resolves its provider names to
 * string literals generates an [OidcProvider] enum for them, so `signIn` takes only those
 * providers; one that doesn't leaves the client an `OidcClient<AnyProvider>`, whose `signIn`
 * takes any provider name.
 *
 * Hold one client per `Auth` block for the app's lifetime. Each `getClient()` call hydrates a new
 * client with its own [authState], so a client fetched again starts out
 * [OidcAuthState.Loading] and does not see a sign-in made through another one.
 */
class OidcClient<P : OidcProvider> internal constructor(
    internal val config: OidcClientConfig,
    internal val httpClient: HttpClient,
    internal val server: BlocksServer,
) {
    private val _authState = MutableStateFlow<OidcAuthState>(OidcAuthState.Loading)

    /**
     * Counts the sign-ins and sign-outs that have settled [authState]. [restore] applies its answer
     * only if this has not moved while it waited, so a slow session read cannot undo either.
     */
    private val generation = atomic(0)

    /**
     * Whether this client has a signed-in user. It is [OidcAuthState.Loading] until [restore],
     * [signIn] or [signOut] first settles it, so call [restore] on launch to pick up a session
     * from an earlier one.
     */
    val authState: StateFlow<OidcAuthState> = _authState.asStateFlow()

    val providers: List<String> = config.providers
    @InternalBlocksApi
    var platformLauncher: OidcPlatformLauncher = createPlatformLauncher()

    // CDK Blocks backend does not append padding
    private val base64 = Base64.UrlSafe.withPadding(Base64.PaddingOption.PRESENT_OPTIONAL)

    /**
     * The engine belongs to the [com.aws.blocks.kotlin.Blocks] instance this client came from.
     * Posting on it once that instance is closed fails inside Ktor with a cancellation a caller
     * cannot tell from its own, so report the closed state instead.
     */
    private fun ensureOpen() {
        if (!httpClient.isActive) throw ClientClosedException(CLOSED_MESSAGE)
    }

    /**
     * Signs the user in through [provider], opening the system browser and suspending until
     * the flow finishes.
     *
     * ```kotlin
     * val user = client.signIn(AuthApi.GetClient.Provider.Google)
     * ```
     *
     * @param provider one of the providers the spec named for this client. A client whose spec
     *   named none is an `OidcClient<AnyProvider>`, which signs in by name instead.
     * @param options per-attempt settings. Only the JVM target has any, controlling what the
     *   browser is shown once sign-in finishes; see `OidcSignInPlatformOptions` in `jvmMain`.
     * @return the signed-in user, which also becomes the value of [authState].
     * @throws OidcUnknownProviderException if [provider] is not one the backend configured. The
     *   spec names the providers the backend had when it was generated, which can have drifted
     *   from what [providers] reports now.
     * @throws OidcCancelledException if the user abandoned the flow, or it timed out.
     * @throws OidcCallbackException if the identity provider reported an error, the
     *   callback's state or CSRF value did not match what was sent, or the backend's
     *   authorize-params request failed. In that last case the cause is an [ApiException] or a
     *   [TransportException].
     * @throws OidcExchangeException if the backend rejected the authorization code, or the
     *   exchange request failed or its response could not be read. The cause is an
     *   [ApiException] when the backend said why, or a [TransportException] otherwise.
     * @throws ClientClosedException if the Blocks instance this client came from has been closed.
     */
    suspend fun signIn(
        provider: P,
        options: OidcSignInOptions = OidcSignInOptions(),
    ): OidcUser {
        ensureOpen()
        val name = provider.providerName
        if (name !in config.providers) {
            throw OidcUnknownProviderException(name)
        }

        val csrf = Pkce.generateRandom()
        val verifier = Pkce.generateCodeVerifier()
        val challenge = Pkce.calculateCodeChallenge(verifier)

        // The session owns the relay target: a loopback launcher binds a socket to learn its
        // own port, which has to happen before the authorize-params request carries it.
        val session = platformLauncher.openSession(config.relayTo, options)
        try {
            // Step 1: POST to /auth/authorize-params/<provider> to get the signed state envelope.
            val params = fetchAuthorizeParams(name, csrf, session.relayTo)

            // Step 2: Build the full authorize URL. redirect_uri points to the BACKEND's callback (HTTPS).
            val callbackUrl = server.rawRoute(config.callbackPath)
            val authorizeUrl = buildAuthorizeUrl(params, callbackUrl, challenge)

            // Step 3: Open the browser. After the user authenticates, the IdP redirects to the
            // backend's callback, the backend decodes the state envelope, and 302s to the relay target.
            val resultUri = session.awaitRedirect(authorizeUrl)

            // Steps 4-6 decide the outcome, and the session cannot know it before they run:
            // a callback carrying a `code` still fails if the state or CSRF value does not
            // match, or if the exchange is rejected. They report separately, so the browser
            // is told which of the two it was.
            // The state whose callback may repeat the provider's error: the issued one, once its
            // CSRF value is ours.
            val trustedState = params.state.takeIf { runCatching { verifyCsrf(it, csrf) }.isSuccess }
            val callback = reportingFailure(session, resultUri, trustedState, INVALID_CALLBACK) {
                validateCallback(resultUri, params, csrf)
            }
            val user = reportingFailure(session, resultUri, trustedState, EXCHANGE_FAILED) {
                // Step 6: Exchange the code for tokens.
                exchange(
                    code = callback.code,
                    verifier = verifier,
                    state = params.state,
                    nonce = params.nonce ?: "",
                    provider = provider,
                    callbackUrl = callbackUrl,
                    iss = callback.iss,
                )
            }
            session.reportOutcome(OidcSignInOutcome.Succeeded)
            return user
        } finally {
            session.close()
        }
    }

    /** What the callback carried, once it has been checked over. */
    private class ValidatedCallback(val code: String, val iss: String?)

    private fun validateCallback(
        resultUri: String,
        params: AuthorizeParamsResponse,
        csrf: String,
    ): ValidatedCallback {
        // Step 4: Validate the callback. The state and its CSRF value are checked before
        // anything else the callback says, an error included: any page can reach the relay
        // target, and only a callback carrying the state this attempt was issued came from the
        // backend.
        val resultParams = Url(resultUri).parameters

        val returnedState = resultParams["state"]
            ?: throw OidcCallbackException("Callback URI missing 'state' parameter")
        if (returnedState != params.state) {
            throw OidcCallbackException("State mismatch in callback")
        }

        // Step 5: Verify the CSRF value inside the state envelope matches what we sent.
        verifyCsrf(returnedState, csrf)

        val error = resultParams["error"]
        if (error != null) {
            val description = resultParams["error_description"] ?: ""
            throw OidcCallbackException("IdP error: $error — $description")
        }

        val code = resultParams["code"]
            ?: throw OidcCallbackException("Callback URI missing 'code' parameter")

        return ValidatedCallback(code, resultParams["iss"])
    }

    /**
     * Runs [block], reporting what went wrong to [session] before letting a failure out, so
     * the browser is shown the real outcome rather than one inferred from the callback query.
     *
     * [code] names the step, so a sign-in that got as far as the exchange is not described to
     * the user as a bad callback. A cancellation is the caller's own doing and gets its own
     * code; reporting it has to outlive the cancellation, or the browser would sit on the
     * callback until the session gives up waiting for an outcome.
     */
    private suspend fun <T> reportingFailure(
        session: OidcRedirectSession,
        resultUri: String,
        issuedState: String?,
        code: String,
        block: suspend () -> T,
    ): T = try {
        block()
    } catch (cancellation: CancellationException) {
        withContext(NonCancellable) {
            session.reportOutcome(OidcSignInOutcome.Failed(CANCELLED, null))
        }
        throw cancellation
    } catch (failure: Throwable) {
        session.reportOutcome(failureOutcome(failure, resultUri, issuedState, code))
        throw failure
    }

    /**
     * Describes [failure] for the user. The identity provider's own values are preferred when
     * it reported the failure; anything rejected locally gets [code] instead, since the
     * provider said nothing about it.
     *
     * Only our own exceptions supply a description. A message from anywhere else — a socket
     * error, a deserialization failure — is written for a developer, and the description
     * reaches the landing page and the query of a configured redirect.
     */
    private fun failureOutcome(
        failure: Throwable,
        resultUri: String,
        issuedState: String?,
        code: String,
    ): OidcSignInOutcome.Failed {
        val resultParams = runCatching { Url(resultUri).parameters }.getOrNull()
        // A callback without the issued state, or one whose state carries another CSRF value,
        // did not come from this attempt, so what it says the provider reported is not repeated
        // to the user.
        val idpError = resultParams?.takeIf { issuedState != null && it["state"] == issuedState }?.get("error")
        return if (idpError != null) {
            OidcSignInOutcome.Failed(idpError, resultParams["error_description"])
        } else {
            OidcSignInOutcome.Failed(code, (failure as? OidcException)?.message)
        }
    }

    suspend fun exchange(
        code: String,
        verifier: String,
        state: String,
        nonce: String,
        provider: P,
        callbackUrl: String,
        iss: String? = null
    ): OidcUser {
        ensureOpen()
        val name = provider.providerName
        if (name !in config.providers) {
            throw OidcUnknownProviderException(name)
        }

        val body = buildJsonObject {
            put("code", code)
            put("verifier", verifier)
            put("state", state)
            put("nonce", nonce)
            put("provider", name)
            put("callbackUrl", callbackUrl)
            if (iss != null) put("iss", iss)
            // The session cookie authenticates this client, so it asks the backend for no tokens.
            put("tokens", false)
        }

        val exchangeUrl = server.rawRoute(config.exchangePath)
        // The messages below are fixed: a failure's description reaches the landing page (see
        // failureOutcome), so what the engine or the parser said stays in the cause.
        val response = try {
            httpClient.post(exchangeUrl) {
                contentType(ContentType.Application.Json)
                setBody(body.toString())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw OidcExchangeException(
                "Exchange failed: the request did not complete",
                TransportException(e.message ?: "The request failed", null, e),
            )
        }

        if (!response.status.isSuccess()) {
            throw OidcExchangeException(
                "Exchange failed: HTTP ${response.status.value}",
                refusalCause(response.status.value, readBodyOrNull(response)),
            )
        }

        val user = try {
            val responseBody = Json.parseToJsonElement(response.bodyAsText()).jsonObject
            val userElement = responseBody["user"]
                ?: throw OidcExchangeException("Exchange response missing 'user' field")
            BlocksJson.decodeFromJsonElement<OidcUser>(userElement)
        } catch (e: CancellationException) {
            throw e
        } catch (e: OidcExchangeException) {
            throw e
        } catch (e: Exception) {
            throw OidcExchangeException(
                "Exchange failed: the response was not understood",
                TransportException(e.message ?: "Reading the response failed", response.status.value, e),
            )
        }
        generation.incrementAndGet()
        _authState.value = OidcAuthState.SignedIn(user)
        return user
    }

    /** The body of [response], or null when it could not be read. Only a cancellation escapes. */
    private suspend fun readBodyOrNull(response: HttpResponse): String? = try {
        response.bodyAsText()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    /**
     * What a refused OIDC route said, as the cause of the exception that reports the refusal.
     *
     * The routes refuse with a non-2xx status and `{ "error": <message>, "name": <name> }`, so a
     * body of that shape becomes an [ApiException] carrying the status and name. Anything else (a
     * gateway's own page, an empty or unreadable body) is a [TransportException] carrying the
     * status. Never throws: [body] is whatever arrived and may not be JSON at all.
     */
    private fun refusalCause(status: Int, body: String?): BlocksException {
        val fallback = "HTTP $status"
        val obj = try {
            body?.let { Json.parseToJsonElement(it) } as? JsonObject
        } catch (_: Exception) {
            null
        } ?: return TransportException(fallback, status)
        fun text(key: String) = (obj[key] as? JsonPrimitive)?.takeIf { it.isString }?.content
        return ApiException(text("error")?.takeIf { it.isNotEmpty() } ?: fallback, status, text("name"))
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

        // The backend mounts each provider at encodeURIComponent(id), which escapes more than a
        // path segment needs to (`+`, `:`, `@`, `/` and others), so the id is encoded the same way.
        val authorizeUrl = URLBuilder(server.rawRoute(config.authorizeParamsBasePath))
            .appendEncodedPathSegments(encodeUriComponent(provider))
            .buildString()
        val response = try {
            httpClient.post(authorizeUrl) {
                contentType(ContentType.Application.Json)
                setBody(body.toString())
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw OidcCallbackException(
                "Failed to fetch authorize params: the request did not complete",
                TransportException(e.message ?: "The request failed", null, e),
            )
        }

        if (!response.status.isSuccess()) {
            throw OidcCallbackException(
                "Failed to fetch authorize params: HTTP ${response.status.value}",
                refusalCause(response.status.value, readBodyOrNull(response)),
            )
        }

        return try {
            BlocksJson.decodeFromJsonElement(Json.parseToJsonElement(response.bodyAsText()))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw OidcCallbackException(
                "Failed to fetch authorize params: the response was not understood",
                TransportException(e.message ?: "Reading the response failed", response.status.value, e),
            )
        }
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
        val payload = try {
            val encodedPayloadJson = state.substringBefore('.')
            val json = base64.decode(encodedPayloadJson).decodeToString()
            BlocksJson.decodeFromString<StatePayload>(json)
        } catch (e: Exception) {
            throw OidcCallbackException("State envelope could not be read", e)
        }
        if (payload.csrf != expectedCsrf) {
            throw OidcCallbackException("CSRF mismatch in state envelope")
        }
    }

    /**
     * Reads the session the backend holds for this client's cookie, so an app that launches
     * signed in reports it before any sign-in of its own. Call it once on launch:
     *
     * ```kotlin
     * val user = oidc.restore() // null when there is no session
     * ```
     *
     * The user is the one the backend reports, including its `userId`.
     *
     * A sign-in or sign-out that finishes while the session read is still waiting wins: [restore]
     * then still returns what the backend answered, but leaves [authState] as that call set it.
     *
     * Every failure leaves [authState] as it was.
     *
     * @return the signed-in user, which also becomes the value of [authState], or `null` when the
     *   backend has no session for this client (a 401), which sets [authState] to signed out.
     * @throws ApiException if the backend refused with any other status and said why: its
     *   `status` and `name` are the backend's.
     * @throws TransportException if the request never completed, the backend serves no session
     *   route (status 404, as for an `Auth` block with no federated providers), it refused
     *   without saying why (a gateway's own page), or it answered 2xx with a body that holds no
     *   user.
     * @throws ClientClosedException if the Blocks instance this client came from has been closed.
     */
    suspend fun restore(): OidcUser? {
        ensureOpen()
        val started = generation.value
        val response = try {
            httpClient.get(server.rawRoute(sessionPath))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            throw TransportException(e.message ?: "The request failed", null, e)
        }
        val status = response.status.value
        if (response.status == HttpStatusCode.Unauthorized) {
            settleIfUnchanged(started, OidcAuthState.SignedOut)
            return null
        }
        if (response.status == HttpStatusCode.NotFound) {
            throw TransportException(
                "The backend serves no session route at $sessionPath. An Auth block serves one only " +
                    "when it has federated providers; check the block's providers and callbackPath.",
                status,
            )
        }
        if (!response.status.isSuccess()) throw refusalCause(status, readBodyOrNull(response))
        val user = try {
            val userElement = Json.parseToJsonElement(response.bodyAsText()).jsonObject["user"]
                ?: throw TransportException("Session response holds no user", status)
            BlocksJson.decodeFromJsonElement<OidcUser>(userElement)
        } catch (e: CancellationException) {
            throw e
        } catch (e: TransportException) {
            throw e
        } catch (e: Exception) {
            throw TransportException("Session response was not understood", status, e)
        }
        settleIfUnchanged(started, OidcAuthState.SignedIn(user))
        return user
    }

    /** Sets [authState] to [state] unless a sign-in or sign-out has settled it since [started]. */
    private fun settleIfUnchanged(started: Int, state: OidcAuthState) {
        if (generation.value == started) _authState.value = state
    }

    /**
     * The descriptor's `sessionPath` when it carries one. Otherwise the session read is in the
     * directory of the callback, beside `exchange`, as an `Auth` block serves it.
     */
    private val sessionPath: String
        get() = config.sessionPath ?: (config.callbackPath.substringBeforeLast('/') + "/session")

    /**
     * Signs the user out of the backend, which ends its session and clears its session cookie.
     *
     * ```kotlin
     * val logoutUrl = oidc.signOut()
     * // Open logoutUrl, if any, to end the identity provider's session too.
     * ```
     *
     * [authState] is set to signed out whenever the request is made, even if it fails, so the app
     * never shows a user who asked to sign out as still signed in; a failure is thrown after that.
     * A cancelled call that never got a response changes nothing.
     *
     * Only this block's session cookie is removed: the backend's `Set-Cookie` clears it, and the
     * client removes it as well when the descriptor names it (`sessionCookieName`), so a sign-out
     * whose response never arrived still drops it. The cookies of any other `Auth` block sharing
     * the cookie jar are left in place.
     *
     * @return the identity provider's logout URL, or `null` when the provider has none. The client
     *   does not open it; an app that wants the provider's own session ended opens it itself, or
     *   the provider can sign the user straight back in.
     * @throws ApiException if the backend refused and said why. A 503 named
     *   `SignOutIncompleteException` (`e.isBlocksError("SignOutIncompleteException")`) means the
     *   cookie was cleared but the backend could not remove its session.
     * @throws TransportException if the request never completed, or the backend refused without
     *   saying why (a gateway's own page).
     * @throws ClientClosedException if the Blocks instance this client came from has been closed.
     */
    suspend fun signOut(): String? {
        ensureOpen()
        val signOutUrl = URLBuilder(server.rawRoute(config.signOutPath)).apply {
            parameters.append("format", "json")
        }.buildString()
        val response = try {
            httpClient.post(signOutUrl) {
                contentType(ContentType.Application.Json)
                setBody("{}")
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            signOutLocally()
            throw TransportException(e.message ?: "The request failed", null, e)
        }
        signOutLocally()
        val body = readBodyOrNull(response)
        if (!response.status.isSuccess()) throw refusalCause(response.status.value, body)
        val json = try {
            body?.let { Json.parseToJsonElement(it) } as? JsonObject
        } catch (_: Exception) {
            null
        }
        return (json?.get("logoutUrl") as? JsonPrimitive)?.takeIf { it.isString }?.content
    }

    /**
     * Settles [authState] as signed out, ahead of any [restore] still waiting, and removes this
     * block's session cookie when the descriptor names it. Only that cookie goes, so another
     * `Auth` block sharing the jar stays signed in.
     */
    private suspend fun signOutLocally() {
        generation.incrementAndGet()
        _authState.value = OidcAuthState.SignedOut
        val name = config.sessionCookieName ?: return
        val jar = httpClient.attributes.getOrNull(CookieJarKey) ?: return
        jar.addCookie(
            Url(server.rawRoute("/")),
            Cookie(name, "", path = "/", expires = GMTDate(0), maxAge = 0),
        )
    }

    companion object {
        // Reported to the session when the identity provider named no error of its own, so
        // these are what an app's error page branches on. Each one names a step of the flow.
        private const val INVALID_CALLBACK = "invalid_callback"
        private const val EXCHANGE_FAILED = "exchange_failed"
        private const val CANCELLED = "cancelled"

        /**
         * The client for a `getClient` descriptor. [P] comes from the call site: the enum
         * generated for a spec that named its providers, or [AnyProvider] for one that didn't.
         *
         * Each call builds a new client with its own sign-in state, as each generated
         * `getClient()` does, so keep the one an app signs in with rather than fetching another.
         */
        fun <P : OidcProvider> fromJson(
            element: JsonElement,
            blocksClient: BlocksClient,
            relayTo: String,
        ): OidcClient<P> = fromJson(element, blocksClient.httpClient, blocksClient.server, relayTo)

        internal fun <P : OidcProvider> fromJson(
            element: JsonElement,
            httpClient: HttpClient,
            server: BlocksServer,
            relayTo: String,
        ): OidcClient<P> {
            val config = BlocksJson.decodeFromJsonElement<OidcClientConfig>(element)
                .copy(relayTo = relayTo)
            return OidcClient(config, httpClient, server)
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
         * OIDC client to. OIDC clients are read-only: encoding one throws
         * [UnsupportedOperationException].
         *
         * @param blocksClient the client whose server and HTTP session each OIDC client uses.
         * @param relayTo the custom-scheme URL the backend relays the sign-in result to: the Gradle
         *   plugin's `oidc { relayTo }`, listed in the backend's `redirects.allowedRelayOrigins`.
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

/**
 * Hydrates an `oidc/client` descriptor into an [OidcClient] bound to one server and HTTP session.
 *
 * One serializer serves every provider type: the type argument only brands what `signIn` accepts at
 * compile time, and a client signs in through each provider's [OidcProvider.providerName], so a
 * client decodes the same whichever provider type its property names.
 */
internal class OidcClientSerializer(
    private val httpClient: HttpClient,
    private val server: BlocksServer,
    private val relayTo: String,
) : KSerializer<OidcClient<*>> {
    override val descriptor: SerialDescriptor = buildClassSerialDescriptor("com.aws.blocks.kotlin.oidc.OidcClient")

    override fun deserialize(decoder: Decoder): OidcClient<*> {
        val jsonDecoder = decoder as? JsonDecoder
            ?: throw SerializationException("An OidcClient can only be decoded from JSON")
        return OidcClient.fromJson<AnyProvider>(jsonDecoder.decodeJsonElement(), httpClient, server, relayTo)
    }

    override fun serialize(encoder: Encoder, value: OidcClient<*>) {
        throw UnsupportedOperationException("Transferables are read-only")
    }
}

/**
 * Signs in with [provider], the name the backend knows it by.
 *
 * Only a client whose providers the spec didn't name signs in by name; one typed by a generated
 * provider enum takes a constant of that enum instead.
 *
 * @param options per-attempt settings, as on [OidcClient.signIn].
 */
suspend fun OidcClient<AnyProvider>.signIn(
    provider: String,
    options: OidcSignInOptions = OidcSignInOptions(),
): OidcUser = signIn(AnyProvider(provider), options)

/**
 * Exchanges a callback's code for a user against [provider], the name the backend knows it by.
 *
 * Only a client whose providers the spec didn't name exchanges by name; one typed by a generated
 * provider enum takes a constant of that enum instead.
 */
suspend fun OidcClient<AnyProvider>.exchange(
    code: String,
    verifier: String,
    state: String,
    nonce: String,
    provider: String,
    callbackUrl: String,
    iss: String? = null,
): OidcUser = exchange(code, verifier, state, nonce, AnyProvider(provider), callbackUrl, iss)

/** [value] percent-encoded as JavaScript's `encodeURIComponent` does: UTF-8, keeping only `A-Za-z0-9-_.!~*'()`. */
internal fun encodeUriComponent(value: String): String = buildString {
    for (byte in value.encodeToByteArray()) {
        val c = byte.toInt() and 0xFF
        val char = c.toChar()
        if (char in 'A'..'Z' || char in 'a'..'z' || char in '0'..'9' || char in "-_.!~*'()") {
            append(char)
        } else {
            append('%')
            append("0123456789ABCDEF"[c shr 4])
            append("0123456789ABCDEF"[c and 0xF])
        }
    }
}
