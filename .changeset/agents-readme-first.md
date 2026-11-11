---
"@aws-blocks/create-blocks-app": patch
---

docs: tell agents to read a block's README first in the generated `AGENTS.md`

The docs bullet and the matching rule no longer ask agents to read `API.md` and `DESIGN.md` whenever they exist. Agents read the block's `README.md` first, open `API.md` only for an exact signature or type, and open `DESIGN.md` only when they are stuck or need implementation details.
