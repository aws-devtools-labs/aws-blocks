package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.InternalBlocksApi

/**
 * Opens the system browser for OIDC sign-in and reports the relay redirect back.
 */
@InternalBlocksApi
interface OidcPlatformLauncher {
    /**
     * Reserves a relay target for a single sign-in attempt.
     *
     * [configuredRelayTo] is the build-configured URI, empty when none was configured.
     * Implementations that bind their own address ignore it and return their own.
     * [options] carries the caller's per-attempt choices; an implementation reads only
     * [OidcSignInOptions.platformOptions], which has its own shape on each target.
     */
    suspend fun openSession(
        configuredRelayTo: String,
        options: OidcSignInOptions = OidcSignInOptions(),
    ): OidcRedirectSession
}

/**
 * One sign-in attempt's relay target, and the browser interaction that fills it.
 */
@InternalBlocksApi
interface OidcRedirectSession {
    /** The relay target for this attempt, sent to the backend so it can redirect here. */
    val relayTo: String

    /** Opens [authorizeUrl] and suspends until the relay redirect arrives. */
    suspend fun awaitRedirect(authorizeUrl: String): String

    /**
     * Reports how the attempt ended, once the caller has validated the callback and
     * exchanged the code.
     *
     * A redirect carrying a `code` is not yet a successful sign-in: the state and CSRF
     * values still have to match and the exchange still has to succeed. An implementation
     * that shows the user something after the redirect waits for this, so it reports the
     * real outcome rather than inferring one from the callback query.
     *
     * Returns once the user has been shown the outcome, so [close] cannot interrupt it.
     * Called at most once, and not at all if the attempt never reached a redirect.
     */
    fun reportOutcome(outcome: OidcSignInOutcome)

    /** Releases whatever [relayTo] reserved. Called exactly once per session. */
    fun close()
}

/** How a sign-in attempt ended, as reported to [OidcRedirectSession.reportOutcome]. */
@InternalBlocksApi
sealed interface OidcSignInOutcome {

    /** The code was exchanged and the user is signed in. */
    data object Succeeded : OidcSignInOutcome

    /**
     * The attempt failed. [error] and [description] carry the identity provider's values
     * when it reported the failure, and short codes of our own when the callback or the
     * exchange was rejected locally.
     */
    data class Failed(val error: String?, val description: String?) : OidcSignInOutcome
}
