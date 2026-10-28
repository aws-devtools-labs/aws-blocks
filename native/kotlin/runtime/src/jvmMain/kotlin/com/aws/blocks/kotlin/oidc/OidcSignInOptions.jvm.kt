package com.aws.blocks.kotlin.oidc

/** The pages the loopback server serves when a sign-in attempt finishes. */
actual data class OidcSignInPlatformOptions(
    val successPage: OidcLandingPage = OidcLandingPage.BuiltIn,
    val errorPage: OidcLandingPage = OidcLandingPage.BuiltIn,
)

internal actual fun defaultPlatformOptions(): OidcSignInPlatformOptions =
    OidcSignInPlatformOptions()
