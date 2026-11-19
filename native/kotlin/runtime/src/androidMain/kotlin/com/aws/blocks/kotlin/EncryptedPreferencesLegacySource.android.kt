// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

@file:Suppress("DEPRECATION")

package com.aws.blocks.kotlin

import android.content.Context
import android.os.Build
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.io.File
import java.security.KeyStore

/**
 * The `EncryptedSharedPreferences` file named [name], left by an earlier version of the library.
 * Its `MasterKey` alias is shared by every such file in the application, so only the file is ever
 * deleted, never the alias. The deprecated library is read here only; it and this file's
 * suppression go once the migration has shipped in a release and a device run has covered the
 * paths no host test reaches, since nothing can catch a fault in this read once it is deleted.
 */
internal class EncryptedPreferencesLegacySource(private val name: String) : LegacySource {

    private val context: Context get() = ContextProvider.applicationContext

    /**
     * `Context.getSharedPreferencesPath` is `@hide`, so this mirrors the location it derives. A
     * platform that moved `shared_prefs` would make [exists] false and skip the migration, which
     * costs one sign-in, never a crash.
     */
    private fun file(): File = legacyPrefsPath(context.applicationInfo.dataDir, name)

    private fun backupFile(): File = legacyBackupPath(file())

    override fun exists(): Boolean = file().exists()

    override fun stamp(): String = file().let { "${it.lastModified()}:${it.length()}" }

    override fun readAll(): Map<String, String> = try {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        // Checked before the builder runs so a read does not mint the alias:
        // `MasterKey.Builder.build()` creates the key when it is missing.
        if (!keyStore.containsAlias(MasterKey.DEFAULT_MASTER_KEY_ALIAS)) throw LegacyKeyLostException()
        val masterKey = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        val prefs = EncryptedSharedPreferences.create(
            context,
            name,
            masterKey,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
        prefs.all.mapNotNull { (key, value) -> (value as? String)?.let { key to it } }.toMap()
    } catch (lost: LegacyKeyLostException) {
        throw lost
    } catch (failure: Exception) {
        // Every key store call above can fault, the builder included, so all of them are classified
        // here. A fault the key store owns is a read failure; anything else, a file that will not
        // open or an entry that will not decrypt, means the keysets are gone. Below 33 nothing
        // classifies as the key store's own, so this drops the legacy session, unlike load():
        // leaving the file would otherwise fail every later access, writes included.
        if (failure.isKeystoreOwnFault()) throw failure
        throw LegacyKeyLostException(failure)
    }

    /**
     * Deletes the file rather than clearing it: the old API's `clear()` keeps its keysets, so the
     * file would stay behind. Throws when the file is still present afterwards, because a file left
     * behind is copied over the store again on the next access.
     */
    override fun delete() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N) {
            val deleted = context.deleteSharedPreferences(name)
            check(deleted || !file().exists()) { "The platform did not delete the file for '$name'" }
        } else {
            // `deleteSharedPreferences` needs API 24; this branch serves minSdk 23 and mirrors what
            // it does, the backup file included: `SharedPreferencesImpl` renames a surviving backup
            // back over the file on its next load, which would bring the entries back.
            val cleared = context.getSharedPreferences(name, Context.MODE_PRIVATE).edit().clear().commit()
            val deleted = file().delete()
            val backupDeleted = backupFile().delete()
            check(!file().exists() && !backupFile().exists()) {
                "The file for '$name' is still present " +
                    "(cleared $cleared, deleted $deleted, backup deleted $backupDeleted)"
            }
        }
    }
}
