---
"aws-blocks-kotlin": patch
---

Fix session storage silently failing to save on Windows

Writing a stored session on Windows failed with `AccessDeniedException` whenever the write
overlapped a read of the same entry, because Windows refuses to replace a file another handle has
open where a POSIX filesystem allows it. The cookie jar treats a failed write as pending and retries
on the next call, so the effect was a session that quietly stopped being saved while the application
was busy. The rename is now retried for as long as the reader holds the file open.
