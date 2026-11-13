package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import java.io.File
import java.nio.file.Files
import kotlinx.coroutines.runBlocking
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

        // The file holds a wrapped blob only this user account on this machine can unwrap. Asserting
        // the whole file differs from the key would pass for any wrapping at all, including one that
        // carried the key along unchanged, so look for the key's bytes anywhere inside the blob.
        val blob = java.util.Base64.getDecoder().decode(File(root, ".key.dpapi").readText())
        blob.toList().windowed(key.size).contains(key.toList()) shouldBe false
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

    @Test
    fun ignoresTheRawKeyAReleaseBeforeOsCustodyLeftBehind() {
        if (!onWindows) return

        // Exactly what a machine upgrading from a release before OS custody starts with. Sharing
        // one filename made this unrecoverable: the install declined because the file was there,
        // the read could not unwrap a raw key, and the store threw on every call thereafter —
        // for good, because nothing ever minted a key and so nothing ever cleaned up.
        KeyFile(root.toPath()).installIfAbsent(ByteArray(32) { 9 }) shouldBe true

        custody().storeIfAbsent("cookies:com.example.app", key).toList() shouldBe key.toList()

        custody().load("cookies:com.example.app")!!.toList() shouldBe key.toList()
        // And the superseded file is gone, so a later launch that falls back to the file tier
        // cannot adopt it and spend the rest of its life failing to decrypt DPAPI-keyed entries.
        File(root, ".key").exists() shouldBe false
    }

    @Test
    fun replacesABlobItCannotUnwrap() {
        if (!onWindows) return

        // A blob truncated by a stopped process, or wrapped for another user account or machine as
        // a restored backup leaves. Nothing can have been written under a key nobody can unwrap, so
        // replacing it loses nothing; leaving it stopped every call for the life of the directory.
        KeyFile(root.toPath(), ".key.dpapi").installIfAbsent("not a dpapi blob".toByteArray()) shouldBe
            true

        custody().storeIfAbsent("cookies:com.example.app", key).toList() shouldBe key.toList()

        custody().load("cookies:com.example.app")!!.toList() shouldBe key.toList()
    }

    @Test
    fun aSessionSurvivesARelaunchAfterUpgradingFromARawKey() {
        if (!onWindows) return

        // The whole point, end to end and through the store rather than the custody: a directory
        // carrying a release-before-OS-custody `.key` and the entries written under it. The user
        // signs in once more on the launch that upgrades, and from then on the session persists.
        val store = { EncryptedFileKeyValueStore("cookies", root, "cookies:com.example.app") { dir -> DpapiKeyCustody(dir) } }
        val storageDir = File(root, "cookies").also { it.mkdirs() }
        KeyFile(storageDir.toPath()).installIfAbsent(ByteArray(32) { 9 }) shouldBe true

        runBlocking {
            // The entry from before the upgrade is unreadable, and reads as absent rather than
            // throwing, so the jar writes over it instead of refusing to.
            store().get("jar").shouldBeNull()
            store().put("jar", "a-session")

            // The relaunch. A new store on the same directory reads what the last one wrote.
            store().get("jar") shouldBe "a-session"
        }
    }
}
