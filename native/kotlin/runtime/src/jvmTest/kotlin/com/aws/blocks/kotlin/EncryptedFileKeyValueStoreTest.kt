package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import io.kotest.matchers.shouldNotBe
import java.io.File
import java.nio.file.Files
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

    private fun store() = EncryptedFileKeyValueStore("cookies", root)

    private val storageDir get() = File(root, ".blocks/cookies")

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
        EncryptedFileKeyValueStore("cookies", root).get("jar") shouldBe "after"
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
                        EncryptedFileKeyValueStore("cookies", root).put("entry-$index", "value-$index")
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
        }
    }
}
