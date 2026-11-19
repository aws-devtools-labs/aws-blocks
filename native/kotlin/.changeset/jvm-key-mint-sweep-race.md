---
"aws-blocks-kotlin": patch
---

Fix a stored session being discarded when two instances first reach JVM storage at once

The desktop store generates its encryption key on first use, and the instance that generates one
removes the entries an earlier key left behind. It published the key before removing them, so a
second instance starting at the same moment adopted that key, wrote a session under it, and had it
deleted by the sweep still to come. Entries are now removed only when they carry a different key's
fingerprint, which keeps the session the second instance wrote.
