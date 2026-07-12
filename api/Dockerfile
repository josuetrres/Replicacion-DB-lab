# =============================================================
#  FastAPI REST API — Dockerfile
#  Uses a slim Python image for a small production-ready image.
# =============================================================

FROM python:3.12-slim

# Set working directory
WORKDIR /app

# Install system dependencies required by some Python packages
RUN apt-get update && apt-get install -y --no-install-recommends \
        gcc \
        libpq-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy requirements first (layer caching — only reinstall when changed)
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Copy application source
COPY . .

# Expose the API port
EXPOSE 8000

# Health check — Docker can use this to determine if the service is ready
HEALTHCHECK --interval=10s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')" || exit 1

# Run the API with uvicorn.
# --host 0.0.0.0 makes it reachable from other containers.
# --reload is OFF in production; we keep it simple here.
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
