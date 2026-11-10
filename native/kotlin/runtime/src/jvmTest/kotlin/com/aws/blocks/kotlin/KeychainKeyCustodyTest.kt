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
}
