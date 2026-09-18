@file:OptIn(InternalBlocksApi::class)

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.InternalBlocksApi

internal actual fun createPlatformLauncher(): OidcPlatformLauncher = object : OidcPlatformLauncher {
    override suspend fun openSession(configuredRelayTo: String): OidcRedirectSession =
        throw UnsupportedOperationException("OIDC sign-in is not supported on this platform")
}
