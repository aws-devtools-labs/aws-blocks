@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.e2e

import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.exceptions.ApiException
import com.aws.blocks.kotlin.oidc.AnyProvider
import com.aws.blocks.kotlin.oidc.OidcAuthState
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.oidc.signIn
import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.nulls.shouldNotBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.string.shouldEndWith
import kotlin.test.Test
import kotlinx.coroutines.test.runTest

/**
 * [OidcClient.forAuth] against two federated `Auth` blocks: `auth-oidc` on the default routes,
 * signing in with its second provider (`github2`), and `auth-sso`, whose routes live under
 * `/aws-blocks/auth/sso/` (its own `callbackPath` and `signOutPath`), signing in with `corp`.
 *
 * Same headless-IdP rule as [OidcE2ETest]: local dev server, or a deployed backend with
 * `RUN_OIDC=1`.
 */
class OidcMultiBlockE2ETest {

    private val api = createApi()

    private fun hasHeadlessIdp(): Boolean = isLocalEndpoint() || getEnv("RUN_OIDC") == "1"

    private fun oidcClient(): OidcClient<AnyProvider> =
        OidcClient.forAuth(e2eBlocks().client(), listOf("google", "github2"), RELAY_TO)
            .also { it.platformLauncher = RedirectFollowingLauncher() }

    private fun ssoClient(): OidcClient<AnyProvider> =
        OidcClient.forAuth(
            e2eBlocks().client(),
            listOf("corp"),
            RELAY_TO,
            callbackPath = "/aws-blocks/auth/sso/callback",
            signOutPath = "/aws-blocks/auth/sso/signout",
        ).also { it.platformLauncher = RedirectFollowingLauncher() }

    @Test
    fun signInThroughASecondProvider() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        // The suite shares one cookie jar: start from no session, whatever ran before.
        e2eBlocks().clearStoredState()
        val client = oidcClient()

        val user = client.signIn("github2")

        client.authState.value shouldBe OidcAuthState.SignedIn(user)
        val me = api.oidcRequireAuth()
        me.userId shouldBe user.userId
        me.provider shouldBe "github2"

        assertRestoreThenSignOut(user.userId, "github2", ::oidcClient)
    }

    @Test
    fun signInThroughABlockOnItsOwnRoutes() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        // The suite shares one cookie jar: start from no session, whatever ran before.
        e2eBlocks().clearStoredState()
        val client = ssoClient()

        val user = client.signIn("corp")

        client.authState.value shouldBe OidcAuthState.SignedIn(user)
        val me = api.ssoRequireAuth()
        me.userId shouldBe user.userId
        me.provider shouldBe "corp"

        assertRestoreThenSignOut(user.userId, "corp", ::ssoClient)
        api.ssoGetCurrentUser().shouldBeNull()
    }

    @Test
    fun signingOutOfOneBlockLeavesTheOtherSignedIn() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        // The suite shares one cookie jar: start from no session, whatever ran before.
        e2eBlocks().clearStoredState()
        val oidc = oidcClient()
        val sso = ssoClient()
        oidc.signIn("github2")
        sso.signIn("corp")

        sso.signOut()

        sso.restore().shouldBeNull()
        api.oidcRequireAuth().provider shouldBe "github2"

        // The other direction: signing out of auth-oidc leaves auth-sso signed in.
        sso.signIn("corp")
        oidc.signOut()

        oidc.restore().shouldBeNull()
        api.ssoRequireAuth().provider shouldBe "corp"
        sso.signOut()
    }

    /**
     * A fresh client on the same [com.aws.blocks.kotlin.e2e.e2eBlocks] shares the cookie jar, so
     * restore() finds the session; signOut() returns the stub IdP's logout URL and ends it.
     */
    private suspend fun assertRestoreThenSignOut(
        userId: String,
        provider: String,
        client: () -> OidcClient<AnyProvider>,
    ) {
        val fresh = client()
        fresh.restore()?.userId shouldBe userId

        val logoutUrl = fresh.signOut()
        logoutUrl.shouldNotBeNull().substringBefore('?') shouldEndWith "/aws-blocks/auth/idp/$provider/logout"
        fresh.authState.value shouldBe OidcAuthState.SignedOut

        fresh.restore().shouldBeNull()
    }

    @Test
    fun aBlockRefusesAnotherBlocksSession() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        // The suite shares one cookie jar: start from no session, whatever ran before.
        e2eBlocks().clearStoredState()
        val client = oidcClient()
        client.signIn("github2")
        api.oidcRequireAuth().provider shouldBe "github2"

        val e = shouldThrow<ApiException> { api.ssoRequireAuth() }
        e.name shouldBe AuthErrorNames.NotAuthenticated
        api.ssoGetCurrentUser().shouldBeNull()
        client.signOut()
    }

    private companion object {
        const val RELAY_TO = "nativebindings://auth"
        const val NEEDS_HEADLESS_IDP =
            "Auth's stub IdP runs only locally and on sandbox deployments. Against a deployed " +
                "backend this suite needs RUN_OIDC=1 (see OidcE2ETest)."
    }
}
