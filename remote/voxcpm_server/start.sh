#!/bin/bash
# Start VoxCPM2 FastAPI in the foreground (for manual testing).
set -euo pipefail
cd /opt/voxcpm2
set -a
# shellcheck disable=SC1091
source .env
set +a
exec .venv/bin/python app.py
