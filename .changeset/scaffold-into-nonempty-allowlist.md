---
"@aws-blocks/create-blocks-app": patch
---

Scaffold a fresh Blocks app into a directory that contains only benign files.

`create-blocks-app` previously aborted with "Target directory is not empty and no package.json found." whenever the target directory held any file. It now scaffolds a fresh project into a directory that contains only benign files — common VCS, editor, and OS metadata, plus `README.md`, `INSTRUCTIONS.md`, and `.gitkeep` — instead of aborting. When the directory contains genuinely conflicting files, the error now lists each conflicting entry.
