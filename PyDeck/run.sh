#!/usr/bin/env bash
set -euo pipefail

mkdir -p /data/projects

echo "======================================"
echo " PyDeck"
echo " Python Automation Runtime for HA"
echo "======================================"

exec python /app/main.py
