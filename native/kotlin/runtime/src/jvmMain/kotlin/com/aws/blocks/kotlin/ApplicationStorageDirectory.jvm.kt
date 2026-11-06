package com.aws.blocks.kotlin

import java.io.File

/** Everything this runtime stores on a desktop machine lives beneath this, one directory per app. */
private const val BLOCKS_DIRECTORY = ".blocks"

/** What a directory name may hold. Anything else is replaced. */
private val SAFE_CHARACTERS = Regex("[^A-Za-z0-9._-]")

/** Long enough for a reverse-DNS id, short enough to stay well inside any path limit. */
private const val MAX_NAME_LENGTH = 120

/**
 * Where an application's stored data lives: `~/.blocks/<applicationId>`.
 *
 * A desktop OS gives an application no private storage of its own, so the id is what keeps two
 * applications apart. Releases before this one wrote straight into `~/.blocks`, which every Blocks
 * application on the machine therefore shared.
 *
 * The id is reduced to characters a directory name can hold. When that reduction changes anything,
 * a digest of the id as supplied is appended, so two ids that would otherwise reduce to the same
 * name — `My/App` and `My App` both becoming `My_App` — keep separate directories. Reintroducing
 * the collision inside the mechanism meant to prevent it would be a poor trade for a tidier name.
 */
internal fun applicationStorageDirectory(
    applicationId: String,
    root: File = File(System.getProperty("user.home")),
): File = File(File(root, BLOCKS_DIRECTORY), storageName(applicationId))

private fun storageName(applicationId: String): String {
    // A leading dot would hide the directory, and `.`/`..` would name the parent.
    val trimmed = applicationId.trim().trimStart('.')
    val safe = trimmed.replace(SAFE_CHARACTERS, "_").take(MAX_NAME_LENGTH)
    val unchanged = safe == trimmed
    // An empty result would put the data in `.blocks` itself, which is the shared directory this
    // exists to avoid, so a name that reduces to nothing is carried entirely by its digest.
    return if (unchanged && safe.isNotEmpty()) safe else "$safe-${digest(applicationId)}"
}

/** FNV-1a, for a short stable suffix. Not a security property — only distinctness. */
private fun digest(value: String): String {
    var hash = -0x340d631b7bdddcdbL // 0xcbf29ce484222325
    for (byte in value.encodeToByteArray()) {
        hash = hash xor (byte.toLong() and 0xff)
        hash *= 0x100000001b3L
    }
    return hash.toULong().toString(16).padStart(16, '0')
}

/**
 * The directory [applicationId] stores into, or null when there is none to derive one from.
 *
 * A blank id is treated as no id: it identifies nothing, so an unset build property arriving as an
 * empty string should not quietly create a directory that cannot be traced back to an application.
 */
internal fun applicationStorageDirectoryOrNull(applicationId: String?): File? =
    applicationId?.takeIf { it.isNotBlank() }?.let { applicationStorageDirectory(it) }
