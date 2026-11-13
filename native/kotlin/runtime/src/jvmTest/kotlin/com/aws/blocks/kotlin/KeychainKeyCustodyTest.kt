package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * Only meaningful on macOS. Every test returns early elsewhere rather than failing, so the suite
 * stays green on the Windows and Linux runners.
 *
 * These tests touch the real login keychain. They use a service name of their own and delete what
 * they create, so they cannot disturb a stored session.
 */
class KeychainKeyCustodyTest {

    private val onMac = System.getProperty("os.name").orEmpty().startsWith("Mac")

    private val alias = "test-${System.nanoTime()}:com.example.app"

    private fun custody() = KeychainKeyCustody(service = "aws-blocks-test")

    private val key = ByteArray(32) { it.toByte() }

    @AfterTest
    fun cleanUp() {
        if (onMac) runCatching { custody().delete(alias) }
    }

    @Test
    fun loadsNothingBeforeAnythingIsStored() {
        if (!onMac) return

        custody().load(alias).shouldBeNull()
    }

    @Test
    fun storesThenLoadsTheSameKey() {
        if (!onMac) return

        custody().storeIfAbsent(alias, key).toList() shouldBe key.toList()

        custody().load(alias)!!.toList() shouldBe key.toList()
    }

    @Test
    fun returnsTheKeyAlreadyHeldRatherThanTheOneOffered() {
        if (!onMac) return

        custody().storeIfAbsent(alias, key)

        // A duplicate add must not overwrite: the caller has to adopt the winner, or every entry
        // written under the winner's key becomes unreadable.
        custody().storeIfAbsent(alias, ByteArray(32) { 0x7f }).toList() shouldBe key.toList()
    }

    @Test
    fun deleteRemovesTheStoredKey() {
        if (!onMac) return

        custody().storeIfAbsent(alias, key)

        custody().delete(alias)

        custody().load(alias).shouldBeNull()
    }

    @Test
    fun reportsTheOsTier() {
        if (!onMac) return

        custody().tier shouldBe KeyTier.OS
    }

    @Test
    fun keepsKeysUnderDifferentAliasesApart() {
        if (!onMac) return

        val other = "other-${System.nanoTime()}:com.example.app"
        try {
            custody().storeIfAbsent(alias, key)

            custody().load(other).shouldBeNull()
        } finally {
            runCatching { custody().delete(other) }
        }
    }

    @Test
    fun replacesAnItemThatHoldsSomethingOtherThanAKey() {
        if (!onMac) return

        // An item under our service and account that is not a 32-byte key, as an older format or
        // a partial write would leave. Left in place it would wedge the store: the add reports a
        // duplicate, the read cannot use what is there, and every call would throw for the life of
        // the directory. Nothing can have been written under it, so replacing it orphans nothing.
        //
        // Planted through this custody rather than the `security` tool on purpose. An item the
        // tool creates carries the tool's code identity, so reading it from this JVM asks the user
        // to consent — which would make this test hang on a dialog and take the suite with it.
        custody().storeIfAbsent(alias, byteArrayOf(1, 2, 3)).toList() shouldBe listOf<Byte>(1, 2, 3)

        custody().load(alias).shouldBeNull()

        custody().storeIfAbsent(alias, key).toList() shouldBe key.toList()
        custody().load(alias)!!.toList() shouldBe key.toList()
    }
}
