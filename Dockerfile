# ---------- build the frontend ----------
FROM node:22-alpine AS web

WORKDIR /web
COPY frontend/package.json frontend/package-lock.json* ./
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

# The prebuilt search index and the bundled sample documents. The source
# corpus PDFs are not shipped — index.db already carries the page text the
# app reads at runtime, so the image stays small.
COPY data/index.db ./data/index.db
COPY data/samples/ ./data/samples/

COPY --from=web /web/dist ./frontend/dist

# EasyPanel injects PORT; default to 8000 for local `docker run`.
ENV PORT=8000
EXPOSE 8000

# Non-root, but data/ must stay writable — runs and uploads are persisted there.
RUN useradd --create-home --uid 10001 app \
    && mkdir -p /app/data/uploads \
    && chown -R app:app /app/data
USER app

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,os; \
urllib.request.urlopen(f\"http://127.0.0.1:{os.environ.get('PORT','8000')}/api/health\").read()"

CMD ["sh", "-c", "exec python -m uvicorn backend.app.main:app --host 0.0.0.0 --port ${PORT:-8000}"]
