---
"aws-blocks-kotlin": patch
---

Document how the JVM cookie store keeps its encryption key

On the JVM, the cookie store's AES key is kept in a file beside the encrypted entries under `~/.blocks/<applicationId>`, protected only by file permissions: owner-only on a POSIX filesystem (Linux, macOS), and on Windows the access control list inherited from the user profile, which also lets administrators read it. The `BlocksConfig.applicationId` KDoc and the runtime configuration guide now say so, and that this does not keep the session from other processes running as the same OS user; an application that needs that should leave `applicationId` unset to keep the session in memory only. No behavior changes.
