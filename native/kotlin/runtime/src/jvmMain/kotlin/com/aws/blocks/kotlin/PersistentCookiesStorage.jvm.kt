package com.aws.blocks.kotlin

import java.io.File
import java.nio.file.Path
import java.util.concurrent.ConcurrentHashMap

/**
 * One jar per storage location, held for the life of the process.
 *
 * Keyed on the derived directory rather than on the id, because two instances configured with the
 * same id resolve to one directory and so must share one jar.
 * The key is normalized but not canonical: resolving symlinks would mean I/O while an instance is
 * being constructed, so two different spellings of one directory are treated as two locations.
 *
 * A jar outlives the instances that used it. One per directory an application configures is a
 * bounded cost, and dropping a jar when an instance closes would take it from the instances still
 * using it.
 */
private val jarsByLocation = ConcurrentHashMap<String, PersistentCookiesStorage>()

/**
 * An instance with no application id gets a jar of its own: it persists nothing, so there is no
 * stored session for a second instance to agree with it about.
 */
internal actual fun cookieJar(applicationId: String?): PersistentCookiesStorage {
    val directory = applicationStorageDirectoryOrNull(applicationId)
        ?: return PersistentCookiesStorage(InMemoryKeyValueStore())
    // Non-null and non-blank, or the directory above would have been null.
    return cookieJarIn(directory, applicationId.orEmpty())
}

/**
 * The one jar persisting to [directory]. Separate from [cookieJar] so a test can name a disposable
 * directory and still go through the registry, which is the part that keeps two instances from
 * discarding each other's cookies.
 *
 * [applicationId] names the key rather than the directory: a key held by the host OS sits in a
 * machine-wide store, so it needs the id to tell one application's key from another's. It is passed
 * separately because [directory] carries the id only in reduced form.
 *
 * [custodyFor] is where the key is kept. A test overrides it to stay on a file beside the entries,
 * because the alternative is reaching the machine's real secret store on every run.
 */
internal fun cookieJarIn(
    directory: File,
    applicationId: String,
    custodyFor: (Path) -> KeyCustody = ::selectKeyCustody,
): PersistentCookiesStorage =
    jarsByLocation.computeIfAbsent(directory.absoluteFile.normalize().path) {
        PersistentCookiesStorage(
            EncryptedFileKeyValueStore(
                COOKIE_STORE_NAME,
                directory,
                keyAlias(COOKIE_STORE_NAME, applicationId),
                custodyFor,
            ),
        )
    }

/**
 * Forgets the cached jars, so a test can stand in for a relaunched process and read what actually
 * reached storage. Nothing in production has reason to call it: a jar's lifetime is the process's.
 */
internal fun forgetCookieJars() {
    jarsByLocation.clear()
}
