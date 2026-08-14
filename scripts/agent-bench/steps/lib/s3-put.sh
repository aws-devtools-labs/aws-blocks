#!/usr/bin/env bash
# Best-effort S3 upload for the persist steps. Usage: s3-put.sh <src-file> <s3-uri> <label>
# Warns (never errors) on a missing source or failed copy, so a persist step stays green.
set -u
src="$1"
uri="$2"
label="$3"
if [ ! -f "$src" ]; then
  echo "::warning::no ${label} at ${src} — nothing to persist"
  exit 0
fi
aws s3 cp "$src" "$uri" || echo "::warning::S3 ${label} write failed for ${uri}"
