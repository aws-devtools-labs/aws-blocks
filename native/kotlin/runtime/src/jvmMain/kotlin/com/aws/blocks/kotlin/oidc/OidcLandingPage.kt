package com.aws.blocks.kotlin.oidc

import java.net.InetAddress
import java.net.URI
import java.net.URISyntaxException

/**
 * What the browser shows once a sign-in attempt finishes.
 *
 * The system browser is left open on the loopback address the relay redirected to, so
 * something has to be served there.
 */
sealed interface OidcLandingPage {

    /** Serve the runtime's own styled page. */
    data object BuiltIn : OidcLandingPage

    /**
     * Send the browser to [url] once the authorization code is captured.
     *
     * The user finishes on a real domain rather than a loopback address. On success the
     * callback query is dropped, so the authorization code never reaches [url]. On failure
     * `error` and `error_description` are appended.
     */
    data class Redirect(val url: String) : OidcLandingPage {
        init {
            validateRedirectUrl(url)
        }
    }

    /**
     * Serve [document] verbatim, for an app with no web property to host a page on, or one
     * that wants to render its own localized copy.
     *
     * Nothing is substituted into it, so a failure page built this way cannot show the
     * identity provider's `error_description`; use [Redirect] when that detail is wanted.
     * The document is not validated or rewritten, so anything it fetches from the network
     * may fail on a machine that can only reach the identity provider.
     *
     * It is served as the response to the callback itself, so the callback query stays in the
     * address bar while the page is open and the markup can read the authorization code.
     * [Redirect] sends the browser to a clean URL instead.
     */
    data class Html(val document: String) : OidcLandingPage {
        init {
            require(document.isNotBlank()) {
                "OidcLandingPage.Html document must not be blank"
            }
        }
    }
}

private const val MAX_PORT = 65535

/** An IPv4 or bracketed IPv6 literal, which can be resolved without touching DNS. */
private val IP_LITERAL = Regex("""^\[[0-9A-Fa-f:.]+]$|^[0-9.]+$""")

private fun validateRedirectUrl(url: String) {
    // Checked before parsing, because a stray space is a likely typo and deserves a better
    // message than the parser's "Illegal character at index n".
    require(url.isNotBlank()) { "OidcLandingPage.Redirect url must not be blank" }
    require(url.none { it.isWhitespace() }) {
        "OidcLandingPage.Redirect url must not contain whitespace: \"$url\""
    }

    val uri = try {
        URI(url)
    } catch (cause: URISyntaxException) {
        throw IllegalArgumentException(
            "OidcLandingPage.Redirect url is not a valid URL: \"$url\" (${cause.reason})",
            cause,
        )
    }

    // URI resolves userinfo and the IPv6 brackets itself, so `host` is the real host and not
    // whatever precedes an `@`.
    val scheme = uri.scheme?.lowercase()
    require(scheme != null) {
        "OidcLandingPage.Redirect url is missing a scheme: \"$url\". Expected something " +
            "like \"https://app.example.com/signed-in\"."
    }
    require(scheme == "http" || scheme == "https") {
        "OidcLandingPage.Redirect url uses the \"$scheme\" scheme: \"$url\". Only http and " +
            "https can be served in a Location header."
    }

    val host = uri.host?.lowercase()
    require(!host.isNullOrEmpty()) {
        if (uri.authority.isNullOrEmpty()) {
            "OidcLandingPage.Redirect url has no host: \"$url\""
        } else {
            // URI rejects hostnames that are not strictly legal, such as one containing an
            // underscore or a non-ASCII character.
            "OidcLandingPage.Redirect url has an unusable host: \"${uri.authority}\". An " +
                "internationalised domain has to be given in its punycode form (\"xn--…\")."
        }
    }

    // URI parses the port as digits without range-checking it, and a URL carrying an
    // out-of-range port cannot be followed or appended to later.
    require(uri.port in -1..MAX_PORT) {
        "OidcLandingPage.Redirect url has an out-of-range port: ${uri.port} in \"$url\""
    }

    require(scheme == "https" || isLoopback(host)) {
        "OidcLandingPage.Redirect url uses http with a non-loopback host: \"$url\". Use " +
            "https, or a loopback host such as \"http://localhost:3000\" for development."
    }
}

/**
 * Whether [host] names this machine, covering every spelling of a loopback address rather
 * than only `127.0.0.1` and `[::1]`.
 *
 * Only literals are resolved, so this never performs a DNS lookup.
 */
private fun isLoopback(host: String): Boolean {
    if (host == "localhost") return true
    if (!IP_LITERAL.matches(host)) return false
    return runCatching {
        InetAddress.getByName(host.removeSurrounding("[", "]")).isLoopbackAddress
    }.getOrDefault(false)
}
