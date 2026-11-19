---
"aws-blocks-swift": minor
---

fix(swift): make transferables read-only again

`RealtimeChannel`, `FileDownloadHandle`, `FileUploadHandle` and `OIDCClient` stay `Codable`, so a
generated model that holds one compiles, but encoding one now throws `EncodingError.invalidValue`
("Transferables are read-only"), as on Kotlin and Dart. Transferables only travel from the server
to the client.
