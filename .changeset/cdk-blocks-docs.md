---
"@aws-blocks/blocks": minor
---

`cdk-blocks docs` prints the docs that ship in `@aws-blocks/blocks` by name, wherever npm installed the package, so a hoisted workspace finds them too.

```text
Usage: npx --no -- cdk-blocks docs [name...] [options]

  cdk-blocks docs                       the blocks, their classes and what each does
  cdk-blocks docs <block>...            each block's README; a block is its class (DistributedTable),
                                        its folder (bb-distributed-table) or the folder without bb-
  cdk-blocks docs <name>...             an export, an option or Owner.member (ApiError, ifFieldEquals,
                                        Secret.get): its import line, declaration and the docs about it

  --api                  the block's API report (exact signatures) instead of its README
  --section <topic>      the part of the docs about a topic; repeatable; with no topic, the headings
  --exports [filter...]  the names @aws-blocks/blocks and its entries export, and which entry to use
  --search <term>        matching lines in every doc, or in the named blocks, with their section
```

- **Listing and reading:**
  - `cdk-blocks docs` lists every block with its class names, what it does and its other files (`API.md`, `DESIGN.md`), then the framework docs by the file each prints: `guide` is the package README, `troubleshooting` its `TROUBLESHOOTING.md`.
  - A doc path prints that file of a block: `cdk-blocks docs bb-cron-job/DESIGN.md`.
- **Names:**
  - `cdk-blocks docs <name>` prints the import line, the declaration, and the README section that documents it.
  - A type gets `import type`. A value that browser code needs gets its `@aws-blocks/blocks/client` import.
  - Declarations an API report leaves out (unexported instance types such as `SecretImpl`) and doc comments come from the installed type files.
  - `Owner.member` also finds a member the owner inherits from a class or interface it extends, and names that base: `Auth.protect` is `AuthBase`'s `protect`.
  - `Owner.member` with a member the owner doesn't have lists the owner's members, inherited ones included.
- **`--exports [filter...]`** lists the names `@aws-blocks/blocks` and its subpath entries (`/client`, `/ui`, `/utils`, `/server`, `/theme`) export, and which entry to import each from. A filter that names an entry (`--exports utils`) lists that entry's names.
- **Sections and search:**
  - `--section <topic>` prints one section. It matches headings loosely, falls back to the lines that mention the topic, and looks in a block's other docs. A README heading comes first, then a heading of another doc that names the topic (its title, or a subsection named exactly), then the README's lines that mention it: `Auth --section password` reads the README, not a `DESIGN.md` subsection that starts with the word.
  - `--section` with no topic lists a doc's headings with line ranges, also when another option follows it (`DistributedTable --section --api`). Before `--search` it adds nothing, so the search runs.
  - `--search <term>` prints matching lines from every doc with their section. It accepts grep's `a|b` and drops grep's own flags (`-i`, `--`) before the term.

Every printed doc starts with a `# <folder>/<file>` line (`# bb-kv-store/README.md`, `# README.md` for the package README), and that doc path prints the file again. Output never names a path on disk, so nothing points into `node_modules`. An unknown name or section is a usage error (exit 2) that names the closest matches. A file the block doesn't have exits 1 and lists the files it has. Arguments after `--` are names.
