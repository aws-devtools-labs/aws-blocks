@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.e2e

import com.aws.blocks.kotlin.InternalBlocksApi
import com.aws.blocks.kotlin.oidc.AnyProvider
import com.aws.blocks.kotlin.oidc.OidcAuthState
import com.aws.blocks.kotlin.oidc.OidcClient
import com.aws.blocks.kotlin.oidc.signIn
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
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
        val client = oidcClient()

        val user = client.signIn("github2")

        client.authState.value shouldBe OidcAuthState.SignedIn(user)
        val me = api.oidcRequireAuth()
        me.userId shouldBe user.userId
        me.provider shouldBe "github2"
        client.signOut()
    }

    @Test
    fun signInThroughABlockOnItsOwnRoutes() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        val client = ssoClient()

        val user = client.signIn("corp")

        client.authState.value shouldBe OidcAuthState.SignedIn(user)
        val me = api.ssoRequireAuth()
        me.userId shouldBe user.userId
        me.provider shouldBe "corp"
    }

    @Test
    fun signOutOfABlockOnItsOwnRoutes() = runTest {
        if (!hasHeadlessIdp()) {
            markSkipped(NEEDS_HEADLESS_IDP)
            return@runTest
        }
        val client = ssoClient()
        client.signIn("corp")

        client.signOut()

        client.authState.value shouldBe OidcAuthState.SignedOut
        api.ssoGetCurrentUser().shouldBeNull()
    }

    private companion object {
        const val RELAY_TO = "nativebindings://auth"
        const val NEEDS_HEADLESS_IDP =
            "Auth's stub IdP runs only locally and on sandbox deployments. Against a deployed " +
                "backend this suite needs RUN_OIDC=1 (see OidcE2ETest)."
    }
}
