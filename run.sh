#!/usr/bin/env bash
# Start the cultural-station server (zero third-party dependencies).
set -e
cd "$(dirname "$0")"
export PYTHONUNBUFFERED=1
PORT="${PORT:-8000}"
if [ ! -s data/cultural_station.db ]; then
  python3 -m server.seed
fi
PORT="$PORT" exec python3 -m server.app
