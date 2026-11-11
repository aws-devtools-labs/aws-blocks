---
"@aws-blocks/core": patch
---

feat: add `escapeRegExp()` and `escapeHtml()` to `@aws-blocks/core/bb-utils`, and escape the working directory on the local settings page

`escapeRegExp(text)` makes any value match literally inside a `RegExp`, so a configured `example.com` no longer also matches `exampleXcom`. `escapeHtml(value)` makes a value safe as HTML text or a quoted attribute value. Use them when a Building Block builds a pattern or markup from configuration or request data.

The `GET /aws-blocks/settings` page that the local dev server serves now escapes the file path it shows, so a project directory whose name contains markup can't inject it into the page.

On Windows, the local settings page now opens `.bb-data/settings.json` with `explorer.exe` instead of `cmd /c start`, so a project directory name containing `&` or `|` can no longer be read by `cmd.exe` as a second command.
