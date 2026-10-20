@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.e2e

import blocks.e2e.OidcAuthApi
import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.oidc.OidcAuthState
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

class OidcE2ETest {

    private val api = OidcAuthApi(server = e2eServer())

    @Test
    fun signInReachesSignedIn() = runTest {
        val client = api.getClient()
        client.platformLauncher = RedirectFollowingLauncher()

        val user = client.signIn("google")

        user.userId.shouldNotBeBlank()
        client.authState.value shouldBe OidcAuthState.SignedIn(user)
    }

    @Test
    fun signOutReachesSignedOut() = runTest {
        val client = api.getClient()
        client.platformLauncher = RedirectFollowingLauncher()
        client.signIn("google")

        client.signOut()

        client.authState.value shouldBe OidcAuthState.SignedOut
    }
}
