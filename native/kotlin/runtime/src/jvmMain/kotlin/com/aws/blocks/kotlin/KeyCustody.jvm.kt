package com.aws.blocks.kotlin

import java.nio.file.Files
import java.nio.file.Path
import java.security.SecureRandom
import java.util.UUID

/** The size of the AES key every store encrypts its entries with. */
internal const val AES_KEY_SIZE = 32

/** Which of the two custody arrangements a store ended up with. Reported for tests only. */
internal enum class KeyTier {
    /** The host OS holds or protects the key. */
    OS,

    /** The key sits beside the entries it protects, as it did before OS custody existed. */
    FILE,
}

/**
 * Holds the key that encrypts one store's entries.
 *
 * A desktop OS gives an application no private storage, so a key beside the entries protects
 * nothing against another program the same user runs. Handing the key to the OS does not change
 * that either — every desktop secret store is reachable by anything in the user's session. What it
 * does buy is at-rest exfiltration resistance: a copied disk, a backup or a synced folder yields
 * entries whose key is not in the copy.
 */
internal interface KeyCustody {

    val tier: KeyTier

    /** The key held under [alias], or null when none is held or what is held is unusable. */
    fun load(alias: String): ByteArray?

    /**
     * Stores [key] under [alias] unless one is already held, returning whichever key is held
     * afterwards.
     *
     * Returning the winner rather than reporting success is what makes concurrent creation safe.
     * Two processes starting together each generate a key; both must end up using one of them, or
     * the loser's entries become unreadable. Implementations reach this differently — a hard link,
     * a duplicate-item error, or storing and reading back — so the guarantee lives here rather
     * than in the caller.
     */
    fun storeIfAbsent(alias: String, key: ByteArray): ByteArray

    /** Removes the key held under [alias]. Used by the self-test to clean up after its probe. */
    fun delete(alias: String)
}

/**
 * The name one store's key is held under: `<name>:<applicationId>`.
 *
 * The name comes first because it is this library's to choose and the application id is not. With
 * a colon-free name, the first colon is always the boundary, so an application id containing
 * colons cannot be read as a different pair. The alias is only ever constructed for lookup and
 * never parsed back, so collision resistance is the whole requirement.
 *
 * The id is used as supplied rather than reduced the way a directory name must be: an OS secret
 * store has no filename constraints, and leaving it legible keeps entries identifiable when
 * inspecting the store by hand.
 */
internal fun keyAlias(name: String, applicationId: String): String {
    require(!name.contains(':')) { "A store name may not contain ':', and '$name' does" }
    return "$name:$applicationId"
}

/**
 * The custody a store on this machine should use: the host OS store when it works, and a key
 * beside the entries when it does not.
 *
 * [osCandidate] builds the OS-held custody for this machine, or returns null when there is none to
 * try. It is a parameter so a test can supply one that misbehaves.
 *
 * Any failure falls back, rather than distinguishing a store that is absent from one that is
 * present and behaving oddly. The two deserve different responses in principle, but this library
 * has no way to report the difference, so failing closed on the second would make an application
 * crash the only signal — worse than the degradation it would be avoiding.
 */
internal fun selectKeyCustody(
    directory: Path,
    osCandidate: (Path) -> KeyCustody? = ::osKeyCustody,
): KeyCustody {
    if (!osCandidatePassesProbe(osCandidate)) return FileKeyCustody(directory)
    val candidate = runCatching { osCandidate(directory) }.getOrNull() ?: return FileKeyCustody(directory)
    return candidate
}

/**
 * Runs the self-test against a candidate built over a scratch directory rather than the real
 * store's directory, so the probe cannot touch anything the store will later rely on.
 *
 * Not every custody keeps the key apart from other aliases: `FileKeyCustody` holds one key per
 * directory, and `DpapiKeyCustody` wraps its blob into the same `.key`. Probing the real candidate
 * would run `storeIfAbsent(probeAlias, …)` against a `.key` that already holds the real key, fail
 * to unwrap it, and then `delete(probeAlias)` would remove the real key. Isolating the probe by
 * location sidesteps the whole class of cases — the invariant is that whatever the probe candidate
 * touches lives in the scratch directory, which is cleaned up on exit.
 *
 * Every throwable is treated as a failed probe, not only every exception. Reaching an OS store
 * means loading a native library, and a library that is missing or cannot be loaded is reported as
 * an [Error] — on the first call rather than at construction, so it arrives here. An application
 * packaged without the declarations native access needs is the ordinary way to reach that, and the
 * documented consequence is losing the protection rather than failing to start.
 */
private fun osCandidatePassesProbe(osCandidate: (Path) -> KeyCustody?): Boolean {
    val probeDir = runCatching { Files.createTempDirectory("blocks-key-probe") }.getOrNull()
        ?: return false
    return try {
        val probe = runCatching { osCandidate(probeDir) }.getOrNull() ?: return false
        passesSelfTest(probe)
    } finally {
        runCatching { probeDir.toFile().deleteRecursively() }
    }
}

/**
 * Proves a store can hold a key and give it back before a real key is entrusted to it.
 *
 * The probe alias is random because these stores are machine-wide: with a fixed one, two
 * applications starting at the same moment overwrite each other's probe and both conclude the
 * store is broken. The probe is removed whether or not it succeeded, as a courtesy to a custody
 * whose storage outlives the scratch directory (an OS secret store does, a file in that directory
 * does not).
 */
private fun passesSelfTest(candidate: KeyCustody): Boolean {
    val alias = "self-test:" + UUID.randomUUID()
    val probe = ByteArray(AES_KEY_SIZE).also { SecureRandom().nextBytes(it) }
    return try {
        // Both halves are checked. Nothing else can hold a random alias, so a store that honours
        // its contract has to report the probe as the key now held rather than something already
        // there — and reading it back has to produce the same bytes. Checking only what the store
        // returned would pass for one that echoes the key without keeping it; checking only what
        // comes back would leave the documented return value unexamined.
        val held = candidate.storeIfAbsent(alias, probe)
        held.contentEquals(probe) && candidate.load(alias)?.contentEquals(probe) == true
    } catch (_: Throwable) {
        false
    } finally {
        runCatching { candidate.delete(alias) }
    }
}

/**
 * The OS-held custody for this machine, or null where none is implemented yet.
 *
 * Every platform falls through to null for now, so each keeps the behaviour it has today until its
 * binding lands.
 */
private fun osKeyCustody(directory: Path): KeyCustody? = null
