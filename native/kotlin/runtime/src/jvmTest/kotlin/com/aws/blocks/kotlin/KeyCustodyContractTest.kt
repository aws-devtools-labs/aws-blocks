package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test

/**
 * The contract every [KeyCustody] owes its caller, exercised against the file-held tier. An OS tier
 * is held to the same contract by its own test, which can only run on the OS in question.
 */
class KeyCustodyContractTest {

    private val root: File = Files.createTempDirectory("blocks-custody").toFile()

    private fun custody(): KeyCustody = FileKeyCustody(root.toPath())

    private val key = ByteArray(32) { it.toByte() }

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    @Test
    fun loadsNothingBeforeAnythingIsStored() {
        custody().load("cookies:com.example.app").shouldBeNull()
    }

    @Test
    fun storesThenLoadsTheSameKey() {
        custody().storeIfAbsent("cookies:com.example.app", key).toList() shouldBe key.toList()

        custody().load("cookies:com.example.app")!!.toList() shouldBe key.toList()
    }

    @Test
    fun returnsTheKeyAlreadyHeldRatherThanTheOneOffered() {
        custody().storeIfAbsent("cookies:com.example.app", key)

        val loser = ByteArray(32) { 0x7f }

        // The caller must adopt the winner, or every entry the winner wrote becomes unreadable.
        custody().storeIfAbsent("cookies:com.example.app", loser).toList() shouldBe key.toList()
    }

    @Test
    fun deleteRemovesTheStoredKey() {
        custody().storeIfAbsent("cookies:com.example.app", key)

        custody().delete("cookies:com.example.app")

        custody().load("cookies:com.example.app").shouldBeNull()
    }

    @Test
    fun rejectsAKeyOfTheWrongLength() {
        // Standing in for a truncated write. Adopting it would make every entry unreadable.
        KeyFile(root.toPath()).installIfAbsent(byteArrayOf(1, 2, 3)) shouldBe true

        custody().load("cookies:com.example.app").shouldBeNull()
    }

    @Test
    fun reportsTheFileTier() {
        custody().tier shouldBe KeyTier.FILE
    }
}
