"""Conservative inspection-request counters; never publish paths, commands or output."""
import re
import shlex

from accounting import events

CATEGORIES = ('skill', 'app_instructions', 'block_docs', 'framework_source')


def categories(path):
    if not isinstance(path, str):
        return set()
    found = set()
    if re.search(r'(?:^|/)SKILL\.md$', path):
        found.add('skill')
    if re.search(r'(?:^|/)AGENTS\.md$', path):
        found.add('app_instructions')
    if '@aws-blocks/' in path:
        if re.search(r'/(?:README|API|DESIGN|TROUBLESHOOTING|CHANGELOG)\.md$', path) or '/docs/' in path:
            found.add('block_docs')
        elif '/dist/' in path or '/src/' in path:
            found.add('framework_source')
    return found


def inspect_inputs(tool, inputs):
    if tool == 'Read':
        return categories(inputs.get('file_path', ''))
    if tool in ('Grep', 'Glob'):
        return categories(inputs.get('path', ''))
    if tool != 'Bash':
        return set()
    command = inputs.get('command', '')
    # Do not mistake source embedded in writes/scripts for files actually read.
    if '<<' in command or '\n' in command:
        return set()
    found = set()
    for segment in re.split(r'&&|\|\||[;|]', command):
        try:
            args = shlex.split(segment)
        except ValueError:
            continue
        if args and args[0] in ('cat', 'head', 'tail', 'grep', 'rg', 'less', 'more'):
            for arg in args[1:]:
                found.update(categories(arg))
        if args and args[0] == 'sed' and '-n' in args and not any(a.startswith('-i') for a in args):
            for arg in args[1:]:
                found.update(categories(arg))
    return found


def summarize_discovery(text):
    stream = events(text)
    if not stream:
        return None
    tools, failures = {}, set()
    for event in stream:
        content = (event.get('message') or {}).get('content')
        if not isinstance(content, list):
            continue
        for block in content:
            if not isinstance(block, dict):
                continue
            if event.get('type') == 'assistant' and block.get('type') == 'tool_use' and block.get('id'):
                tools[block['id']] = block
            elif block.get('type') == 'tool_result' and block.get('is_error') is True:
                failures.add(block.get('tool_use_id'))
    counts = {key: 0 for key in CATEGORIES}
    for block in tools.values():
        for key in inspect_inputs(block.get('name'), block.get('input') or {}):
            counts[key] += 1
    return {**counts, 'failed_tools': len(failures.intersection(tools)), 'observed_tools': len(tools)}
