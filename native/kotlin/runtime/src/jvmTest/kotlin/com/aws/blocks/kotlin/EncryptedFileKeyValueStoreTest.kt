package com.aws.blocks.kotlin

import io.kotest.assertions.throwables.shouldThrow
import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.collections.shouldNotBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.io.File
import java.nio.file.Files
import java.util.Base64
import java.nio.file.attribute.PosixFilePermissions
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlin.test.AfterTest
import kotlin.test.Test

class EncryptedFileKeyValueStoreTest {

    private val root: File = Files.createTempDirectory("blocks-kv-test").toFile()

    /**
     * Pinned to the file tier. These tests are about the store's own mechanics — the AES envelope,
     * atomic writes, `.key` permissions — so they must not depend on which custody this machine
     * happens to offer. Left on the default, the suite would reach the real OS secret store on
     * every run, which on macOS means a consent dialog.
     */
    private fun store() =
        EncryptedFileKeyValueStore("cookies", root, "cookies:com.example.app") { FileKeyCustody(it) }

    private val storageDir get() = File(root, "cookies")

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    @Test
    fun roundTripsAValue() = runTest {
        val store = store()
        store.put("jar", "hello")
        store.get("jar") shouldBe "hello"
    }

    @Test
    fun returnsNullForAbsentKey() = runTest {
        store().get("missing").shouldBeNull()
    }

    @Test
    fun clearRemovesEveryEntry() = runTest {
        val store = store()
        store.put("jar", "hello")
        store.put("example.com|session", "stale")

        store.clear()

        store.get("jar").shouldBeNull()
        store.get("example.com|session").shouldBeNull()
    }

    @Test
    fun clearKeepsTheEncryptionKey() = runTest {
        val store = store()
        store.put("jar", "hello")

        store.clear()

        // Dropping the key would leave a second instance generating a different one, after which
        // neither could read what the other wrote.
        File(storageDir, ".key").exists() shouldBe true
        store.put("jar", "after")
        store().get("jar") shouldBe "after"
    }

    @Test
    fun overwritesAnExistingValue() = runTest {
        val store = store()
        store.put("jar", "first")
        store.put("jar", "second")
        store.get("jar") shouldBe "second"
    }

    @Test
    fun doesNotStoreTheValueInPlaintext() = runTest {
        val store = store()
        store.put("jar", "a-session-token")

        val written = storageDir.listFiles().orEmpty().filter { it.isFile && !it.name.startsWith(".") }
        written.forEach { it.readText() shouldNotBe "a-session-token" }
    }

    @Test
    fun readsValuesWrittenByAnEarlierInstance() = runTest {
        store().put("jar", "hello")

        // A second instance must adopt the key the first one created rather than generating one.
        store().get("jar") shouldBe "hello"
    }

    @Test
    fun leavesNoTemporaryFilesBehind() = runTest {
        val store = store()
        repeat(10) { store.put("jar", "value-$it") }

        storageDir.listFiles().orEmpty().filter { it.name.endsWith(".tmp") }.shouldBeEmpty()
    }

