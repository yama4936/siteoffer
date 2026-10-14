# syntax=docker/dockerfile:1
#
# 生成用コンテナの送信先を絞るための出口プロキシ（案）。squid の CONNECT を許可リストのドメインだけに限る。
# ビルドのコンテキストはリポジトリのルート（docker/compose.codex.yaml から使う）。
# 状態：用意のみ・未検証。さらに、現在の container-entry.ts は Codex CLI に HTTPS_PROXY を渡さないため、
#       このプロキシを経由させるには担当外の変更が必要（docker/README.md「生成用コンテナのネットワーク」）。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends squid \
 && rm -rf /var/lib/apt/lists/*
COPY docker/egress-proxy/squid.conf /etc/squid/squid.conf
COPY docker/egress-proxy/allowed-domains.txt /etc/squid/allowed-domains.txt
USER proxy
EXPOSE 3128
CMD ["squid", "-N", "-d", "1", "-f", "/etc/squid/squid.conf"]
