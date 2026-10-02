package com.aws.blocks.kotlin.oidc

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
     */
    data class Html(val document: String) : OidcLandingPage {
        init {
            require(document.isNotBlank()) {
                "OidcLandingPage.Html document must not be blank"
            }
        }
    }
}

// URI.getHost keeps the brackets on an IPv6 literal.
private val LOOPBACK_HOSTS = setOf("localhost", "127.0.0.1", "[::1]")

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
    require(!host.isNullOrEmpty()) { "OidcLandingPage.Redirect url has no host: \"$url\"" }
    require(scheme == "https" || host in LOOPBACK_HOSTS) {
        "OidcLandingPage.Redirect url uses http with a non-loopback host: \"$url\". Use " +
            "https, or a loopback host such as \"http://localhost:3000\" for development."
    }
}
