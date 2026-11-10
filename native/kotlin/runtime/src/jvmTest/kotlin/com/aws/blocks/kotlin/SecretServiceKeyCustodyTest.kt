package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * Only meaningful on Linux, and only where a session keyring is running. Every test returns early
 * elsewhere rather than failing, so the suite stays green on the Windows and macOS runners — which
 * also means these count as passing while verifying nothing there. The keyring CI job is what gives
 * them meaning.
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

    @AfterTest
    fun cleanUp() {
        if (onLinux) runCatching { custody().delete(alias) }
        root.deleteRecursively()
    }

    @Test
    fun loadsNothingBeforeAnythingIsStored() {
        if (!onLinux) return

        custody().load(alias).shouldBeNull()
    }

    @Test
    fun storesThenLoadsTheSameKey() {
        if (!onLinux) return

        custody().storeIfAbsent(alias, key).toList() shouldBe key.toList()

        custody().load(alias)!!.toList() shouldBe key.toList()
    }

    @Test
    fun returnsTheKeyAlreadyHeldRatherThanTheOneOffered() {
        if (!onLinux) return

        custody().storeIfAbsent(alias, key)

        // libsecret overwrites unconditionally, so this is the one the lock exists to make safe:
        // the caller must adopt the key already held, or entries written under it become unreadable.
        custody().storeIfAbsent(alias, ByteArray(32) { 0x7f }).toList() shouldBe key.toList()
    }

    @Test
    fun deleteRemovesTheStoredKey() {
        if (!onLinux) return

        custody().storeIfAbsent(alias, key)

        custody().delete(alias)

        custody().load(alias).shouldBeNull()
    }

    @Test
    fun reportsTheOsTier() {
        if (!onLinux) return

        custody().tier shouldBe KeyTier.OS
    }

    @Test
    fun keepsKeysUnderDifferentAliasesApart() {
        if (!onLinux) return

        val other = "other-${System.nanoTime()}:com.example.app"
        try {
            custody().storeIfAbsent(alias, key)

            custody().load(other).shouldBeNull()
        } finally {
            runCatching { custody().delete(other) }
        }
    }

    @Test
    fun storesAKeyWhoseBytesIncludeAZero() {
        if (!onLinux) return

        // The native API takes a NUL-terminated C string, so a raw key containing a zero byte would
        // be truncated. About one AES key in eight contains one, which is why the key is base64'd.
        val withZero = ByteArray(32) { if (it == 7) 0 else (it + 1).toByte() }

        custody().storeIfAbsent(alias, withZero).toList() shouldBe withZero.toList()

        custody().load(alias)!!.toList() shouldBe withZero.toList()
    }
}