    @Test
    fun concurrentWritersNeverLeaveAnUnreadableValue() = runTest {
        val writers = 4
        val store = store()
        // A jar large enough that writing it is not a single operation, which is when a reader can
        // observe a file mid-write.
        val payload = "x".repeat(512 * 1024)
        store.put("jar", payload + "initial")

        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(writers + 1)
        val failures = mutableListOf<String>()
        try {
            val tasks = (0 until writers).map { writer ->
                pool.submit {
                    start.await()
                    runBlocking { repeat(20) { store.put("jar", "$payload-writer-$writer-$it") } }
                }
            } + pool.submit {
                start.await()
                // A read that overlaps a write must see either the previous value or the new one,
                // so it must never decrypt to null.
                runBlocking {
                    repeat(200) {
                        val value = store.get("jar")
                        if (value == null) synchronized(failures) { failures += "read returned null" }
                    }
                }
            }

            start.countDown()
            tasks.forEach { it.get(60, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }

        failures.shouldBeEmpty()
    }

    @Test
    fun publishesAWholeKeyAndLeavesNoTemporaryFileBehind() = runTest {
        store().put("jar", "hello")

        // A key file that appears before it is written can never be read, and every entry written
        // under it is lost, so the key is staged in a temporary file and linked into place. The
        // staging file must not survive.
        val key = File(storageDir, ".key")
        Base64.getDecoder().decode(key.readText()).size shouldBe 32
        storageDir.listFiles().orEmpty().filter { it.name.endsWith(".tmp") }.shouldBeEmpty()
    }

    @Test
    fun reportsAnUnreadableEntryRatherThanCallingItAbsent() = runTest {
        val store = store()
        store.put("jar", "hello")

        // Overwrite the entry with bytes that cannot be decrypted. Returning null here would tell
        // the caller the key is absent and invite it to overwrite a jar that is still present.
        Files.writeString(storageDir.toPath().resolve(Base64.getUrlEncoder().encodeToString("jar".toByteArray())), "garbage")

        shouldThrow<KeyValueStoreException> { store().get("jar") }
    }

    @Test
    fun separateInstancesAgreeOnTheKeyWhenCreatedConcurrently() = runTest {
        val instances = 8
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(instances)
        try {
            // Every instance lazily creates the key on first use. Exactly one key must win, or
            // values written by the others become unreadable.
            val tasks = (0 until instances).map { index ->
                pool.submit {
                    start.await()
                    runBlocking {
                        store().put("entry-$index", "value-$index")
                    }
                }
            }
            start.countDown()
            tasks.forEach { it.get(30, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }

        val reader = store()
        (0 until instances).forEach { index ->
            reader.get("entry-$index") shouldBe "value-$index"
        }
    }

    @Test
    fun restrictsStorageToTheCurrentUser() = runTest {
        val store = store()
        store.put("jar", "hello")

        // Windows has no POSIX permissions; the store falls back to the coarser File flags there.
        if (Files.getFileStore(storageDir.toPath()).supportsFileAttributeView("posix")) {
            Files.getPosixFilePermissions(storageDir.toPath()) shouldBe
                PosixFilePermissions.fromString("rwx------")
            Files.getPosixFilePermissions(File(storageDir, ".key").toPath()) shouldBe
                PosixFilePermissions.fromString("rw-------")
            // Entries are created through Files.createTempFile, which is rw------- on POSIX, and
            // renamed into place. This pins the outcome; it does not on its own exercise
            // restrictToOwner, since the temporary file already has these permissions.
            val entries = storageDir.listFiles { file -> file.name != ".key" }!!.toList()
            entries.shouldNotBeEmpty()
            entries.forEach { entry ->
                Files.getPosixFilePermissions(entry.toPath()) shouldBe
                    PosixFilePermissions.fromString("rw-------")
            }
        }
    }

    @Test
    fun takesItsKeyFromTheCustodyItWasGiven() = runTest {
        // Deliberately a custody no default could produce: it keeps the key in memory and writes
        // nothing. Were the store to consult the machine's own custody instead of this one, it would
        // find no key, mint a different one, and leave a `.key` behind — both of which are asserted
        // below. A file-backed stand-in here would be indistinguishable from the default.
        val custody = InMemoryKeyCustody(ByteArray(32) { 3 })

        val store = EncryptedFileKeyValueStore("cookies", root, "cookies:com.example.app") { custody }
        store.put("jar", "hello")

        // A second store handed the same custody reads what the first wrote.
        EncryptedFileKeyValueStore("cookies", root, "cookies:com.example.app") { custody }
            .get("jar") shouldBe "hello"

        custody.loads shouldBe 2
        File(storageDir, ".key").exists() shouldBe false
    }

    /**
     * Holds one key, in memory, under any alias. Nothing on this machine resolves to it, so the
     * store is pinned to this custody for the test's lifetime.
     *
     * [empty] constructs one with nothing held, as if the OS store had lost the key between
     * launches. The next [storeIfAbsent] installs its own key, as a real OS tier would.
     */
    private class InMemoryKeyCustody(initial: ByteArray?) : KeyCustody {
        override val tier = KeyTier.OS
        var loads = 0
        private var held: ByteArray? = initial

        companion object {
            fun empty() = InMemoryKeyCustody(null)
        }

        override fun load(alias: String): ByteArray? {
            loads++
            return held
        }

        override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray {
            val current = held
            if (current != null) return current
            held = key
            return key
        }

        override fun delete(alias: String) {
            held = null
        }
    }

    @Test
    fun reportsWhichTierItEndedUpWith() = runTest {
        val store = store()
        store.put("jar", "hello")

        // File presence cannot stand in for this: the DPAPI tier keeps a file too.
        store.keyTier shouldBe KeyTier.FILE
    }

    @Test
    fun discardsOrphanEntriesWhenItMintsAFreshKey() = runTest {
        // Simulates a custody that lost its key between launches — a Keychain item deleted, a
        // Secret Service keyring recreated, a directory restored onto a machine the old key is
        // not on. Without the recovery, the entries surviving the loss would be undecryptable:
        // the jar treats a decrypt failure as temporary and declines to replace the entry, so a
        // sign-in would never persist again until the directory was cleaned by hand.
        val firstKey = ByteArray(32) { 1 }
        EncryptedFileKeyValueStore("cookies", root, "cookies:com.example.app") {
            InMemoryKeyCustody(firstKey)
        }.put("jar", "pre-loss")

        // A custody with no key held, as if the OS store had lost it between launches.
        val lost = InMemoryKeyCustody.empty()
        val recovered =
            EncryptedFileKeyValueStore("cookies", root, "cookies:com.example.app") { lost }

        // The orphan entry reads as absent rather than throwing, so the jar loads empty and the
        // next write persists with the new key.
        recovered.get("jar").shouldBeNull()
        recovered.put("jar", "post-loss")
        recovered.get("jar") shouldBe "post-loss"
    }

    @Test
    fun asksTheCustodyForTheKeyOnceEvenWhenItFails() = runTest {
        // A Keychain item this process is not allowed to read prompts the user on every attempt,
        // and the jar calls get and put for every request. Retrying would put a dialog in front
        // of the user for the life of the process, so the failure has to be as memoized as a
        // success. `by lazy` alone does not do that: it re-runs a block that threw.
        val refusing = RefusingKeyCustody()
        val store = EncryptedFileKeyValueStore("cookies", root, "cookies:com.example.app") {
            refusing
        }

        // Writes rather than reads: a read of an entry that is not there returns before it needs
        // the key, so it would not exercise this either way.
        repeat(10) { shouldThrow<KeyValueStoreException> { store.put("jar", "hello") } }

        refusing.attempts shouldBe 1
    }

    /** Stands in for a keychain item the user declined to let this process read. */
    private class RefusingKeyCustody : KeyCustody {
        override val tier = KeyTier.OS
        var attempts = 0

        override fun load(alias: String): ByteArray? {
            attempts++
            throw KeyValueStoreException("The keychain refused to return the encryption key")
        }

        override fun storeIfAbsent(alias: String, key: ByteArray): ByteArray =
            throw KeyValueStoreException("not reached: load throws first")

        override fun delete(alias: String) = Unit
    }
}
