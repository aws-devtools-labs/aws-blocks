@file:OptIn(ExperimentalForeignApi::class, InternalBlocksApi::class)

package com.aws.blocks.kotlin.oidc

import com.aws.blocks.kotlin.InternalBlocksApi
import kotlinx.cinterop.ExperimentalForeignApi
import kotlinx.coroutines.suspendCancellableCoroutine
import platform.AuthenticationServices.ASPresentationAnchor
import platform.AuthenticationServices.ASWebAuthenticationPresentationContextProvidingProtocol
import platform.AuthenticationServices.ASWebAuthenticationSession
import platform.AuthenticationServices.ASWebAuthenticationSessionErrorCodeCanceledLogin
import platform.AuthenticationServices.ASWebAuthenticationSessionErrorDomain
import platform.Foundation.NSError
import platform.Foundation.NSURL
import platform.UIKit.UIApplication
import platform.UIKit.UIWindow
import platform.UIKit.UIWindowScene
import platform.darwin.NSObject
import platform.darwin.dispatch_async
import platform.darwin.dispatch_get_main_queue
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

internal actual fun createPlatformLauncher(): OidcPlatformLauncher = IosOidcLauncher()

internal class IosOidcLauncher : OidcPlatformLauncher {
    override suspend fun openSession(configuredRelayTo: String): OidcRedirectSession {
        if (configuredRelayTo.isEmpty()) {
            error(
                "OIDC is not configured. Add oidc { relayTo = \"...\" } to your awsBlocks block " +
                    "to enable this method.",
            )
        }
        val scheme = configuredRelayTo.substringBefore("://")
        if (scheme.isEmpty() || scheme == configuredRelayTo) {
            error(
                "Invalid OIDC relayTo \"$configuredRelayTo\": expected a custom-scheme URI such " +
                    "as \"com.yourcompany.yourapp://auth/callback\".",
            )
        }
        if (scheme.equals("http", ignoreCase = true) || scheme.equals("https", ignoreCase = true)) {
            error(
                "OIDC relayTo \"$configuredRelayTo\" uses the $scheme scheme. iOS sign-in needs a " +
                    "custom scheme registered under CFBundleURLTypes in the app's Info.plist.",
            )
        }
        return IosRedirectSession(configuredRelayTo, scheme)
    }
}

private class IosRedirectSession(
    override val relayTo: String,
    private val callbackScheme: String,
) : OidcRedirectSession {

    private val anchorProvider = KeyWindowAnchorProvider()
    private var session: ASWebAuthenticationSession? = null

    override suspend fun awaitRedirect(authorizeUrl: String): String =
        suspendCancellableCoroutine { continuation ->
            val url = NSURL.URLWithString(authorizeUrl)
            if (url == null) {
                continuation.resumeWithException(
                    OidcCallbackException("Authorize URL is not a valid URL: $authorizeUrl"),
                )
                return@suspendCancellableCoroutine
            }

            val webSession = ASWebAuthenticationSession(
                uRL = url,
                callbackURLScheme = callbackScheme,
            ) { callbackUrl, error ->
                when {
                    callbackUrl != null -> continuation.resume(callbackUrl.absoluteString ?: "")
                    isUserCancellation(error) -> continuation.resumeWithException(
                        OidcCancelledException(),
                    )
                    else -> continuation.resumeWithException(
                        OidcCallbackException(
                            error?.localizedDescription ?: "Sign-in failed with no error detail",
                        ),
                    )
                }
            }

            // Left at the default so sign-in reuses existing provider cookies.
            webSession.prefersEphemeralWebBrowserSession = false
            webSession.presentationContextProvider = anchorProvider
            session = webSession

            continuation.invokeOnCancellation {
                dispatch_async(dispatch_get_main_queue()) { webSession.cancel() }
            }

            // The system requires the session to be started from the main thread.
            dispatch_async(dispatch_get_main_queue()) {
                if (!webSession.start()) {
                    continuation.resumeWithException(
                        OidcCallbackException("The system declined to start the sign-in session."),
                    )
                }
            }
        }

    override fun close() {
        val webSession = session ?: return
        session = null
        dispatch_async(dispatch_get_main_queue()) { webSession.cancel() }
    }
}

private fun isUserCancellation(error: NSError?): Boolean =
    error != null &&
        error.domain == ASWebAuthenticationSessionErrorDomain &&
        error.code == ASWebAuthenticationSessionErrorCodeCanceledLogin

/**
 * Supplies the window the system presents the sign-in sheet over.
 */
private class KeyWindowAnchorProvider :
    NSObject(),
    ASWebAuthenticationPresentationContextProvidingProtocol {
    override fun presentationAnchorForWebAuthenticationSession(
        session: ASWebAuthenticationSession,
    ): ASPresentationAnchor = keyWindow()
        ?: error("No key UIWindow is available to present the OIDC sign-in session.")
}

private fun keyWindow(): UIWindow? =
    UIApplication.sharedApplication.connectedScenes
        .filterIsInstance<UIWindowScene>()
        .flatMap { scene -> scene.windows.filterIsInstance<UIWindow>() }
        .firstOrNull { window -> window.keyWindow }
