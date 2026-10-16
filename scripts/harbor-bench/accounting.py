"""Claude 2.1.296 result modelUsage is session-cumulative; streams are per invocation."""
import json

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
        'session_id': session, 'cumulative': cumulative, 'usage': delta,
        'accounting_errors': errors, 'turns': final.get('num_turns'),
        'tool_calls': len(tools), 'llm_calls': len(messages),
        'duration_ms': final.get('duration_ms'), 'duration_api_ms': final.get('duration_api_ms'),
        'subtype': final.get('subtype'), 'is_error': final.get('is_error'),
        'models': sorted(models), 'init_models': [event.get('model') for event in inits],
    }
