---
"aws-blocks-swift": minor
---

Generated enums and unions on a model are named after the model

**Breaking:** an enum or union declared for a component schema's property is now named after the schema and the property, as on Dart: `AuthAction.capability` is `AuthActionCapability` (was `Capability`), `Order.status` is `OrderStatus` (was `Status`), `AuthenticatedUser.groups` is `[AuthenticatedUserGroups]` (was `[GroupValue]`). Before, it took the property's name, so a generic name like `Status`, `Kind` or `Capability` collided with a type your app declares, and the module didn't compile. A name that already starts with the schema's name (`AuthFieldType`) is unchanged.

Code that names these types needs the new names. No typealiases are declared for the old ones, since an alias would keep the generic name taken in your module.
