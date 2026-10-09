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
     */
    suspend fun openSession(configuredRelayTo: String): OidcRedirectSession
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

    /** Releases whatever [relayTo] reserved. Called exactly once per session. */
    fun close()
}
