# Task: Passwordless Email-OTP Profile

Build a passwordless sign-in flow in this AWS Blocks app. A visitor enters their email, receives a one-time code, enters the code, and lands on a profile page that shows who they're signed in as. They can sign out.

## Setup (do this first)

The workspace has already been scaffolded and the dev server is running; its port is in `/tmp/dev.port`. Begin by reading README.md, then do all your edits in this workspace.

## Requirements

1. A signed-out visitor sees an **email field** and a **submit button**. Submitting begins a passwordless sign-up / sign-in for that email and sends a one-time verification code.
2. The view then shows a **code field** and its own **submit button**. Submitting the code completes authentication and establishes a session.
3. Once authenticated, the visitor sees a **profile** view that renders the signed-in user's identity (their email / username) — and the email/code fields are gone.
4. The profile view has a **sign-out** button that returns the visitor to the signed-out email form.

This is email-OTP / passwordless: the visitor never types a password. One identifier (the email) on the way in, then the emailed code.

## Where to look

The project is built on AWS Blocks. The `aws-blocks/` directory is your wiring point — backend handlers and CDK constructs live there. Under `node_modules/@aws-blocks/`, each package has a `README.md` and an `API.md`. Read the relevant ones before wiring.

This template already ships a Cognito-backed auth block configured for **passwordless email-OTP** (`USER_AUTH` + `EMAIL_OTP`, `signInWith: 'email'`, self sign-up enabled). It also wires a `codeDelivery` hook that captures the OTP locally (no real mailbox) and exposes it through a `getLastCode()` API method. Read the template's `aws-blocks/index.ts`, its README, and `node_modules/@aws-blocks/bb-auth-cognito/README.md` to see the exact sign-up → confirm → session flow (sign-up confirmation auto-bridges into a signed-in session, so a single emailed code is enough).

You own the page UI: replace the template's `<Authenticator>`-based demo with a custom two-step form that uses the selector contract below. Drive it through the auth block (its sign-up / confirm / sign-in methods, or the state-machine API the block exposes) — whatever wiring lands a session and lets you read back the current user.

The dev server is already running on the port in `/tmp/dev.port`. Edits to `aws-blocks/` reload the backend; edits under `src/` hot-reload the frontend. Use the running app to verify your work.

## Test harness contract (required)

The grader has no mailbox, so it reads the OTP the same way the template's UI does — over JSON-RPC. **Keep an `api` namespace that exposes `getLastCode()`**, wired from the `codeDelivery` hook, returning the most recently delivered code as `{ username, code }` (or `null`). The grader retrieves it by POSTing to `/aws-blocks/api`:

```
POST /aws-blocks/api
Content-Type: application/json
{ "jsonrpc": "2.0", "method": "api.getLastCode", "params": [], "id": 1 }
```

The template already implements this method — the simplest path is to keep it.

## Selector contract

The Playwright test grades your work using these `data-testid` hooks. Implement them exactly. The signed-out, code-entry, and signed-in views are told apart by which hooks are present.

An inactive view's hooks must be REMOVED from the DOM (the grader asserts `toHaveCount(0)`); hiding them with CSS (`display:none` / `hidden`) will fail.

| Selector | Element | Purpose |
|---|---|---|
| `[data-testid=auth-email]` | `<input type="email">` | The email to sign up / sign in with; shown when signed out |
| `[data-testid=auth-submit]` | `<button>` | Begin auth and send the one-time code |
| `[data-testid=otp-input]` | `<input>` | Where the visitor types the emailed code |
| `[data-testid=otp-submit]` | `<button>` | Submit the code to complete authentication |
| `[data-testid=profile-username]` | element in the signed-in view | Renders the signed-in user's email / username |
| `[data-testid=signout-btn]` | `<button>` | Sign out; shown only when signed in |

After the code is confirmed, `[data-testid=profile-username]` must contain the signed-in user's identity (the email address that signed in).

The mount point for your page is the existing root element. You can replace whatever placeholder content the template ships with.

## Out of scope

- Passwords, password reset, MFA beyond the email OTP, social / federated login
- Groups / roles, custom attributes, device tracking (the template demos these — you can delete that UI)
- Styling beyond what makes the test pass

## Done means

- All Playwright assertions pass against the running dev server.
- No errors in the browser console under normal use.
- Your changes stay inside the workspace root. Don't modify anything under `node_modules/`.
