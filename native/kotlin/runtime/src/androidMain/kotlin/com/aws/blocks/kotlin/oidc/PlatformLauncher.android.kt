package com.aws.blocks.kotlin.oidc

import android.content.Intent
import com.aws.blocks.kotlin.ContextProvider
import kotlinx.coroutines.CompletableDeferred

internal actual fun createPlatformLauncher(): OidcPlatformLauncher = AndroidOidcLauncher()

internal object PendingOidcResult {
    private var deferred: CompletableDeferred<String>? = null

    val isActive: Boolean get() = deferred != null

    fun create(): CompletableDeferred<String> {
        deferred?.cancel()
        return CompletableDeferred<String>().also { deferred = it }
    }

    fun complete(uri: String) {
        deferred?.complete(uri)
        deferred = null
    }

    fun cancel() {
        deferred?.completeExceptionally(OidcCancelledException())
        deferred = null
    }
}

private class AndroidOidcLauncher : OidcPlatformLauncher {
    override suspend fun openSession(configuredRelayTo: String): OidcRedirectSession =
        AndroidRedirectSession(configuredRelayTo)
}

private class AndroidRedirectSession(override val relayTo: String) : OidcRedirectSession {
    override suspend fun awaitRedirect(authorizeUrl: String): String {
        val activity = ContextProvider.activity
            ?: error("No active Activity. Ensure signIn() is called while an Activity is resumed.")
        val deferred = PendingOidcResult.create()
        val intent = Intent(activity, OidcRedirectActivity::class.java).apply {
            putExtra(OidcRedirectActivity.EXTRA_AUTHORIZE_URL, authorizeUrl)
        }
        activity.startActivity(intent)
        return deferred.await()
    }

    override fun close() {
        if (PendingOidcResult.isActive) PendingOidcResult.cancel()
    }
}
