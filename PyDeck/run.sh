#!/usr/bin/env bash
set -e

echo "======================================"
echo " PyDeck 0.2.0"
echo " Python Automation Runtime"
echo "======================================"

mkdir -p /data/projects

exec python /app/main.py
