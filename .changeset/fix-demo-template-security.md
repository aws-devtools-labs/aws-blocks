---
"@aws-blocks/create-blocks-app": patch
---

Fix two security defects in the `demo` template:

- **Set-Cookie header (CRLF) injection**: the public `setCookie` / `deleteCookie` API methods wrote a user-controlled cookie name/value directly into the `Set-Cookie` response header. Cookie name/value components containing CR (`\r`) or LF (`\n`) are now rejected, preventing HTTP response-header injection / response splitting.
- **Incomplete HTML escaping (XSS)**: the frontend `escapeHtml` helper escaped `&`, `<`, `>`, and `"` but not the single quote (`'`), leaving an XSS gap when interpolating user-controlled values into single-quoted JS/HTML attribute contexts (e.g. `onchange="toggleTodo('...')"`). Single quotes are now escaped to `&#39;`.
