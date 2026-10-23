"""Claude 2.1.296 result modelUsage is session-cumulative; streams are per invocation.

Per-call input usage in a stream's assistant events is exact; per-call output_tokens there is a
partial streaming count, so output always comes from the result's cumulative usage.
"""
import json

from pins import PRICE_CACHE_READ, PRICE_CACHE_WRITE, PRICE_OUTPUT

TOKEN_FIELDS = {
    'input_tokens': 'inputTokens',
    'cache_read_tokens': 'cacheReadInputTokens',
    'cache_write_tokens': 'cacheCreationInputTokens',
    'output_tokens': 'outputTokens',
}


def events(text):
    result = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            result.append(value)
    return result


def tool_uses(text):
    return [block for event in events(text) if event.get('type') == 'assistant'
            for block in (event.get('message') or {}).get('content') or []
            if isinstance(block, dict) and block.get('type') == 'tool_use']


def skill_use(text):
    """How the installed aws-blocks skill was reached this phase: skill_tool, file_read or none."""
    uses = [(block.get('name'), json.dumps(block.get('input') or {})) for block in tool_uses(text)]
    if any(name == 'Skill' and 'aws-blocks' in inputs for name, inputs in uses):
        return 'skill_tool'
    if any('aws-blocks/SKILL.md' in inputs for _, inputs in uses):
        return 'file_read'
    return 'none'


def call_contexts(stream):
    """Input tokens each distinct model call processed, in order, per agent thread; None if any is missing.

    Threads are keyed by parent_tool_use_id (None is the main session); repeated events of one
    message carry the same usage and count once.
    """
    threads, seen = {}, set()
    for event in stream:
        message = event.get('message') or {}
        if event.get('type') != 'assistant' or message.get('id') in seen:
            continue
        seen.add(message.get('id'))
        usage = message.get('usage') or {}
        values = [usage.get(key) for key in
                  ('input_tokens', 'cache_creation_input_tokens', 'cache_read_input_tokens')]
        if not message.get('id') or not all(type(v) is int and v >= 0 for v in values):
            return None
        threads.setdefault(event.get('parent_tool_use_id'), []).append(sum(values))
    return threads


def context_growth(threads, start):
    """New context the calls added: the sum of each call's rise over the previous call of its thread.

    The main thread continues from `start`, the session's last context in the previous phase; other
    threads start empty. A shrinking context (compaction) has to be rebuilt, so only rises count.
    """
    growth, end = 0, start
    for parent, contexts in threads.items():
        last = start if parent is None else 0
        for context in contexts:
            growth += max(0, context - last)
            last = context
        if parent is None:
            end = last
    return growth, end


def summarize(text, previous=None):
    stream = events(text)
    results = [event for event in stream if event.get('type') == 'result']
    final = results[-1] if results else {}
    session = final.get('session_id')
    errors = []
    if not session:
        errors.append('missing_result_session')
    if previous and session != previous['session_id']:
        errors.append('session_changed')
    cumulative = {}
    models = final.get('modelUsage') or {}
    for field, source in TOKEN_FIELDS.items():
        values = [value.get(source) for value in models.values()]
        cumulative[field] = sum(values) if values and all(isinstance(v, (int, float)) for v in values) else None
    cumulative['cost_usd'] = final.get('total_cost_usd')
    delta = {}
    for field, current in cumulative.items():
        before = previous['cumulative'].get(field) if previous else 0
        if current is None or before is None or 'session_changed' in errors:
            delta[field] = None
            errors.append(f'unavailable_{field}')
        elif current < before:
            delta[field] = None
            errors.append(f'nonmonotonic_{field}')
        else:
            delta[field] = current - before
    inputs = [delta[field] for field in ('input_tokens', 'cache_write_tokens', 'cache_read_tokens')]
    processed = sum(inputs) if None not in inputs else None
    delta['input_processed_tokens'] = processed
    # Cache-neutral cost prices the phase as if its session wrote every context token to the cache
    # once: growth at the cache-write rate, everything re-read at the cache-read rate. It ignores
    # prefixes served from another session's cache and rewrites after an expiry.
    threads = call_contexts(stream)
    start = previous.get('context_end') if previous else 0
    neutral = context_end = None
    if (threads is not None and start is not None and processed is not None
            and delta['output_tokens'] is not None
            and sum(map(sum, threads.values())) == processed):  # The stream holds every counted call.
        growth, context_end = context_growth(threads, start)
        neutral = (growth * PRICE_CACHE_WRITE + (processed - growth) * PRICE_CACHE_READ
                   + delta['output_tokens'] * PRICE_OUTPUT)
    else:
        errors.append('unavailable_cache_neutral_cost_usd')
    delta['cache_neutral_cost_usd'] = neutral
    messages, tools = set(), set()
    for event in stream:
        if event.get('type') != 'assistant':
            continue
        message = event.get('message') or {}
        if message.get('id'):
            messages.add(message['id'])
        for block in message.get('content') or []:
            if block.get('type') == 'tool_use' and block.get('id'):
                tools.add(block['id'])
    inits = [event for event in stream if event.get('type') == 'system' and event.get('subtype') == 'init']
    return {
        'session_id': session, 'cumulative': cumulative, 'usage': delta, 'context_end': context_end,
        'accounting_errors': errors, 'turns': final.get('num_turns'),
        'tool_calls': len(tools), 'llm_calls': len(messages),
        'duration_ms': final.get('duration_ms'), 'duration_api_ms': final.get('duration_api_ms'),
        'subtype': final.get('subtype'), 'is_error': final.get('is_error'),
        'models': sorted(models), 'init_models': [event.get('model') for event in inits],
    }
