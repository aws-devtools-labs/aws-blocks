# __BB_CLASS__ — Design

TODO: describe the block's internals. Delete the guidance below once filled in.

## Composition

`__BB_CLASS__` is a composite Building Block. It extends `Scope` and instantiates
the Building Blocks it needs as children (the skeleton composes a `KVStore`).
Because those composed blocks resolve to their own mock / aws / cdk entry points
via conditional exports, `__BB_CLASS__` needs only a single `index.ts` that works
in every context — no `index.mock/aws/cdk` split and no CDK layer of its own.

## Mock vs AWS

There is no separate mock: the composed blocks provide their own. Local dev uses
their on-disk mocks; deployed, they talk to real AWS services. `__BB_CLASS__`
adds only the glue.
