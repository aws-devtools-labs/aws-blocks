package com.aws.blocks.kotlin

import java.util.concurrent.ConcurrentHashMap

/**
 * One jar per storage location, held for the life of the process.
 *
 * Keyed on the directory rather than on the configuration, because two instances built from
 * separate [BlocksPlatformConfig] values still share a session when they name the same directory.
 * The key is normalized but not canonical: resolving symlinks would mean I/O while an instance is
 * being constructed, so two different spellings of one directory are treated as two locations.
 *
 * A jar outlives the instances that used it. One per directory an application configures is a
 * bounded cost, and dropping a jar when an instance closes would take it from the instances still
 * using it.
 */
private val jarsByLocation = ConcurrentHashMap<String, PersistentCookiesStorage>()

/**
 * An instance configured with no location gets a jar of its own: it persists nothing, so there is
 * no stored session for a second instance to agree with it about.
 */
internal actual fun cookieJar(platformConfig: BlocksPlatformConfig): PersistentCookiesStorage {
    val location = platformConfig.storageLocation
        ?: return PersistentCookiesStorage(InMemoryKeyValueStore())
    return jarsByLocation.computeIfAbsent(location.absoluteFile.normalize().path) {
        PersistentCookiesStorage(EncryptedFileKeyValueStore(COOKIE_STORE_NAME, location))
    }
}

/**
 * Forgets the cached jars, so a test can stand in for a relaunched process and read what actually
 * reached storage. Nothing in production has reason to call it: a jar's lifetime is the process's.
 */
internal fun forgetCookieJars() {
    jarsByLocation.clear()
}
