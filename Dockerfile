# ---------- build the frontend ----------
FROM node:22-alpine AS web

WORKDIR /web

# Lockfile first so the dependency layer caches independently of source changes.
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY frontend/ ./
RUN npm run build


# ---------- runtime ----------
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt ./backend/requirements.txt
RUN pip install --no-cache-dir -r backend/requirements.txt

COPY backend/ ./backend/
COPY --from=web /web/dist ./frontend/dist

# Seed data lives at /app/seed, not /app/data. The entrypoint copies it across
# on first start so that mounting a volume at /app/data — the whole point of
# having one — does not shadow the index and leave the app with no corpus.
#
# The source corpus PDFs are not shipped: index.db already carries the page text
# the app reads at runtime, so the image stays ~35MB of data instead of ~100MB.
COPY data/index.db ./seed/index.db
COPY data/samples/ ./seed/samples/

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# EasyPanel injects PORT; 8000 is the local default.
ENV PORT=8000
EXPOSE 8000

# Non-root. /app/data must stay writable: the runs table lives in index.db and
# SQLite needs to create its -wal and -shm siblings beside it.
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/data \
    && chown -R app:app /app/data /app/seed
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD python -c "import urllib.request,os; \
urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8000')}/api/health\").read()"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
