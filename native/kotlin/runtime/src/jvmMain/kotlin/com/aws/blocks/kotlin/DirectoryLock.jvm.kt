package com.aws.blocks.kotlin

import java.nio.channels.FileChannel
import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.StandardOpenOption
import java.util.concurrent.locks.ReentrantLock
import kotlin.concurrent.withLock

/** The file every process of one application contends for. Holds nothing; only its lock matters. */
private const val LOCK_FILE = ".lock"

/**
 * Serialises callers within this process, which the file lock below cannot do.
 *
 * One lock for every directory rather than one per directory, deliberately. A per-directory map
 * would put the correctness into its key: two spellings of one path would take two different locks,
 * both would reach the file lock, and the second would be rejected rather than made to wait — the
 * failure this exists to prevent. Minting a key is rare and brief, so the breadth costs nothing.
 */
private val processLock = ReentrantLock()

/**
 * Runs [block] with an exclusive lock on [directory], held against other threads in this process
 * and other processes alike.
 *
 * This exists for a secret store with no create-if-absent operation. Such a store overwrites
 * unconditionally, so two processes each minting a key can leave one of them having written entries
 * under a key that is no longer the stored one — and reading the key back after storing it does not
 * help, because the overwrite happens afterwards. Serialising the whole look-up-then-store sequence
 * is what closes that.
 *
 * Two layers are needed because they cover different contenders. [FileChannel.lock] waits for
 * another *process* but throws for an overlapping lock held by another thread of this one, so the
 * file lock alone would reject concurrent callers instead of queueing them.
 *
 * Calls must not nest: the inner acquisition would pass the reentrant process lock and then be
 * rejected by the file lock. There is one caller, and it does not nest.
 *
 * The locks are advisory between cooperating processes, which is all that is needed: the only
 * contenders are other instances of this library, and they all come through here. Both are released
 * on every path, including when [block] throws.
 */
internal fun <T> withDirectoryLock(directory: Path, block: () -> T): T {
    Files.createDirectories(directory)
    restrictToOwner(directory, directory = true)
    val path = directory.resolve(LOCK_FILE)
    return processLock.withLock {
        FileChannel.open(path, StandardOpenOption.CREATE, StandardOpenOption.WRITE).use { channel ->
            restrictToOwner(path, directory = false)
            // Blocks until the holder releases. There is no useful timeout: the alternative to
            // waiting is minting a second key, which is the outcome this prevents.
            channel.lock().use {
                block()
            }
        }
    }
}
