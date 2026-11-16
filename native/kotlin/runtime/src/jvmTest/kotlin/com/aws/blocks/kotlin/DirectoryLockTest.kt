package com.aws.blocks.kotlin

import io.kotest.matchers.collections.shouldBeEmpty
import io.kotest.matchers.shouldBe
import java.io.File
import java.nio.file.Files
import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.Test

class DirectoryLockTest {

    private val root: File = Files.createTempDirectory("blocks-lock").toFile()

    @AfterTest
    fun cleanUp() {
        root.deleteRecursively()
    }

    @Test
    fun returnsWhatTheBlockReturns() {
        withDirectoryLock(root.toPath()) { "value" } shouldBe "value"
    }

    @Test
    fun createsTheDirectoryWhenItIsAbsent() {
        val absent = root.toPath().resolve("not-yet")

        withDirectoryLock(absent) { Unit }

        absent.toFile().isDirectory shouldBe true
    }

    @Test
    fun neverRunsTwoBlocksAtOnce() {
        val inside = AtomicInteger()
        val overlaps = mutableListOf<String>()
        val start = CountDownLatch(1)
        val pool = Executors.newFixedThreadPool(8)
        try {
            val tasks = (0 until 8).map {
                pool.submit {
                    start.await()
                    withDirectoryLock(root.toPath()) {
                        // Any concurrent entrant makes this greater than one.
                        if (inside.incrementAndGet() != 1) {
                            synchronized(overlaps) { overlaps += "overlap" }
                        }
                        Thread.sleep(25)
                        inside.decrementAndGet()
                    }
                }
            }
            start.countDown()
            tasks.forEach { it.get(60, TimeUnit.SECONDS) }
        } finally {
            pool.shutdownNow()
        }

        overlaps.shouldBeEmpty()
    }

    @Test
    fun releasesTheLockWhenTheBlockThrows() {
        runCatching { withDirectoryLock(root.toPath()) { error("boom") } }

        // A lock left held would make this call block until the test timed out.
        withDirectoryLock(root.toPath()) { "after" } shouldBe "after"
    }

    @Test
    fun serialisesAcrossProcesses() {
        // The in-process test above can pass on a purely in-JVM lock. This one cannot: two JVMs
        // contend for the same file, which is the case that matters, because two Blocks
        // applications minting a key are separate processes.
        val java = File(System.getProperty("java.home"), "bin/java").absolutePath
        val classpath = System.getProperty("java.class.path")
        val marker = File(root, "order.txt")

        val processes = (0 until 4).map { index ->
            ProcessBuilder(
                java, "-cp", classpath,
                "com.aws.blocks.kotlin.DirectoryLockProbeKt",
                root.absolutePath, marker.absolutePath, index.toString(),
            ).redirectErrorStream(true).start()
        }
        processes.forEach { it.waitFor(60, TimeUnit.SECONDS) shouldBe true }
        processes.forEach { it.exitValue() shouldBe 0 }

        // Each probe appends "enter N" then "exit N" under the lock. Serialised, every enter is
        // immediately followed by its own exit; interleaved, some enter follows another enter.
        val lines = marker.readLines()
        lines.size shouldBe 8
        lines.chunked(2).forEach { (enter, exit) ->
            enter.substringAfter(' ') shouldBe exit.substringAfter(' ')
        }
    }
}
