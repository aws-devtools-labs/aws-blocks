---
"aws-blocks-kotlin": patch
---

fix(kotlin): generate type names that are valid file names on Windows

A spec name holding `"`, `*`, `?` or `|`, or ending in a space, no longer becomes a backticked type
name. Its class file couldn't be written on Windows, so the build failed there. Such a type is now
named from the name's words (`cre"ate` generates `CreAte`); its wire name is unchanged.
