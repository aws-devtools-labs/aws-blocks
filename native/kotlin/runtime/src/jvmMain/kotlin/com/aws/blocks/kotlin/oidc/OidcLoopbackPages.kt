package com.aws.blocks.kotlin.oidc

/**
 * The pages the loopback server serves when an app supplies none of its own.
 *
 * Held as string constants rather than classpath resources: a missing resource would fail at
 * sign-in time on a user's machine, and resource lookup is fragile under jpackage and
 * shrinkers. Everything is inline, so a page renders on a machine whose only route out is to
 * the identity provider.
 */
internal object OidcLoopbackPages {

    fun success(): String = page(
        title = "Signed in",
        glyph = CHECK,
        heading = "Signed in",
        body = "<p>You can close this window and return to the app.</p>",
    )

    fun failure(error: String?, description: String?): String {
        val detail = listOfNotNull(error, description)
            .filter { it.isNotBlank() }
            .joinToString(" — ")
        // The detail comes from the identity provider, so it is escaped and set apart from
        // our own copy rather than run together with it.
        val prefix = if (detail.isEmpty()) "" else "<p class=\"detail\">${escapeHtml(detail)}</p>"
        return page(
            title = "Sign-in failed",
            glyph = ALERT,
            heading = "Sign-in failed",
            body = prefix + "<p>You can close this window and try again in the app.</p>",
        )
    }

    /** [body] is inserted as markup, so every caller escapes its own interpolations. */
    private fun page(title: String, glyph: String, heading: String, body: String): String = """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>$title</title>
        <link rel="icon" href="$FAVICON">
        <style>
        :root { color-scheme: light dark; }
        body {
          margin: 0; min-height: 100vh; display: flex; align-items: center;
          justify-content: center; background: #f5f6f8; color: #1a1d21;
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif;
        }
        .card {
          box-sizing: border-box;
          background: #ffffff; border: 1px solid #e3e5e8; border-radius: 12px;
          padding: 40px 48px; max-width: 26rem; text-align: center;
          box-shadow: 0 1px 3px rgba(0, 0, 0, 0.06);
        }
        h1 { font-size: 1.25rem; font-weight: 600; margin: 20px 0 8px; }
        p { font-size: 0.9375rem; line-height: 1.5; margin: 0; color: #5c6570; }
        .detail {
          font: 0.8125rem/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
          margin: 0 0 12px; padding: 8px 12px; border-radius: 6px;
          background: #f1f2f4; color: #46505a; word-break: break-word;
        }
        svg { width: 48px; height: 48px; }
        @media (prefers-color-scheme: dark) {
          body { background: #16181c; color: #e8eaed; }
          .card { background: #1f2227; border-color: #2e3238; box-shadow: none; }
          p { color: #9aa3ad; }
          .detail { background: #16181c; color: #b6bfc9; }
        }
        </style>
        </head>
        <body>
        <div class="card">
        $glyph
        <h1>$heading</h1>
        $body
        </div>
        </body>
        </html>
    """.trimIndent()

    /**
     * A padlock, percent-encoded rather than base64 so it stays readable here. A favicon
     * renders outside the document and inherits nothing, so the stroke is a literal colour
     * chosen to read against both light and dark tab bars.
     */
    private const val FAVICON = "data:image/svg+xml," +
        "%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 24 24' " +
        "fill='none' stroke='%238b949e' stroke-width='2' stroke-linecap='round'%3E" +
        "%3Crect x='4' y='10' width='16' height='10' rx='2'/%3E" +
        "%3Cpath d='M8 10V7a4 4 0 0 1 8 0v3'/%3E%3C/svg%3E"

    // The namespace colon is a character reference so the literal string "http://" never
    // reaches the page; the browser resolves it to the correct namespace either way.
    private const val SVG_OPEN =
        "<svg xmlns=\"http&#58;//www.w3.org/2000/svg\" viewBox=\"0 0 24 24\" fill=\"none\" " +
            "stroke-width=\"2\" stroke-linecap=\"round\" stroke-linejoin=\"round\" aria-hidden=\"true\""

    private const val CHECK =
        "$SVG_OPEN stroke=\"#1a7f37\"><circle cx=\"12\" cy=\"12\" r=\"10\"/>" +
            "<path d=\"m8 12 3 3 5-6\"/></svg>"

    private const val ALERT =
        "$SVG_OPEN stroke=\"#9a6700\"><circle cx=\"12\" cy=\"12\" r=\"10\"/>" +
            "<path d=\"M12 8v4\"/><path d=\"M12 16h.01\"/></svg>"
}

/** Escapes text for insertion into HTML character data or a quoted attribute value. */
internal fun escapeHtml(value: String): String = buildString(value.length) {
    for (char in value) {
        when (char) {
            '&' -> append("&amp;")
            '<' -> append("&lt;")
            '>' -> append("&gt;")
            '"' -> append("&quot;")
            '\'' -> append("&#39;")
            else -> append(char)
        }
    }
}
