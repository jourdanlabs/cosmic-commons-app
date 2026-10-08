#!/bin/bash
# Copyright 2026 Leland Jourdan II / C&L Strategy · Apache-2.0
cd "$(dirname "$0")" || exit 1
node scripts/doctor.mjs || exit 1
(
  for attempt in {1..30}; do
    if curl -fsS http://127.0.0.1:4320/ >/dev/null 2>&1; then
      open http://127.0.0.1:4320
      exit 0
    fi
    sleep 1
  done
) &
node server.mjs
