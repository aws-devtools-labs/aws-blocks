"""Small installed-Claude adapter: Bedrock-only auth and resumed-session accounting."""
import json
import os

from harbor.agents.installed.claude_code import ClaudeCode
from harbor.models.agent.context import ModelUsage

from accounting import skill_use, summarize
from pins import CLAUDE_VERSION, MODEL

CREDENTIALS = ('AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN')


class HarborBlocksClaude(ClaudeCode):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        if self.model_name != MODEL or self._version != CLAUDE_VERSION:
            raise ValueError('Harbor benchmark model/CLI pin mismatch')
        self.previous = None
        self.phase = 0

    def _resolve_auth_env(self):
        # Explicit allowlist, not Harbor's ambient provider credential discovery.
        auth = {key: os.environ[key] for key in CREDENTIALS}
        auth.update({
            'CLAUDE_CODE_USE_BEDROCK': '1', 'AWS_REGION': 'us-east-1',
            'AWS_DEFAULT_REGION': 'us-east-1', 'AWS_EC2_METADATA_DISABLED': 'true',
            'ANTHROPIC_MODEL': MODEL, 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC': '1',
        })
        for key in ('ANTHROPIC_DEFAULT_OPUS_MODEL', 'ANTHROPIC_DEFAULT_SONNET_MODEL',
                    'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_SMALL_FAST_MODEL',
                    'CLAUDE_CODE_SUBAGENT_MODEL'):
            auth[key] = MODEL
        return auth

    async def run(self, instruction, environment, context):
        # Harbor chowns downloaded logs to the host UID after every phase.
        # Restore the container user's access before continuing its session.
        await self.exec_as_root(environment, command='chown -R node:node /logs/agent')
        await super().run(instruction, environment, context)

    async def setup(self, environment):
        await super().setup(environment)
        # The skill arrives through Harbor's `skills` injection, not a fixed path.
        await self.exec_as_root(environment, command=(
            'mkdir -p /logs/agent; chown -R node:node /logs/agent; '
            'nohup node /opt/bench/registry.mjs </dev/null '
            '>/var/lib/harbor-verifier/registry.log 2>&1 &'
        ))
        await self.exec_as_agent(environment, command=(
            'for i in {1..30}; do '
            'curl -fsS http://localhost:4873/registry/@aws-blocks/create-blocks-app >/dev/null '
            '&& exit 0; sleep 1; done; exit 1'
        ))


    def populate_context_post_run(self, context):
        super().populate_context_post_run(context)
        self.phase += 1
        stream_file = self.logs_dir / 'claude-code.txt'
        stream = stream_file.read_text(errors='replace') if stream_file.exists() else ''
        metrics = summarize(stream, self.previous)
        self.previous = metrics
        if metrics['init_models'] != [MODEL] or metrics['models'] != [MODEL]:
            metrics['accounting_errors'].append('model_pin_not_observed')
        usage = metrics['usage']
        tokens = [usage[key] for key in ('input_tokens', 'cache_read_tokens', 'cache_write_tokens')]
        context.n_input_tokens = sum(tokens) if all(v is not None for v in tokens) else None
        context.n_cache_tokens = usage['cache_read_tokens']
        context.n_output_tokens = usage['output_tokens']
        context.cost_usd = usage['cost_usd']
        # Empty mapping prevents Harbor backfilling cumulative trajectory usage on a missing result.
        context.model_usage = {}
        if context.n_input_tokens is not None and context.n_output_tokens is not None:
            context.model_usage[MODEL] = ModelUsage(
                n_input_tokens=context.n_input_tokens, n_cache_tokens=context.n_cache_tokens or 0,
                n_output_tokens=context.n_output_tokens, cost_usd=context.cost_usd)
        metrics['phase'] = self.phase
        metrics['skill_use'] = skill_use(stream)
        context.metadata = {'harbor_bench': metrics}
        (self.logs_dir / 'phase-metrics.json').write_text(json.dumps(metrics, indent=2) + '\n')
