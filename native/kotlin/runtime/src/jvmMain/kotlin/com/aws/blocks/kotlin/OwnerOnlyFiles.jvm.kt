package com.aws.blocks.kotlin

import java.nio.file.Files
import java.nio.file.Path
import java.nio.file.attribute.PosixFilePermissions

/**
 * Restricts access to the current user. POSIX permissions are unavailable on some filesystems,
 * where the coarser [java.io.File] flags are the only option.
 */
internal fun restrictToOwner(path: Path, directory: Boolean) {
    val permissions = if (directory) "rwx------" else "rw-------"
    runCatching { Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(permissions)) }
        .onFailure {
            val file = path.toFile()
            file.setReadable(false, false)
            file.setReadable(true, true)
            file.setWritable(false, false)
            file.setWritable(true, true)
            if (directory) {
                file.setExecutable(false, false)
                file.setExecutable(true, true)
            }
        }
}
