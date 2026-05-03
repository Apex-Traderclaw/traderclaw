#!/usr/bin/env bash
# Wrapper — canonical script: scripts/openclaw-session-cleanup.sh
exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/scripts/openclaw-session-cleanup.sh" "$@"
