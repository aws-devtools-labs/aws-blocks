---
"@aws-blocks/create-blocks-app": patch
---

create-blocks-app now scaffolds a fresh project into a directory that contains only benign metadata files (VCS, editor, and OS entries) or an INSTRUCTIONS.md seed, instead of aborting. Any other pre-existing file (including a README.md or .gitignore) still blocks scaffolding, and the error now lists each conflicting entry — so no existing file is overwritten.
