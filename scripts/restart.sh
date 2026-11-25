#!/usr/bin/env bash
# PresenceTrack AI — Single command restart
set -e
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$DIR/supervisor.py" restart
