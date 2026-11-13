---
"aws-blocks-kotlin": patch
---

Inject the OIDC manifest placeholders for multiplatform Android library modules and for instrumented test components

A module that declares its Android target with `com.android.kotlin.multiplatform.library`, or that builds an instrumented test APK, failed its manifest merge with "requires a placeholder substitution but no value for `<oidcActivityExported>` is provided". The plugin now sets `oidcRedirectScheme` and `oidcActivityExported` for both.
