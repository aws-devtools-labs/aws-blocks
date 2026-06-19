# @aws-blocks/bb-cron-job

## 0.1.2

### Patch Changes

- 4758fd3: fix(bb-cron-job): respect the upper bound of stepped cron ranges (e.g. `0-30/10`) instead of stepping past it, and reject inverted (`30-10`) or out-of-bounds (`100`, `0-100/5`) field values instead of silently producing empty or invalid schedules

## 0.1.1

### Patch Changes

- c0558f3: Minor improvements
- Updated dependencies [270c049]
- Updated dependencies [c0558f3]
  - @aws-blocks/core@0.1.1
  - @aws-blocks/bb-logger@0.1.1

## 0.1.0

Initial version
