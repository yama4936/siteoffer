FROM node:24-bookworm-slim

ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app
RUN apt-get update \
    && apt-get install --yes --no-install-recommends python3 ca-certificates \
    && rm -rf /var/lib/apt/lists/*
RUN npm install --global pnpm@12.11.2
COPY . .
RUN pnpm install --frozen-lockfile

# ローカル開発用。生成コードを実行する隔離コンテナとは別。
CMD ["pnpm", "dev:web"]
