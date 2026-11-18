// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.e2e

import blocks.e2e.AuthState
import blocks.e2e.OidcAuthApi
import blocks.e2e.oidcAuthApi
import blocks.e2e.oidcAuthStateApi
import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.oidc.OidcClient
import io.kotest.matchers.collections.shouldContain
import io.kotest.matchers.shouldBe
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

/**
 * The flow the README's "Using Auth" section describes, against the `auth-oidc` block: the
 * federated sign-in button comes from the OIDC client's providers, and whether the user is signed
 * in comes from the block's state machine.
 */
class AuthStateMachineE2ETest {

    private val blocks = e2eBlocks()

    private suspend fun oidcClient(): OidcClient<OidcAuthApi.GetClient.Provider> =
        blocks.oidcAuthApi.getClient().also { it.platformLauncher = RedirectFollowingLauncher() }

    @Test
    fun federatedSignInFromTheClientsProviders() = runTest {
        if (!isLocalEndpoint() && getEnv("RUN_OIDC") != "1") {
            markSkipped("Needs a headless IdP: Auth's stub runs only locally and on sandbox deployments")
            return@runTest
        }
        val oidc = oidcClient()
        // The suite shares one cookie jar, so start from no session whatever ran before.
        runCatching { oidc.signOut() }
        blocks.oidcAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedOut

        // The buttons: one per provider the spec named and the backend serves.
        val buttons = OidcAuthApi.GetClient.Provider.entries.filter { it.providerName in oidc.providers }
        // A backend may serve more providers than this one; Google is the one the stub IdP drives.
        buttons shouldContain OidcAuthApi.GetClient.Provider.Google

        oidc.signIn(OidcAuthApi.GetClient.Provider.Google)

        blocks.oidcAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedIn

        oidc.signOut()
        blocks.oidcAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedOut
    }
}
