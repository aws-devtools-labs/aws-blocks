# Task: Passwordless Email-OTP Profile

Build a passwordless sign-in flow in this AWS Blocks app. A visitor enters their email, receives a one-time code, enters the code, and lands on a profile page that shows who they're signed in as. They can sign out.

The sign-in flow is an intrinsically multi-view browser experience, but the signed-in **identity** is a framework surface: an **`api` namespace** method reads the current user from the **auth session** on the server. The page reflects that identity.

## Setup (do this first)

The workspace has already been scaffolded. Begin by reading README.md (and any AGENTS.md), then do all your edits in this workspace.

## Requirements

1. A signed-out visitor sees an **email field** and a **submit button**. Submitting begins a passwordless sign-up / sign-in for that email and sends a one-time verification code. If that email **already has an account** (e.g., a returning visitor who previously signed out), detect it and run the **sign-in** code path instead of failing with a "user already exists" error — the same email must be able to authenticate again and land on its profile. An **empty or whitespace-only** email is invalid: validate/trim before submitting and do **not** begin auth or advance to the code view for it — stay on the email form (no code is sent, no unhandled error).
2. The view then shows a **code field** and its own **submit button**. Submitting the code completes authentication and establishes a session.
3. Once authenticated, the visitor sees a **profile** view that renders the signed-in user's identity (their email / username) — and the email/code fields are gone.
4. The profile view has a **sign-out** button that returns the visitor to the signed-out email form.
5. **Reject bad codes.** If the submitted code is wrong **or blank/empty**, catch the error and stay on the code-entry view — do **not** establish a session or throw an unhandled error. When a code is actually rejected, show a message in `[data-testid=auth-error]`; that hook must be **absent until a code is rejected**. A wrong code does **not** end the attempt: the verification session stays valid (retriable), so the visitor can immediately re-enter the **correct** code and sign in — and once they do, the error must be **cleared** (`auth-error` removed again).
6. **Session persistence.** The session lives in a cookie: on a full page reload the visitor stays signed in and the profile re-renders their identity (restore it on load).
7. **Clean sign-out.** Signing out fully clears the session so a *different* email can sign in afterward and the profile shows the new identity (no stale cached user). A full page reload **after** signing out must **not** restore the session — it stays on the signed-out email form.

This is email-OTP / passwordless: the visitor never types a password.

## The `api` namespace (required)

Expose an **`api` namespace** (the framework's server-side RPC surface — `POST /aws-blocks/api`) with:

1. **`api.getLastCode()`** — test harness hook (the grader has no mailbox): returns the most recently delivered code as `{ username, code }` (or `null`). Retrieved via:
   ```
   POST /aws-blocks/api
   { "jsonrpc": "2.0", "method": "api.getLastCode", "params": [], "id": 1 }
   ```
2. **`api.whoami()`** — returns the **currently signed-in** user's identity as `{ username }` (their email), derived on the server from the **auth session cookie** — not from a client-supplied argument. Called with **no session** (a request carrying no sign-in cookie), it returns a JSON-RPC **error** envelope (unauthenticated) — never a `result` and never a stale/other identity. After sign-out the session is gone, so `whoami` is again unauthenticated.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly. The signed-out, code-entry, and signed-in views are told apart by which hooks are present. An inactive view's hooks must be **removed** from the DOM (not merely hidden with CSS).

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=auth-email]` | `<input type="email">` | The email to sign up / sign in with; shown when signed out |
| `[data-testid=auth-submit]` | `<button>` | Begin auth and send the one-time code |
| `[data-testid=otp-input]` | `<input>` | Where the visitor types the emailed code |
| `[data-testid=otp-submit]` | `<button>` | Submit the code to complete authentication |
| `[data-testid=profile-username]` | element in the signed-in view | Renders the signed-in user's email / username |
| `[data-testid=signout-btn]` | `<button>` | Sign out; shown only when signed in |
| `[data-testid=auth-error]` | element shown in the code-entry view | Renders an error message when the submitted code is rejected (absent until a code is rejected) |

After the code is confirmed, `[data-testid=profile-username]` must contain the signed-in user's identity (the email address that signed in).

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Passwords, password reset, MFA beyond the email OTP, social / federated login
- Groups / roles, custom attributes, device tracking (you may remove any UI not required by this task)
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
