"""Single source for the benchmark's model, CLI, Harbor and skill pins.

requirements.txt and the workflow's Bedrock session policy must restate the Harbor
revision and model ARN literally; update them together with this file.
"""
MODEL = 'global.anthropic.claude-opus-5-5'
# USD per token for MODEL. They must match the pinned model's list prices, which Claude Code also
# uses for `total_cost_usd`; change them together with MODEL.
PRICE_INPUT = 4e-6
PRICE_CACHE_WRITE = 5e-6  # 5-minute cache write, the only TTL Claude Code requests here.
PRICE_CACHE_READ = 0.2e-6
PRICE_OUTPUT = 20e-6
CLAUDE_VERSION = '2.1.296'
HARBOR_REVISION = '09f5b964f8e5075f7e52fd08c9994dfc80ad5d24'
SKILL_REVISION = '2cb0fa1c2e668e1bb075028800b6b27efb95779e'
SKILL_SHA256 = '5ccde623192be25a059a4bd20fc054a8a7577ecbfd8658f3b53d8717b8b83ea1'
SKILL_URL = (f'https://raw.githubusercontent.com/aws/agent-toolkit-for-aws/{SKILL_REVISION}'
             '/skills/core-skills/aws-blocks/SKILL.md')
