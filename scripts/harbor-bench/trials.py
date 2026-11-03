"""Validate the requested trial count; print the GitHub Actions matrix as a JSON list."""
import argparse
import json
import re
import sys

MAX_TRIALS = 50


def parse_trials(value):
    """A decimal integer string in 1..MAX_TRIALS (no sign, spaces or leading zeros)."""
    if not isinstance(value, str) or not re.fullmatch(r'[1-9][0-9]*', value) or int(value) > MAX_TRIALS:
        raise argparse.ArgumentTypeError(f'trials must be an integer from 1 to {MAX_TRIALS}')
    return int(value)


def matrix(value):
    return list(range(1, parse_trials(value) + 1))


if __name__ == '__main__':
    try:
        print(json.dumps(matrix(sys.argv[1] if len(sys.argv) == 2 else '')))
    except argparse.ArgumentTypeError as error:
        sys.exit(str(error))
