package com.aws.blocks.kotlin

/**
 * Configuration that applies only to the target the app is built for.
 *
 * Each target declares its own shape. The JVM target carries the directory its storage lives in,
 * because nothing on the JVM can derive one; Android and iOS have nothing to configure, because
 * the OS already hands each application a private location of its own.
 */
expect class BlocksPlatformConfig

/** What a target uses when the caller supplies no platform configuration. */
internal expect fun defaultPlatformConfig(): BlocksPlatformConfig

/**
 * Configuration for one [Blocks] instance: long-lived, and usually the same for every instance in
 * a process.
 *
 * Values that apply to every target belong here directly; [platformConfig] carries the ones that
 * do not. Vary one value across environments with [copy]:
 *
 * ```
 * val base = BlocksConfig(server = Servers.prod)
 * val staging = base.copy(server = Servers.staging)
 * ```
 *
 * This is configuration rather than options: options govern a single operation and are passed to
 * it, as [com.aws.blocks.kotlin.oidc.OidcSignInOptions] is to a sign-in.
 */
data class BlocksConfig(
    val server: BlocksServer,
    val platformConfig: BlocksPlatformConfig = defaultPlatformConfig(),
)
