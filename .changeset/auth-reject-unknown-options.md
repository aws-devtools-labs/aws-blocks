---
'@aws-blocks/bb-auth': patch
'@aws-blocks/blocks': patch
---

`Auth` rejects options it doesn't recognise, so a misspelled or misplaced setting is never silently ignored. TypeScript does no excess-property check on `Auth`'s inferred options type, so `{ emailPasword: false, session: { … } }` or a top-level `preferredChallenge` (it belongs under `users`) would compile and then have no effect. The constructor checks the options at every nesting level, the same way in `npm run dev`, at synth and in Lambda. It throws an error naming each unknown option's path and the likely intended one:

```text
Auth 'auth': unknown options:
  - `emailPasword`: did you mean `emailPassword`?
  - `preferredChallenge`: it is not an option here; did you mean `users.preferredChallenge`?
```

Provider ids in `oidcProviders` and `samlProviders` are yours to choose and are never checked; the settings inside each provider are.
