# Customizing Auth UI

The `Authenticator` covers the common cases as-is. When you need to restyle it,
hide parts of it, or replace it entirely, this guide covers the three depths of
customization and the one rule that holds at every depth.

For the basics (`Authenticator`, `AccountMenuBar`, `AuthenticatedContent`,
`onAuthChange`, `broadcastAuthChange`, and the type reference), see the
[README](./README.md). This guide assumes you've read it.

If you're here to write e2e tests rather than restyle anything, skip to
[Test hooks](#test-hooks) — the built-in components ship a stable `data-testid`
contract, so you don't need to fork them to get selectors.

## The one rule

Auth is a server-driven state machine. The server returns an `AuthState` that
lists the `actions` available right now; the client renders those actions and
submits one back with `setAuthState({ action, ...fields })`, which returns the
next `AuthState`. The loop repeats until `state === 'signedIn'`.

Every customization path below still goes through that same
`setAuthState({ action, ...fields })` call. You can change what the form looks
like, reorder or hide fields, or swap in your own DOM. But the action name and
field values you submit are the contract the server validates. Skip the loop and
you skip the server's flow logic (challenges, retries, the sign-up to sign-in
bridge), and you have to rebuild it yourself.

So the question for any customization is "how far down do I need to go?" Three
answers, in order of how much you take on:

| Depth | Use when | You write | You keep |
|---|---|---|---|
| Overrides | Restyle/relabel/hide, same flow | An `AuthenticatorOptions` object | All built-in flow handling |
| Slot replacement | Custom markup, same flow | A `render` function per action | The `submit()` plumbing |
| Fully custom | Your own component, no `Authenticator` | The whole render + submit loop | Nothing; you drive it |

### Which depth do I need?

- **Just relabeling fields or hiding sign-up?** → Depth 1
- **Need custom markup but the same flow?** → Depth 2
- **Building a framework component?** → Depth 2 (with `render`) or Depth 3 (full control)
- **Replacing the `Authenticator` entirely?** → Depth 3

The table above covers what each depth gives you; this covers which one to reach for based on your goal.

## Depth 1: Overrides

Pass an `AuthenticatorOptions` as the second argument. The state machine runs
unchanged. You're only adjusting how each action renders.

```typescript
import { Authenticator } from '@aws-blocks/auth-common/ui';
import { authApi } from 'aws-blocks';

document.body.appendChild(Authenticator(authApi, {
  // Drop whole actions. Invite-only? Hide signUp. Names match AuthAction.name.
  // The server may still emit them; they just don't render.
  hideActions: ['signUp'],

  // Heading per state (keyed by AuthState.state).
  headings: { signedOut: 'Sign in to continue' },

  // Per-action overrides, keyed by action name.
  actions: {
    signIn: {
      heading: 'Welcome back',        // wins over headings[state]
      submitLabel: 'Continue',
      fields: {
        username: { label: 'Email', type: 'email', autocomplete: 'email' },
        password: { hint: 'Forgot it? Use the reset link below.' },
      },
    },
  },
}));
```

Field overrides cover `label`, `placeholder`, `hint`, `order`, `type`,
`autocomplete`, `hidden`, and a per-field `render` (Depth 2). See
`AuthenticatorOptions` in the source for the full set; the JSDoc on each field
is the reference.

### `hidden` does not drop the value

Hiding a field removes the visible input, but if the server attached a
`defaultValue`, the value still submits as a hidden input. This is deliberate.
Flows like `confirmSignUp` carry the username as a hidden field with a
`defaultValue`, and the server needs it back on submit, so hiding it visually
must not break the submit. The same applies to fields the server marks
`type: 'hidden'` (session tokens, challenge markers). Those always render as
hidden inputs regardless of overrides.

## Depth 2: Slot replacement

When relabeling isn't enough, replace an action's markup with `render`. You
return the DOM; the `Authenticator` hands you a `submit(values)` helper so you
don't reimplement the `setAuthState` call, the cache update, or the cross-tab
broadcast.

```typescript
Authenticator(authApi, {
  actions: {
    signIn: {
      render: (action, { submit }) => {
        const form = document.createElement('form');
        form.addEventListener('submit', (e) => {
          e.preventDefault();
          const data = new FormData(form);
          // Keys must match the field names the server declared in
          // action.fields. That's the submit contract.
          void submit({
            username: String(data.get('username') ?? ''),
            password: String(data.get('password') ?? ''),
          });
        });
        form.innerHTML = `
          <input name="username" placeholder="Email">
          <input name="password" type="password" placeholder="Password">
          <button type="submit">${action.label}</button>`;
        return form;
      },
    },
  },
});
```

You can also replace a single field's input (`fields.<name>.render`) instead of
the whole action. Either way, your DOM must contain an `<input name="...">` for
every field value you want submitted. The renderer reads values off the input
`name`, so a missing `name` means a missing field.

## Depth 3: Fully custom UI (no Authenticator)

Drive the state machine yourself when you want a component that owns its own
rendering. You call `getAuthState()` once, render, and call `setAuthState()` on
submit. The state API is on the object your backend returns from
`auth.createApi()`.

