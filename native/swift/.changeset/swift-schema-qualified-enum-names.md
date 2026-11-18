---
"aws-blocks-swift": minor
---

Generated enums and unions on a model are named after the model

**Breaking:** an enum or union declared for a component schema's property is now named after the schema and the property, as on Dart: `AuthAction.capability` is `AuthActionCapability` (was `Capability`), `Order.status` is `OrderStatus` (was `Status`), `AuthenticatedUser.groups` is `[AuthenticatedUserGroups]` (was `[GroupValue]`). Before, it took the property's name, so a generic name like `Status`, `Kind` or `Capability` collided with a type your app declares, and the module didn't compile. The prefix is always added (`User.userType` is `UserUserType`), and an enum or union on a discriminated variant's field is named after the variant and its union (`EmailNotificationPayloadPriority`), also as on Dart.

The Cognito user types are renamed the same way: `SignInProvider` is `AuthenticatedUserSignInProvider`, `DeliveryMedium` is `CodeDeliveryDetailsDeliveryMedium` and `GroupValue` is `AuthenticatedUserGroups`.

A union without a discriminator names its cases after itself, so its cases are renamed with it: `Filter.value: string | number` was `Value` with `case value_Variant0(String)`, and is now `FilterValue` with `case filterValue_Variant0(String)`. A `switch` that matches these cases needs the new case names, even if it never names the type.

Code that names these types needs the new names. No typealiases are declared for the old ones, since an alias would keep the generic name taken in your module.
