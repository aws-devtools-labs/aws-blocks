@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.e2e

import blocks.e2e.AuthState
import blocks.e2e.oidcAuthApi
import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.oidc.AnyProvider
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.oidc.signIn
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

/**
 * The flow the README's "Using Auth" section describes, against the `auth-oidc` block: read the
 * state machine, run its federated `signIn:<id>` action through [OidcClient.forAuth], restore
 * the session from a second client sharing the cookie jar, and sign out.
 */
class AuthStateMachineE2ETest {

    private val blocks = e2eBlocks()

    private fun oidcClient(): OidcClient<AnyProvider> =
        OidcClient.forAuth(blocks.client(), listOf("google"), "nativebindings://auth")
            .also { it.platformLauncher = RedirectFollowingLauncher() }

    @Test
    fun federatedSignInThroughTheStateMachine() = runTest {
        if (!isLocalEndpoint() && getEnv("RUN_OIDC") != "1") {
            markSkipped("Needs a headless IdP: Auth's stub runs only locally and on sandbox deployments")
            return@runTest
        }
        val oidc = oidcClient()
        // The suite shares one cookie jar, so start from no session whatever ran before.
        oidc.signOut()

        val signedOut = blocks.oidcAuthApi.getAuthState()
        signedOut.state shouldBe AuthState.State.SignedOut
        val action = signedOut.actions.single { it.name == "signIn:google" }
        val providerId = OidcClient.providerIdOf(action.name)
        providerId shouldBe "google"

        oidc.signIn(providerId!!)

        blocks.oidcAuthApi.getAuthState().state shouldBe AuthState.State.SignedIn
        val restored = oidcClient().restore()
        restored.shouldNotBeNull()

        oidc.signOut().shouldNotBeNull()
        oidcClient().restore().shouldBeNull()
        blocks.oidcAuthApi.getAuthState().state shouldBe AuthState.State.SignedOut
    }
}
