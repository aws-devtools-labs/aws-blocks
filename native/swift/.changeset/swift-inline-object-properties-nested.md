---
"aws-blocks-swift": minor
---

Inline-object properties of your API's types now generate as nested structs, so same-named properties no longer share one type

If one of your API's types has a property whose type is an inline object (for example `meta: { value: number }`) and not a named type, the generated Swift client declared it as a top-level struct named after the property (`Meta`). When two types each had a `meta` property with different shapes, both used the first one's struct: the client compiled, but decoding the second type failed or read the wrong fields. Each such property now generates a struct nested inside its type (`Invoice.Meta`, `Receipt.Meta`), at any depth (`Shipment.Destination.Geo`), including optional, nullable, array and map properties and the enums inside them.

If your code names one of these types directly, update it to the nested name: `Meta` becomes `Invoice.Meta`. Code that only reads the properties (`invoice.meta.value`) is unchanged. A nested type whose name would hide another type it needs, such as one of your named types, `Date` or `Type`, is prefixed with its enclosing type's name (`Order.OrderAddress`).
