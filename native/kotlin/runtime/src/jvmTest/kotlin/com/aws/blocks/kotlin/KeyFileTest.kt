package com.aws.blocks.kotlin

import io.kotest.matchers.nulls.shouldBeNull
import io.kotest.matchers.shouldBe
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.Test

class KeyFileTest {

    private val root: File = Files.createTempDirectory("blocks-key-file").toFile()

    private fun keyFile() = KeyFile(root.toPath())

    private val anyBytes: (ByteArray) -> Boolean = { true }

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    @Test
    fun readsNothingWhenNoKeyHasBeenInstalled() {
        keyFile().read(anyBytes).shouldBeNull()
    }

    @Test
    fun installsThenReadsBackTheSameBytes() {
        val bytes = byteArrayOf(1, 2, 3, 4)

        keyFile().installIfAbsent(bytes) shouldBe true

        keyFile().read(anyBytes)!!.toList() shouldBe bytes.toList()
    }

    @Test
    fun declinesToInstallOverAKeyThatIsAlreadyThere() {
        keyFile().installIfAbsent(byteArrayOf(1, 2, 3)) shouldBe true

        keyFile().installIfAbsent(byteArrayOf(9, 9, 9)) shouldBe false

        keyFile().read(anyBytes)!!.toList() shouldBe listOf<Byte>(1, 2, 3)
    }

    @Test
    fun storesBytesOfAnyLengthRatherThanAssumingAKeySize() {
        // The DPAPI tier stores a wrapped blob here, which is longer than the key inside it.
        val blob = ByteArray(97) { it.toByte() }

        keyFile().installIfAbsent(blob) shouldBe true

        keyFile().read(anyBytes)!!.size shouldBe 97
    }

    @Test
    fun rejectsBytesTheCallerCallsInvalid() {
        keyFile().installIfAbsent(byteArrayOf(1, 2, 3)) shouldBe true

        // Standing in for a truncated key, or a blob that will not unwrap.
        keyFile().read { it.size == 32 }.shouldBeNull()
    }

    @Test
    fun deletesTheKeyItInstalled() {
        keyFile().installIfAbsent(byteArrayOf(1, 2, 3)) shouldBe true

        keyFile().delete()

        keyFile().read(anyBytes).shouldBeNull()
    }

    @Test
    fun leavesNoTemporaryFileBehind() {
        keyFile().installIfAbsent(byteArrayOf(1, 2, 3)) shouldBe true

        root.listFiles().orEmpty().filter { it.name.endsWith(".tmp") }.size shouldBe 0
    }

    @Test
    fun exactlyOneConcurrentInstallerWins() {
        val installers = 8
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(installers)
        try {
            val tasks = (0 until installers).map { index ->
                pool.submit<Boolean> {
                    start.await()
                    keyFile().installIfAbsent(byteArrayOf(index.toByte()))
                }
            }
            start.countDown()
            tasks.count { it.get(30, TimeUnit.SECONDS) } shouldBe 1
        } finally {
            pool.shutdownNow()
        }
    }
}
