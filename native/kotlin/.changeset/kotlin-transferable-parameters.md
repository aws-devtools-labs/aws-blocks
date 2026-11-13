---
"aws-blocks-kotlin": patch
---

A parameter named `result` no longer breaks the generated client

An operation with a parameter named `result` whose type is an inline object, enum or union didn't compile: it declared a second `Result` class next to the operation's result (`Conflicting declarations`). The same happened for two properties whose names differ only in their separators, such as `user_name` and `userName`. The operation's result keeps `Result`, and a later type of the same name in the same scope is now `Result_2` (then `_3`, and so on), as in the Swift client. Every other generated name is unchanged.
