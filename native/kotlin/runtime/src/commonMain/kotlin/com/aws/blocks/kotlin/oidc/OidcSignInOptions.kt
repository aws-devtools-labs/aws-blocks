package com.aws.blocks.kotlin.oidc

/**
 * Options for one sign-in attempt that apply only to the target the app is built for.
 *
 * Each target declares its own shape. The JVM target carries the pages the loopback server
 * serves once sign-in finishes; Android and iOS have nothing to configure, because their
 * in-app browser dismisses itself.
 */
expect class OidcSignInPlatformOptions

/** What a target uses when the caller supplies no options. */
internal expect fun defaultPlatformOptions(): OidcSignInPlatformOptions

/**
 * Options for one sign-in attempt.
 *
 * Options that apply to every target belong here directly; [platformOptions] carries the
 * ones that do not.
 */
class OidcSignInOptions(
    val platformOptions: OidcSignInPlatformOptions = defaultPlatformOptions(),
)