```typescript
import { broadcastAuthChange } from '@aws-blocks/auth-common/ui';
import type { AuthActionInput } from '@aws-blocks/auth-common';
import { authApi } from 'aws-blocks';

async function renderAuth(root: HTMLElement) {
  let state = await authApi.getAuthState();

  if (state.state === 'signedIn') {
    root.textContent = `Signed in as ${state.user!.username}`;
    return;
  }

  // Render an action. `action` and its fields come from the server, so
  // don't hard-code field names; read them from action.fields.
  const action = state.actions[0];
  // ... build inputs from action.fields, collect values on submit ...

  const next = await authApi.setAuthState({
    action: action.name,
    username: 'alice',
    password: 'secret',
  } as AuthActionInput);

  // Tell the rest of the app (AccountMenuBar, AuthenticatedContent,
  // other tabs) that auth changed. The Authenticator does this for you;
  // here it's your responsibility.
  if (next.state === 'signedIn') broadcastAuthChange(next.user ?? null);
}
```

### The `AuthActionInput` contract

`setAuthState` takes a single discriminated object: `action` selects the
variant, the remaining keys are that action's fields. Because the variants are
typed (`AuthActionInput` in `@aws-blocks/auth-common`), passing the wrong fields
for an action is a compile error. Submit `{ action: 'signIn', username, password }`
and TypeScript checks the shape. The `<Authenticator>` widens to this type at
one boundary because it builds payloads from runtime `action.fields`; a
hand-written caller that knows its action name gets full narrowing.

### What you give up

Going fully custom means re-handling things the `Authenticator` does for free.
Based on the current implementation, that includes:

- **`retriable` errors.** When `setAuthState` returns a state with
  `retriable: true`, the session is still usable (wrong MFA code, rejected
  input), so re-prompt on the same screen rather than restarting. The
  `Authenticator` keeps the current form (and its hidden session token) on
  screen; you'd do that yourself.
- **WebAuthn/passkey ceremonies.** Actions carry a `capability` of
  `'webauthn-get'` or `'webauthn-create'`. The `Authenticator` runs
  `navigator.credentials.get/create(...)` against the options the server put in
  a hidden field and writes the result back before submitting. A bare form has
  to run that ceremony itself.
- **Auto-chaining.** The sign-up to confirm to auto-sign-in bridge fires
  automatically when the server returns a state whose only action is
  `autoSignIn`. Drive it manually if you skip the `Authenticator`.

If you need any of these, prefer Depth 1 or 2. You stay on the built-in
handling and still get your custom look.

## Test hooks

Every interactive element the built-in auth components render carries a stable
`data-testid`, so e2e suites can drive the shipped UI instead of forking it for
selectors. Treat the names as public API: renaming one is a breaking change.

Inputs, buttons, and the containers you assert against are hooked. Purely
presentational markup is not, on purpose: hint text from `fields.<name>.hint`,
the bordered panel inside the `authenticator` container, the `AccountMenuBar`
layout row, and the modal's inner content box carry no `data-testid`. Hooking
those would pin our styling structure into your tests, so read the text off the
nearest hooked ancestor instead.

| Hook | Element |
|---|---|
| `authenticator` | Root element returned by `Authenticator` |
| `authenticator-heading` | Heading above the actions |
| `authenticator-signed-in` | Heading rendered when `state === 'signedIn'`; text is `Signed in as: <username>` |
| `authenticator-error` | Inline error message. Absent when the state carries no error |
| `authenticator-action-<action>` | One wrapper per rendered action, e.g. `authenticator-action-signIn`. Federated actions keep their provider suffix, so `signIn:google` gives `authenticator-action-signIn:google` |
| `authenticator-<field>` | One per input, named after the field the server declared, e.g. `authenticator-username`, `authenticator-password`, `authenticator-code`. Hidden fields (session tokens, echoed usernames) carry it too |
| `authenticator-submit` | The action's submit button |
| `authenticated-content` | Container returned by `AuthenticatedContent` |
| `account-menu` | Container returned by `AccountMenuBar` |
| `account-menu-username` | Signed-in username in the bar |
| `account-menu-signout` | Sign-out button in the bar |
| `account-menu-signin` | Sign-in button in the bar, shown when signed out |
| `account-menu-modal` | Modal the bar opens, hosting an `Authenticator` |
| `account-menu-modal-close` | Close button on that modal |

Action and field names come from the server, so the hooks follow whatever the
Building Block emits: `authenticator-action-confirmSignUp`,
`authenticator-newPassword`, and so on.

Federated actions are named `<action>:<provider>`, and the hook keeps the suffix
verbatim: an action named `signIn:google` renders as
`authenticator-action-signIn:google`. The colon is safe in the selectors you'd
normally write. `page.getByTestId('authenticator-action-signIn:google')` matches
on the attribute value, and
`querySelector('[data-testid="authenticator-action-signIn:google"]')` works
because that value is a quoted string rather than selector grammar. Keep the
quotes though: a bare `[data-testid=authenticator-action-signIn:google]` is
invalid, because an unquoted attribute value has to be a CSS identifier.

Field and submit hooks repeat once per action, because a state can offer more
than one. The signed-out state renders `signIn` and `signUp` side by side and
both declare a `username`, so scope through the action wrapper:

```typescript
const signIn = page.getByTestId('authenticator-action-signIn');
await signIn.getByTestId('authenticator-username').fill('alice');
await signIn.getByTestId('authenticator-password').fill('correct-horse');
await signIn.getByTestId('authenticator-submit').click();
await expect(page.getByTestId('authenticator-signed-in')).toContainText('alice');
```

Depth 2 and 3 render your DOM instead of ours, so hooks inside a replaced action
or field are yours to add. Whatever the `Authenticator` still renders around them
(the container, the heading, the error) keeps its hook.

## See also

- [README](./README.md): component and type basics
- [DESIGN.md](./DESIGN.md): why auth is a state machine and why every action is a form
