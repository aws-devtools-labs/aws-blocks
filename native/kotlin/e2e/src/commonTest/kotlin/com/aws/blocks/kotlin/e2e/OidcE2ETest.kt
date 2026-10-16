@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.e2e

import com.aws.blocks.kotlin.BlocksClient
import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.oidc.OidcAuthState
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.oidc.OidcPlatformLauncher
import com.aws.blocks.kotlin.oidc.OidcRedirectSession
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldNotBeBlank
import io.ktor.client.HttpClient
import io.ktor.client.request.get
import io.ktor.client.statement.HttpResponse
import io.ktor.http.Url
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

/**
 * Stands in for a browser by walking the redirect chain the stub IdP produces. The stub
 * auto-approves, so every hop is a 302 until the backend relays to the custom scheme.
 */
private class RedirectFollowingLauncher : OidcPlatformLauncher {

    override suspend fun openSession(configuredRelayTo: String): OidcRedirectSession =
        object : OidcRedirectSession {
            override val relayTo: String = configuredRelayTo

            override suspend fun awaitRedirect(authorizeUrl: String): String {
                val scheme = Url(configuredRelayTo).protocol.name
                HttpClient { followRedirects = false }.use { client ->
                    var current = authorizeUrl
                    repeat(MAX_HOPS) {
                        val response: HttpResponse = client.get(current)
                        val location = response.headers["Location"]
                            ?: error(
                                "Expected a redirect toward \"$scheme://\" but got " +
                                    "HTTP ${response.status.value} at $current",
                            )
                        val next = if (location.contains("://")) {
                            location
                        } else {
                            Url(current).let { base ->
                                "${base.protocol.name}://${base.host}:${base.port}$location"
                            }
                        }
                        if (next.startsWith("$scheme://")) return next
                        current = next
                    }
                    error("Too many redirects without reaching \"$scheme://\"")
                }
            }

            override fun close() = Unit
        }

    private companion object {
        const val MAX_HOPS = 10
    }
}

/**
 * Native relay sign-in against the `auth-oidc` block: authorize-params, the IdP redirect chain,
 * the relay to `nativebindings://auth`, the code exchange (which sets the session cookie) and
 * sign-out. The client comes from the block's fixed routes ([OidcClient.forAuth]).
 *
 * Locally the IdP is `Auth`'s stub, which auto-approves. A deployed backend serves the stub only
 * when the provider opts in with `unsafeAllowDeployed` (the native-bindings test app does), so the
 * suite runs there only with `RUN_OIDC=1`, which says the backend serves a headless IdP: that
 * deployed stub, or a real, auto-approving IdP (`NATIVE_E2E_OIDC_ISSUER`; see
 * `.github/workflows/native-sdk-e2e.yml`).
 */
class OidcE2ETest {

    private val api = createApi()

    private fun oidcClient(): OidcClient =
        OidcClient.forAuth(BlocksClient(e2eServer()), listOf("google"), "nativebindings://auth")
            .also { it.platformLauncher = RedirectFollowingLauncher() }

    /** Whether the backend under test serves an IdP this suite can drive headlessly. */
    private fun hasHeadlessIdp(): Boolean = isLocalEndpoint() || getEnv("RUN_OIDC") == "1"

    @Test
    fun signInReachesSignedIn() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        val client = oidcClient()

        val user = client.signIn("google")

        user.userId.shouldNotBeBlank()
        client.authState.value shouldBe OidcAuthState.SignedIn(user)
        api.oidcRequireAuth().userId shouldBe user.userId
    }

    @Test
    fun signOutReachesSignedOut() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        val client = oidcClient()
        client.signIn("google")

        client.signOut()

        client.authState.value shouldBe OidcAuthState.SignedOut
        api.oidcCheckAuth() shouldBe false
    }

    private companion object {
        const val NEEDS_HEADLESS_IDP =
            "Auth's stub IdP is local-only unless deployed with unsafeAllowDeployed. Against a deployed " +
                "backend this suite needs RUN_OIDC=1 and a headless IdP: that deployed stub, or a real, " +
                "auto-approving one (NATIVE_E2E_OIDC_ISSUER; see .github/workflows/native-sdk-e2e.yml)"
    }
}
