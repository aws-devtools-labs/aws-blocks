package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.io.File
import java.nio.file.Files
import kotlin.test.AfterTest
import kotlin.test.Test

class KeyCustodySelectionTest {

    private val root: File = Files.createTempDirectory("blocks-selection").toFile()

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    /** Records every alias it is asked about, so a test can prove the probe alias was not fixed. */
    private class RecordingCustody(
        private val onStore: (String) -> Unit = {},
        private val onLoad: (String) -> ByteArray? = { null },
    ) : KeyCustody {
        override val tier = KeyTier.OS
        val seen = mutableListOf<String>()
        private val held = mutableMapOf<String, ByteArray>()

        override fun load(alias: String): ByteArray? {
            seen += alias
            return onLoad(alias) ?: held[alias]
        }

        override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray {
            seen += alias
            onStore(alias)
            return held.getOrPut(alias) { key }
        }

        override fun delete(alias: String) {
            seen += alias
            held.remove(alias)
        }
    }

    @Test
    fun usesTheOsCandidateWhenItPassesItsSelfTest() {
        val candidate = RecordingCustody()

        selectKeyCustody(root.toPath()) { candidate }.tier shouldBe KeyTier.OS
    }

    @Test
    fun fallsBackToTheFileTierWhenTheCandidateThrows() {
        val candidate = RecordingCustody(onStore = { error("no secret service on this machine") })

        selectKeyCustody(root.toPath()) { candidate }.tier shouldBe KeyTier.FILE
    }

    @Test
    fun fallsBackToTheFileTierWhenTheCandidateReturnsTheWrongBytes() {
        // A store that accepts a write and hands back something else is not one to trust with a key.
        val candidate = RecordingCustody(onLoad = { ByteArray(32) { 0x5a } })

        selectKeyCustody(root.toPath()) { candidate }.tier shouldBe KeyTier.FILE
    }

    @Test
    fun fallsBackToTheFileTierWhenThereIsNoCandidateForThisOs() {
        selectKeyCustody(root.toPath()) { null }.tier shouldBe KeyTier.FILE
    }

    @Test
    fun fallsBackToTheFileTierWhenTheNativeLibraryCannotLoad() {
        // A missing or unloadable native library arrives as an Error rather than an Exception, and
        // it surfaces on the first call rather than at construction. An application packaged
        // without the native-access declarations lands here, and the documented consequence of
        // that omission is losing the protection, not failing to start.
        val candidate = RecordingCustody(onStore = { throw UnsatisfiedLinkError("Security not found") })

        selectKeyCustody(root.toPath()) { candidate }.tier shouldBe KeyTier.FILE
    }

    @Test
    fun probesUnderADifferentAliasEveryTime() {
        // These stores are machine-wide. A fixed probe alias lets two applications starting at the
        // same moment overwrite each other's probe and both conclude the store is broken.
        val first = RecordingCustody()
        val second = RecordingCustody()

        selectKeyCustody(root.toPath()) { first }
        selectKeyCustody(root.toPath()) { second }

        first.seen.toSet() shouldNotBe second.seen.toSet()
    }

    @Test
    fun leavesNothingBehindInTheStoreItProbed() {
        val candidate = RecordingCustody()

        selectKeyCustody(root.toPath()) { candidate }

        // Every probe alias it touched must have been deleted again.
        candidate.seen.distinct().filter { candidate.load(it) != null }.shouldBeEmpty()
    }

    @Test
    fun neverProbesTheFileTier() {
        // FileKeyCustody ignores the alias, so a probe would delete the store's real key.
        val key = ByteArray(32) { 7 }
        FileKeyCustody(root.toPath()).storeIfAbsent("cookies:com.example.app", key)

        selectKeyCustody(root.toPath()) { null }

        FileKeyCustody(root.toPath()).load("cookies:com.example.app")!!.toList() shouldBe key.toList()
    }
}
