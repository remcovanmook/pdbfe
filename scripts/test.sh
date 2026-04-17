#!/usr/bin/env bash
# Runs the python test suite for the generation scripts.

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PYTHONPATH="${SCRIPT_DIR}:${PYTHONPATH}"

echo "Running python integration tests..."
python3 -m unittest discover -s "${SCRIPT_DIR}/tests" -v
