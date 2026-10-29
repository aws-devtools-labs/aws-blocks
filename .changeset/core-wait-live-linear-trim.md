---
"@aws-blocks/core": patch
---

The deploy's wait for the new build to go live trims trailing slashes from the hosting URL in linear time. It used the regular expression `/\/+$/`, which takes quadratic time on a long run of `/` that isn't at the end of the string.
