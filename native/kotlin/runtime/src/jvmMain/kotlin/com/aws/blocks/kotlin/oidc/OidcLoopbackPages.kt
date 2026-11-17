package com.aws.blocks.kotlin.oidc

import io.ktor.util.escapeHTML

/**
 * The pages the loopback server serves when an app supplies none of its own.
 *
 * Held as string constants rather than classpath resources: a missing resource would fail at
 * sign-in time on a user's machine, and resource lookup is fragile under jpackage and
 * shrinkers. Everything is inline, so a page renders on a machine whose only route out is to
 * the identity provider.
 */
internal object OidcLoopbackPages {

    private const val CHECK_PATHS =
        "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"m8 12 3 3 5-6\"/>"

    private const val ALERT_PATHS =
        "<circle cx=\"12\" cy=\"12\" r=\"10\"/><path d=\"M12 8v4\"/><path d=\"M12 16h.01\"/>"

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
        val prefix = if (detail.isEmpty()) "" else "<p class=\"detail\">${detail.escapeHTML()}</p>"
        return page(
            title = "Sign-in failed",
            glyph = ALERT,
            heading = "Sign-in failed",
            body = prefix + "<p>You can close this window and try again in the app.</p>",
        )
    }

    /** [body] is inserted as markup, so every caller escapes its own interpolations. */
    private fun page(title: String, glyph: Glyph, heading: String, body: String): String = """
        <!DOCTYPE html>
        <html lang="en">
        <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>$title</title>
        <link rel="icon" href="${glyph.favicon}">
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
        ${glyph.inline}
        <h1>$heading</h1>
        $body
        </div>
        </body>
        </html>
    """.trimIndent()

    /**
     * The in-page SVG and the tab icon for one page, paired so the two cannot drift apart.
     *
     * A favicon renders outside the document and inherits nothing, so [favicon] carries a
     * literal colour. It is a brighter variant of the in-page stroke: the in-page colour is
     * tuned for a white or near-black card, while the tab icon has to stay legible against
     * both a light and a dark tab bar. [favicon] is percent-encoded rather than base64 so it
     * stays readable here, and uses a heavier stroke because it renders at about 16px.
     */
    private class Glyph(val inline: String, val favicon: String)

    private val CHECK = Glyph(
        inline = svg(stroke = "#1a7f37", paths = CHECK_PATHS),
        favicon = favicon(stroke = "2da44e", paths = CHECK_PATHS),
    )

    private val ALERT = Glyph(
        inline = svg(stroke = "#9a6700", paths = ALERT_PATHS),
        favicon = favicon(stroke = "bf8700", paths = ALERT_PATHS),
    )

    private fun svg(stroke: String, paths: String): String =
        // No xmlns: the HTML parser already puts an inline <svg> in the SVG namespace. The
        // favicon data URI is a standalone document and does need one.
        "<svg viewBox=\"0 0 24 24\" fill=\"none\" " +
            "stroke=\"$stroke\" stroke-width=\"2\" stroke-linecap=\"round\" " +
            "stroke-linejoin=\"round\" aria-hidden=\"true\">" + paths + "</svg>"

    private fun favicon(stroke: String, paths: String): String =
        "data:image/svg+xml," +
            "%3Csvg xmlns='http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg' viewBox='0 0 24 24' " +
            "fill='none' stroke='%23$stroke' stroke-width='2.5' stroke-linecap='round' " +
            "stroke-linejoin='round'%3E" +
            paths.replace("<", "%3C").replace(">", "%3E").replace("\"", "'") +
            "%3C/svg%3E"

}
