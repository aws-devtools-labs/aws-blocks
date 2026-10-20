package com.aws.blocks.kotlin.oidc

import java.awt.Desktop
import java.net.URI

/** Opens a URL in whatever browser the host provides. */
internal fun interface BrowserOpener {
    fun open(url: String)
}

/** Returns the shell command that opens [url] on the platform named by [osName]. */
internal fun browserCommand(osName: String, url: String): List<String> {
    val os = osName.lowercase()
    return when {
        os.contains("mac") -> listOf("open", url)
        os.contains("win") -> listOf("rundll32", "url.dll,FileProtocolHandler", url)
        else -> listOf("xdg-open", url)
    }
}

/**
 * Opens the URL through AWT when the host supports it, otherwise through the platform's
 * URL-handling command.
 */
internal object SystemBrowserOpener : BrowserOpener {
    override fun open(url: String) {
        if (openWithDesktop(url)) return
        if (openWithCommand(url)) return
        error("Could not open a browser to complete sign-in. Open this URL manually:\n$url")
    }

    private fun openWithDesktop(url: String): Boolean = try {
        if (!Desktop.isDesktopSupported()) {
            false
        } else {
            val desktop = Desktop.getDesktop()
            if (!desktop.isSupported(Desktop.Action.BROWSE)) {
                false
            } else {
                desktop.browse(URI(url))
                true
            }
        }
    } catch (_: Exception) {
        false
    }

    private fun openWithCommand(url: String): Boolean = try {
        ProcessBuilder(browserCommand(System.getProperty("os.name").orEmpty(), url)).start()
        true
    } catch (_: Exception) {
        false
    }
}
