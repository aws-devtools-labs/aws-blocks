---
'@aws-blocks/create-block': patch
---

Fix the external-mode "Next steps" `cd` hint to use the `--dir` target instead of the default package folder name, shell-quoting the path when it contains spaces or shell metacharacters so the printed command can be pasted safely.
