---
"aws-blocks-swift": minor
---

Boolean and numeric literals keep their JSON type, dates cross the wire as ISO 8601 strings, and a union's transferable alternatives keep their value

**Boolean discriminators.** A union discriminated by a boolean, such as the result of the `Auth` block's `updateUserAttributes` (`{ isUpdated: true } | { isUpdated: false, nextStep }`), encoded the discriminator as the string `"true"` and decoded it as a string. The server sends a JSON `true`, so every call threw a `DecodingError`. It now encodes and decodes a boolean. The same applies to numeric discriminators (`{ code: 1, … } | { code: 2, … }`), whose cases are named `code1`, `code2`. A boolean or numeric `const` that isn't a discriminator is now a `Bool`, `Double` or `Int`; it used to generate an enum that didn't compile.

**Literal alternatives.** A union alternative that is one literal, such as TypeScript's `"auto" | number` or `false | { … }`, used to match any JSON value and encode `{}`. It's now a case with no payload that encodes as its value and decodes only from it. An alternative of several string values carries its own enum: `case level_Variant0(Level_Variant0)`.

**Dates.** The server sends a `Date` (`format: date-time`) as an ISO 8601 string, `"2026-10-05T12:34:56.789Z"`. The generated client decoded it with a plain `JSONDecoder`, which expects a number, so no result holding a date decoded, and requests sent a number. A `Date` now decodes from that string (with or without fractional seconds, any UTC offset) in a result, a property, a container, an optional, a union case and a channel message, and requests send it in the same form. Generated operations decode these results with `client.makeDecoder()`. The new `client.makeEncoder()` encodes a model the way a request does. A request parameter that is a `URL` is now sent as its string, not as `{"relative": …}`.

**`format: date` is now a `String`.** A calendar day (`"2026-10-05"`) was a `Date`, which couldn't decode the server's string and would be sent as a date-time. It's now a `String`, like `format: time`. If your code reads or passes one of these properties as a `Date`, use the string, or parse it with `Date.ISO8601FormatStyle().year().month().day()`.

**Transferable alternatives.** A union alternative that is a realtime channel, a file handle or an OIDC client (`RealtimeChannel<Note> | { error: string }`) was a case with no payload, so the channel was lost. The case now carries it: `case result_Variant0(RealtimeChannel<Note>)`. If your code matches or constructs one of these cases, add the value.
