// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.e2e

import blocks.e2e.AuthState
import blocks.e2e.OidcAuthApi
import blocks.e2e.SsoOidcApi
import blocks.e2e.oidcAuthApi
import blocks.e2e.oidcAuthStateApi
import blocks.e2e.ssoAuthStateApi
import blocks.e2e.ssoOidcApi
import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.oidc.OidcAuthState
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.oidc.OidcPlatformLauncher
import com.aws.blocks.kotlin.oidc.OidcRedirectSession
import com.aws.blocks.kotlin.oidc.OidcSignInOptions
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldEndWith
import io.kotest.matchers.types.shouldBeInstanceOf
import io.ktor.http.Url
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

/** A [RedirectFollowingLauncher] that also records the authorize URL each sign-in opens. */
private class RecordingLauncher : OidcPlatformLauncher {
    private val inner = RedirectFollowingLauncher()
    val authorizeUrls = mutableListOf<String>()

    override suspend fun openSession(configuredRelayTo: String, options: OidcSignInOptions): OidcRedirectSession {
        val session = inner.openSession(configuredRelayTo, options)
        return object : OidcRedirectSession by session {
            override suspend fun awaitRedirect(authorizeUrl: String): String {
                authorizeUrls += authorizeUrl
                return session.awaitRedirect(authorizeUrl)
            }
        }
    }
}

/**
 * Two federated `Auth` blocks, each signed in through the client its `getClient()` returns:
 * `auth-oidc` on the default routes, signing in with its second provider (`github2`), and
 * `auth-sso`, whose routes live under `/cdk-blocks/auth/sso/` with the callback named `return`.
 *
 * Same headless-IdP rule as [OidcE2ETest]: local dev server, or a deployed backend with
 * `RUN_OIDC=1`.
 */
class OidcMultiBlockE2ETest {

    private val blocks = e2eBlocks()
    private val api = createApi()

    private fun hasHeadlessIdp(): Boolean = isLocalEndpoint() || getEnv("RUN_OIDC") == "1"

    private suspend fun oidcClient(launcher: OidcPlatformLauncher = RedirectFollowingLauncher()): OidcClient<OidcAuthApi.GetClient.Provider> =
        blocks.oidcAuthApi.getClient().also { it.platformLauncher = launcher }

    private suspend fun ssoClient(launcher: OidcPlatformLauncher = RedirectFollowingLauncher()): OidcClient<SsoOidcApi.GetClient.Provider> =
        blocks.ssoOidcApi.getClient().also { it.platformLauncher = launcher }

    @Test
    fun signInThroughASecondProvider() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        // The suite shares one cookie jar: start from no session, whatever ran before.
        blocks.clearStoredState()
        val client = oidcClient()

        val user = client.signIn(OidcAuthApi.GetClient.Provider.Github2)

        client.authState.value shouldBe OidcAuthState.SignedIn(user)
        val me = api.oidcRequireAuth()
        me.userId shouldBe user.userId
        me.provider shouldBe "github2"
        blocks.oidcAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedIn

        assertRestoreThenSignOut(user.userId, "github2") { oidcClient() }
        blocks.oidcAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedOut
    }

    @Test
    fun signInThroughABlockOnItsOwnRoutes() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        blocks.clearStoredState()
        val launcher = RecordingLauncher()
        val client = ssoClient(launcher)

        val user = client.signIn(SsoOidcApi.GetClient.Provider.Corp)

        // The IdP was sent the block's own callback, from the descriptor, not the default name.
        val redirectUri = Url(launcher.authorizeUrls.single()).parameters["redirect_uri"].shouldNotBeNull()
        // A deployed API URL carries the API Gateway stage before /cdk-blocks, so check the suffix.
        Url(redirectUri).encodedPath shouldEndWith "/cdk-blocks/auth/sso/return"
        client.authState.value shouldBe OidcAuthState.SignedIn(user)
        val me = api.ssoRequireAuth()
        me.userId shouldBe user.userId
        me.provider shouldBe "corp"
        blocks.ssoAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedIn

        assertRestoreThenSignOut(user.userId, "corp") { ssoClient() }
        api.ssoGetCurrentUser().shouldBeNull()
        blocks.ssoAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedOut
    }

    @Test
    fun signingOutOfOneBlockLeavesTheOtherSignedIn() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        blocks.clearStoredState()
        val oidc = oidcClient()
        val sso = ssoClient()
        oidc.signIn(OidcAuthApi.GetClient.Provider.Github2)
        sso.signIn(SsoOidcApi.GetClient.Provider.Corp)

        sso.signOut()

        sso.restore().shouldBeNull()
        api.oidcRequireAuth().provider shouldBe "github2"
        oidc.authState.value.shouldBeInstanceOf<OidcAuthState.SignedIn>()

        // The other direction: signing out of auth-oidc leaves auth-sso signed in.
        sso.signIn(SsoOidcApi.GetClient.Provider.Corp)
        oidc.signOut()

        oidc.restore().shouldBeNull()
        api.ssoRequireAuth().provider shouldBe "corp"
        sso.authState.value.shouldBeInstanceOf<OidcAuthState.SignedIn>()
        sso.signOut()
    }

    @Test
    fun aBlockRefusesAnotherBlocksSession() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        blocks.clearStoredState()
        val client = oidcClient()
        client.signIn(OidcAuthApi.GetClient.Provider.Github2)
        api.oidcRequireAuth().provider shouldBe "github2"

        val e = shouldThrow<ApiException> { api.ssoRequireAuth() }
        e.name shouldBe AuthErrorNames.NotAuthenticated
        api.ssoGetCurrentUser().shouldBeNull()
        blocks.ssoAuthStateApi.getAuthState().state shouldBe AuthState.State.SignedOut
        client.signOut()
    }

    /**
     * A fresh client on the same [e2eBlocks] shares the cookie jar, so restore() finds the
     * session; the client's own signOut() (not an RPC) returns the stub IdP's logout URL and
     * ends the session.
     */
    private suspend fun assertRestoreThenSignOut(
        userId: String,
        provider: String,
        client: suspend () -> OidcClient<*>,
    ) {
        val fresh = client()
        fresh.restore()?.userId shouldBe userId

        val logoutUrl = fresh.signOut()
        logoutUrl.shouldNotBeNull().substringBefore('?') shouldEndWith "/cdk-blocks/auth/idp/$provider/logout"
        fresh.authState.value shouldBe OidcAuthState.SignedOut

        fresh.restore().shouldBeNull()
    }

    private companion object {
        const val NEEDS_HEADLESS_IDP =
            "Auth's stub IdP runs only locally and on sandbox deployments. Against a deployed " +
                "backend this suite needs RUN_OIDC=1 (see OidcE2ETest)."
    }
}
