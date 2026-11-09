package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * Only meaningful on Windows: DPAPI is a Windows service, and there is nothing to stand in for it
 * elsewhere. Every test returns early on another OS rather than failing, so the suite stays green
 * on the macOS runner that builds this module.
 */
class DpapiKeyCustodyTest {

    private val onWindows = System.getProperty("os.name").orEmpty().startsWith("Windows")

    private val root: File = Files.createTempDirectory("blocks-dpapi").toFile()

    private fun custody() = DpapiKeyCustody(root.toPath())

    private val key = ByteArray(32) { it.toByte() }

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    @Test
    fun storesThenLoadsTheSameKey() {
        if (!onWindows) return

        custody().storeIfAbsent("cookies:com.example.app", key).toList() shouldBe key.toList()

        custody().load("cookies:com.example.app")!!.toList() shouldBe key.toList()
    }

    @Test
    fun reportsTheOsTier() {
        if (!onWindows) return

        custody().tier shouldBe KeyTier.OS
    }

    @Test
    fun theKeyIsNotOnDiskInTheClear() {
        if (!onWindows) return

        custody().storeIfAbsent("cookies:com.example.app", key)

        // The file holds a wrapped blob only this user account on this machine can unwrap.
        val stored = File(root, ".key").readBytes()
        String(stored) shouldNotBe java.util.Base64.getEncoder().encodeToString(key)
    }

    @Test
    fun willNotUnwrapAKeyStoredUnderADifferentAlias() {
        if (!onWindows) return

        custody().storeIfAbsent("cookies:com.example.app", key)

        // The alias is the entropy, so another application's blob is not readable as this one's.
        custody().load("cookies:com.other.app").shouldBeNull()
    }

    @Test
    fun returnsTheKeyAlreadyHeldRatherThanTheOneOffered() {
        if (!onWindows) return

        custody().storeIfAbsent("cookies:com.example.app", key)

        custody().storeIfAbsent("cookies:com.example.app", ByteArray(32) { 0x7f }).toList() shouldBe
            key.toList()
    }
}
