package com.aws.blocks.kotlin

import java.io.File

/**
 * Launched as a separate JVM by `DirectoryLockTest.serialisesAcrossProcesses`. Takes the lock, notes
 * that it entered, pauses long enough for a sibling to contend, and notes that it left.
 */
fun main(args: Array<String>) {
    val directory = File(args[0]).toPath()
    val marker = File(args[1])
    val id = args[2]

    // No in-process synchronisation here on purpose: each probe is its own JVM, so the only thing
    // keeping these two appends adjacent in the file is the directory lock under test.
    withDirectoryLock(directory) {
        marker.appendText("enter $id\n")
        Thread.sleep(50)
        marker.appendText("exit $id\n")
    }
}
