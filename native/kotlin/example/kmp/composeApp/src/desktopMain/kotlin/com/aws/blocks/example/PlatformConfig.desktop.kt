package com.aws.blocks.example

import com.aws.blocks.kotlin.BlocksPlatformConfig
import java.io.File

/** Without a location the signed-in session would be forgotten every time the app restarts. */
actual fun platformConfig(): BlocksPlatformConfig = BlocksPlatformConfig(
    storageLocation = applicationDataDirectory("BlocksKmpExample"),
)

/**
 * The directory each desktop OS reserves for one application's own data.
 *
 * There is no portable answer here, which is why the library asks the application rather than
 * picking for it: roaming versus local is policy on Windows, a packaged bundle often carries its
 * own convention, and a portable install wants its data beside the executable. This is the
 * conventional choice for an installed desktop app.
 */
private fun applicationDataDirectory(appName: String): File {
    val home = System.getProperty("user.home")
    val os = System.getProperty("os.name").lowercase()
    val base = when {
        os.startsWith("windows") -> System.getenv("LOCALAPPDATA") ?: "$home\\AppData\\Local"
        os.startsWith("mac") -> "$home/Library/Application Support"
        else -> System.getenv("XDG_DATA_HOME") ?: "$home/.local/share"
    }
    return File(base, appName)
}
