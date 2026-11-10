package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.io.File
import java.nio.file.Files
import java.nio.file.Path
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

    @Test
    fun probesAgainstAScratchDirectoryRatherThanTheRealOne() {
        // The real fear is a custody whose delete doesn't honour the alias — one shared `.key`,
        // like DPAPI, or a tier whose delete removes the key file outright. If the probe ran
        // against the real directory, the self-test's clean-up would wipe the live key and the
        // session would stop surviving a restart. Pinning with a file-backed OS candidate:
        // without the scratch directory the probe would create and then delete `.key` here.
        val key = ByteArray(32) { 42 }
        FileKeyCustody(root.toPath()).storeIfAbsent("cookies:com.example.app", key)

        selectKeyCustody(root.toPath()) { FileKeyCustody(it) }

        FileKeyCustody(root.toPath()).load("cookies:com.example.app")!!.toList() shouldBe key.toList()
    }

    @Test
    fun theProbeRunsBeforeTheRealCandidateIsBuilt() {
        // The probe is isolated so firmly that the candidate built for the real directory need
        // not have been constructed yet — if construction cost is non-trivial (a native library
        // call, a dbus connection), paying that cost is the probe's job.
        val built = mutableListOf<Path>()

        selectKeyCustody(root.toPath()) { directory ->
            built.add(directory)
            RecordingCustody()
        }

        // One build for the probe over the scratch directory, one for the real store.
        built.size shouldBe 2
        built[0] shouldNotBe root.toPath()
        built[1] shouldBe root.toPath()
    }

    @Test
    fun resolvesToTheHostStoreOnAPlatformThatHasOne() {
        // The only test that leaves the OS candidate at its default, so the only one that exercises
        // the decision production actually makes. Every other case here injects a candidate, which
        // proves the selection logic but not that this machine reaches a working store through it.
        //
        // On a platform with a tier, this drives a real self-test: a probe written, read back and
        // deleted under a random alias. Linux has no binding yet and so still expects the file tier.
        val os = System.getProperty("os.name").orEmpty()
        val hasHostStore = os.startsWith("Mac")

        selectKeyCustody(root.toPath()).tier shouldBe if (hasHostStore) KeyTier.OS else KeyTier.FILE
    }
}
