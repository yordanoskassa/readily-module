#!/bin/sh
set -e

# The searchable index is baked into the image at /app/seed. It is copied into
# /app/data on first start rather than shipped there directly, because /app/data
# is the natural mount point for a persistent volume — and a mounted volume
# shadows whatever the image had at that path. Without this step, attaching a
# volume would leave the app running against an empty directory and reporting
# zero policies.
#
# Copying only when index.db is absent means:
#   no volume      -> seeded once per container start, runs are ephemeral
#   volume mounted -> seeded once, then the volume keeps runs across redeploys
if [ ! -f /app/data/index.db ]; then
    echo "[entrypoint] no index at /app/data — seeding from image"
    mkdir -p /app/data
    cp -a /app/seed/. /app/data/
else
    echo "[entrypoint] existing index found at /app/data — leaving it alone"
fi

mkdir -p /app/data/uploads

exec python -m uvicorn backend.app.main:app \
    --host 0.0.0.0 \
    --port "${PORT:-8000}"
