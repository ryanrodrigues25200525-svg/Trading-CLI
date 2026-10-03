# tradingcli — pinned runtime for agents and the OpenTUI dashboard.
# Pinned here (not "latest") so the MCP surface can't break underneath:
# - Python 3.11 + requirements.txt (incl. mcp>=1.27,<2)
# - Bun >=1.4.1 (OpenTUI renderer)
FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PAPERTRADE_DB=/data/papertrade.db

RUN apt-get update && apt-get install -y --no-install-recommends \
        curl unzip ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Bun (pinned floor; OpenTUI needs >=1.4.1)
RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v1.4.2 \
    && ln -s /root/.bun/bin/bun /usr/local/bin/bun
ENV PATH="/root/.bun/bin:${PATH}"

WORKDIR /app
COPY requirements.txt pyproject.toml README.md LICENSE ./
COPY papertrade.py mcp_server.py dashboard.py web_ui.py portfolio_backtest.py ./
COPY docs/agent-guide.md docs/agent-guide.md
COPY tui/package.json tui/bun.lock ./tui/
RUN pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir . \
    && (cd tui && bun install --frozen-lockfile)

VOLUME /data
ENTRYPOINT ["tradingcli"]
CMD ["--help"]
