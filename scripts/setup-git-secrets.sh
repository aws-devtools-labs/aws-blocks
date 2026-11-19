#!/usr/bin/env bash
# Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
# SPDX-License-Identifier: Apache-2.0

# This script registers AWS secret patterns with git-secrets when available.
# It runs as part of the repository setup process to ensure developers have
# proper secret detection configured.
#
# @remarks
# This script is designed to be non-blocking - if git-secrets is not installed,
# it will display a warning but allow setup to continue. The pre-commit hook will
# enforce git-secrets installation at commit time.

LOG_PREFIX="[git-secrets setup]"

# Check if git-secrets is installed
if ! command -v git-secrets >/dev/null 2>&1; then
	echo "$LOG_PREFIX ⚠️  git-secrets is not installed."
	echo "$LOG_PREFIX Install it to enable secret scanning on commit:"
	echo "$LOG_PREFIX   macOS:   brew install git-secrets"
	echo "$LOG_PREFIX   Linux:   See https://github.com/awslabs/git-secrets#installing-git-secrets"
	echo "$LOG_PREFIX   Windows: See https://github.com/awslabs/git-secrets#installing-git-secrets"
	echo "$LOG_PREFIX Skipping pattern registration."
	exit 0
fi

echo "$LOG_PREFIX git-secrets is installed, registering AWS patterns..."

# Register AWS patterns with git-secrets
git secrets --register-aws 2>/dev/null || true

echo "$LOG_PREFIX ✅ AWS patterns registered successfully!"
echo "$LOG_PREFIX Run 'git secrets --list' to view registered patterns."
