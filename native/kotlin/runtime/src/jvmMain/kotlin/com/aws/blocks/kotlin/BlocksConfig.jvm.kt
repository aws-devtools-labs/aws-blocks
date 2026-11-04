package com.aws.blocks.kotlin

import java.io.File

/**
 * JVM configuration.
 *
 * [storageLocation] is the directory this application's stored data lives in. Supply one for a
 * session to survive a restart; without one, storage is held in memory for the life of the
 * process and the caller signs in again on the next launch.
 *
 * ```
 * val blocks = Blocks(
 *     BlocksConfig(
 *         server = Servers.prod,
 *         platformConfig = BlocksPlatformConfig(
 *             storageLocation = applicationDataDirectory(),
 *         ),
 *     ),
 * )
 * ```
 *
 * There is no default, because nothing on the JVM can derive one. `$HOME` is shared by every
 * process the user runs, so a location the library picked would be shared by every Blocks
 * application the user runs with it — two applications against one backend would hold one
 * session, and a debug build would overwrite the session of whatever else used the same origin.
 * Android and iOS do not carry this field: the OS hands each application a private location.
 *
 * The directory is a value rather than something that produces one, so that two configurations
 * naming the same directory compare equal. Nothing reads or creates it here — the store does
 * that, off the calling thread, on first use — so building a configuration stays free of I/O.
 *
 * The application chooses the directory, because the right answer is not the library's to know:
 * roaming versus local on Windows is application policy, a `jpackage` or Conveyor bundle often
 * carries its own convention, and a portable install wants its data beside the executable. The
 * conventional choices are `%LOCALAPPDATA%` on Windows, `~/Library/Application Support` on macOS,
 * and `$XDG_DATA_HOME` on Linux, each with the application's own name beneath it.
 */
actual data class BlocksPlatformConfig(
    val storageLocation: File? = null,
)

internal actual fun defaultPlatformConfig(): BlocksPlatformConfig = BlocksPlatformConfig()
