# syntax=docker/dockerfile:1
#
# 生成用コンテナの送信先を絞る出口プロキシ。CONNECTを許可リストのドメイン・443番に限る。
# ビルドのコンテキストはリポジトリのルート（docker/compose.codex.yaml から使う）。
# 実OpenAI認証・到達先の妥当性は別途確認する。SITEOFFER_EGRESS_CLIENT_CIDRは専用ネットワークの範囲。
FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends squid \
 && rm -rf /var/lib/apt/lists/*
COPY docker/egress-proxy/squid.conf /etc/squid/squid.conf
COPY docker/egress-proxy/allowed-domains.txt /etc/squid/allowed-domains.txt
COPY docker/egress-proxy/entrypoint.sh /usr/local/bin/siteoffer-egress
RUN chmod 0755 /usr/local/bin/siteoffer-egress
USER proxy
EXPOSE 3128
ENTRYPOINT ["/usr/local/bin/siteoffer-egress"]
