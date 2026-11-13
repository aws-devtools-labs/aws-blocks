package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * Only meaningful where a session keyring is actually running. Every test returns early elsewhere
 * rather than failing, so the suite stays green on every other runner — which also means these
 * count as passing while verifying nothing there. The keyring CI job is what gives them meaning.
 *
 * They touch the real Secret Service under a schema prefix of their own and delete what they create,
 * so they cannot disturb a stored session.
 */
class SecretServiceKeyCustodyTest {

    private val onLinux = System.getProperty("os.name").orEmpty().startsWith("Linux")

    private val root: File = Files.createTempDirectory("blocks-secret-service").toFile()

    private val alias = "test-${System.nanoTime()}:com.example.app"

    private fun custody() = SecretServiceKeyCustody(root.toPath(), service = "aws-blocks-test")

    private val key = ByteArray(32) { it.toByte() }

    /**
     * Whether a keyring can actually be reached, which the operating system's name cannot answer.
     *
     * A Linux CI runner or container has the OS and no libsecret, and constructing the custody there
     * raises an [Error] out of the native library loader rather than failing a call — so guarding on
     * the OS alone turns these into seven hard failures anywhere the library is absent.
     *
     * [selectKeyCustody] answers it properly, because its self-test both loads the library and
     * round-trips a probe, and reports the file tier when either step fails. The `onLinux` check has
     * to come first and must stay first: short-circuiting is what keeps this from probing a
     * developer's own keychain on macOS, where the host store is present and asking would prompt.
     */
    private val keyringAvailable: Boolean by lazy {
        onLinux && selectKeyCustody(root.toPath()).tier == KeyTier.OS
    }

    @AfterTest
    fun cleanUp() {
        if (keyringAvailable) runCatching { custody().delete(alias) }
        root.deleteRecursively()
    }

    @Test
    fun loadsNothingBeforeAnythingIsStored() {
        if (!keyringAvailable) return

        custody().load(alias).shouldBeNull()
    }

    @Test
    fun storesThenLoadsTheSameKey() {
        if (!keyringAvailable) return

        custody().storeIfAbsent(alias, key).toList() shouldBe key.toList()

        custody().load(alias)!!.toList() shouldBe key.toList()
    }

    @Test
    fun returnsTheKeyAlreadyHeldRatherThanTheOneOffered() {
        if (!keyringAvailable) return

        custody().storeIfAbsent(alias, key)

        // libsecret overwrites unconditionally, so this is the one the lock exists to make safe:
        // the caller must adopt the key already held, or entries written under it become unreadable.
        custody().storeIfAbsent(alias, ByteArray(32) { 0x7f }).toList() shouldBe key.toList()
    }

    @Test
    fun deleteRemovesTheStoredKey() {
        if (!keyringAvailable) return

        custody().storeIfAbsent(alias, key)

        custody().delete(alias)

        custody().load(alias).shouldBeNull()
    }

    @Test
    fun reportsTheOsTier() {
        if (!keyringAvailable) return

        custody().tier shouldBe KeyTier.OS
    }

    @Test
    fun keepsKeysUnderDifferentAliasesApart() {
        if (!keyringAvailable) return

        val other = "other-${System.nanoTime()}:com.example.app"
        try {
            custody().storeIfAbsent(alias, key)

            custody().load(other).shouldBeNull()
        } finally {
            runCatching { custody().delete(other) }
        }
    }

    @Test
    fun canResolveTheSymbolThatReleasesAReportedError() {
        if (!keyringAvailable) return

        // `g_error_free` is GLib's, reached through libsecret's own dependency chain rather than by
        // loading glib under a soname a user's machine may not have. Nothing calls it until a real
        // failure reports an error, so a declaration that does not resolve would lie dormant and
        // then throw UnsatisfiedLinkError at precisely the moment the error handling is needed.
        // Looking the symbol up here fails the build instead, on both architectures the job runs.
        com.sun.jna.NativeLibrary.getInstance("secret-1").getFunction("g_error_free").name shouldBe
            "g_error_free"
    }

    @Test
    fun reportsNoErrorForAnAliasThatWasNeverStored() {
        if (!keyringAvailable) return

        // A lookup that finds nothing must stay distinguishable from one that failed: the first
        // returns null, and the second now throws. Conflating them let a transient D-Bus failure
        // read as "no key held", which sent the caller on to overwrite the real key and lose every
        // entry written under it. This pins the benign half — a miss must not throw.
        custody().load("never-stored-${System.nanoTime()}:com.example.app").shouldBeNull()
    }

    @Test
    fun storesAKeyWhoseBytesIncludeAZero() {
        if (!keyringAvailable) return

        // The native API takes a NUL-terminated C string, so a raw key containing a zero byte would
        // be truncated. About one AES key in eight contains one, which is why the key is base64'd.
        val withZero = ByteArray(32) { if (it == 7) 0 else (it + 1).toByte() }

        custody().storeIfAbsent(alias, withZero).toList() shouldBe withZero.toList()

        custody().load(alias)!!.toList() shouldBe withZero.toList()
    }
}
