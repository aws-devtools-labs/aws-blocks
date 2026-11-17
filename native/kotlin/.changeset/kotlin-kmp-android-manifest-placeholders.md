---
"aws-blocks-kotlin": patch
---

Inject the OIDC manifest placeholders into instrumented test APKs

Building an Android module's instrumented test APK failed its manifest merge with "requires a placeholder substitution but no value for `<oidcActivityExported>` is provided": a test component merges the runtime's manifest into an APK of its own and keeps a placeholder map the plugin never filled in. A library's own merge is unaffected — it leaves the placeholders to whatever consumes it. The plugin now sets `oidcRedirectScheme` and `oidcActivityExported` on every test component, and recognises an Android target declared with `com.android.kotlin.multiplatform.library` as well as `com.android.application` and `com.android.library`.
