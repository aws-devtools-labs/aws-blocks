package com.aws.blocks.kotlin.oidc

/** Nothing to configure: the Custom Tab dismisses itself when sign-in finishes. */
actual class OidcSignInPlatformOptions

internal actual fun defaultPlatformOptions(): OidcSignInPlatformOptions =
    OidcSignInPlatformOptions()
