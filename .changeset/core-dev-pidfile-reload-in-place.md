---
"@aws-blocks/core": patch
"@aws-blocks/blocks": patch
---

fix(core): the dev-server pidfile never goes missing while a reload takes it over

When `tsx watch` restarted the dev server after an edit, the new dev server took over the pidfile by moving the old one away and then creating its own, so for a moment there was no pidfile, and a `cdk-blocks dev stop` at that moment found no dev server to stop. The new dev server now replaces its predecessor's record in one step. A stale pidfile left by a session that has ended is still taken over as before.
