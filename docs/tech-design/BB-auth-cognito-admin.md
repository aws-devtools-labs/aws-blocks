# BB: AuthCognitoAdmin — SUPERSEDED

> **⚠️ SUPERSEDED.** The original design proposed a separate `@aws-blocks/bb-auth-cognito-admin` package. We instead ship the admin surface as an **opt-in `auth.admin` handle** on the existing `AuthCognito` class.
>
> The authoritative design and implementation plan is **[BB-auth-cognito-admin-implementation-plan.md](./BB-auth-cognito-admin-implementation-plan.md)**. For the shipped API and usage, see the [`bb-auth-cognito` README](../../packages/bb-auth-cognito/README.md) (*Admin surface*) and [DESIGN.md](../../packages/bb-auth-cognito/DESIGN.md).

## Why the direction changed

The separate-package design carried a second construct, a `/internal` subpath for sharing mock state across instances, and cross-construct wiring — all to preserve an admin/client separation that, on the shared backend-Lambda model, is enforced by API surface + lint rather than IAM anyway. The in-package handle preserves that same separation (plus a compile-time opt-in gate) at a fraction of the cost. The full trade study, type-safety analysis (including the `AuthCognito<O>` variance constraint that makes `admin.actions` scope the IAM grant rather than the typed method set), task list, and verification plan live in the implementation-plan doc.

The original 755-line design doc (API surface, error model, mock-parity research) was retired here to avoid drift: its code snippets predated the rebrand and its package/wiring model no longer matches shipped code. Its still-relevant content was folded into the implementation plan and the package README/DESIGN.
