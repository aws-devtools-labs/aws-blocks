package com.aws.blocks.kotlin

/**
 * Configuration for one [Blocks] instance: long-lived, and usually the same for every instance in
 * a process.
 *
 * Vary one value across environments with [copy]:
 *
 * ```
 * val base = BlocksConfig(server = Servers.prod, applicationId = "com.example.myapp")
 * val staging = base.copy(server = Servers.staging)
 * ```
 *
 * This is configuration rather than options: options govern a single operation and are passed to
 * it, as [com.aws.blocks.kotlin.oidc.OidcSignInOptions] is to a sign-in.
 *
 * @property applicationId A stable identifier for this application, conventionally reverse-DNS
 *   (`"com.example.myapp"`). It keeps one application's stored data apart from another's, and is
 *   only consulted where the platform does not already do that: Android gives each application a
 *   private sandbox and iOS a Keychain access group, so both ignore it, while a desktop machine
 *   gives an application no private storage at all.
 *
 *   **On desktop, a session survives a restart only when this is set.** Without it there is
 *   nowhere to put the data that another Blocks application could not also reach, so the session
 *   is held in memory for the life of the process and the user signs in again on the next launch.
 *   Choose the value once and keep it: changing it later points the application at a different
 *   directory, which reads as the user being signed out.
 *
 *   On desktop the stored session is encrypted with a key the host OS holds or protects where it
 *   can — the Keychain on macOS, the Data Protection API on Windows — so a backup or copy of the
 *   directory cannot be decrypted elsewhere. Where no OS store can be used the key is kept in a
 *   file beside the entries instead, and that at-rest protection is absent. Neither arrangement
 *   protects the session from another process running as the same OS user; leave this unset to keep
 *   the session in memory only.
 */
data class BlocksConfig(
    val server: BlocksServer,
    val applicationId: String? = null,
)
