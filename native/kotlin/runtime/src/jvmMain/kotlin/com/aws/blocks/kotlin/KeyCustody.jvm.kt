package com.aws.blocks.kotlin

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
