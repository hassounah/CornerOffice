FROM cgr.dev/chainguard/wolfi-base
ARG WITH_NODE=1
ARG WITH_GO=1
ARG WITH_BUILD=1
ARG AGENT_UID
ARG AGENT_GID
ARG AGENT_HOME
# core (always) + plugin runtime (always, D4)
RUN apk add --no-cache bash git curl ca-certificates iptables ipset bind-tools ripgrep jq gh libstdc++ \
      procps dnsmasq python-3.12 uv bun \
 && if [ "$WITH_NODE" = 1 ];  then apk add --no-cache nodejs-22 corepack && corepack enable; fi \
 && if [ "$WITH_GO" = 1 ];    then apk add --no-cache go; fi \
 && if [ "$WITH_BUILD" = 1 ]; then apk add --no-cache build-base; fi
COPY co-entrypoint.sh init-firewall.sh dnsmasq-base.conf /opt/co-sandbox/
RUN chmod 0755 /opt/co-sandbox/co-entrypoint.sh /opt/co-sandbox/init-firewall.sh \
 && chmod 0644 /opt/co-sandbox/dnsmasq-base.conf && chown -R root:root /opt/co-sandbox \
 && addgroup -S codns && adduser -S -D -H -G codns codns \
 && mkdir -p /var/log/co-dns && chown codns:codns /var/log/co-dns \
 && (awk -F: -v g="$AGENT_GID" '$3==g{f=1} END{exit !f}' /etc/group || addgroup -g "$AGENT_GID" agent) \
 && adduser -D -u "$AGENT_UID" -G "$(awk -F: -v g="$AGENT_GID" '$3==g{print $1; exit}' /etc/group)" -h "$AGENT_HOME" agent \
 && mkdir -p "$AGENT_HOME/.corner-office/sandboxes" "$AGENT_HOME/.corner-office/events" \
 && chown -R "$AGENT_UID:$AGENT_GID" "$AGENT_HOME/.corner-office" && chmod -R 0755 "$AGENT_HOME/.corner-office" \
 && { find / -xdev -perm /6000 -type f -exec chmod a-s {} + || true; }
# Codex: pinned and hash-verified (SL-1). The pins are build args with no defaults, so an empty pin fails the build.
# The checksum is verified before the archive is unpacked; the install is root-owned and not writable by the agent user.
ARG CODEX_VERSION
ARG CODEX_SHA512_X64
ARG CODEX_SHA512_ARM64
RUN set -eu \
 && [ -n "$CODEX_VERSION" ] && [ -n "$CODEX_SHA512_X64" ] && [ -n "$CODEX_SHA512_ARM64" ] \
 && case "$(uname -m)" in \
      x86_64)  arch=x64;   triple=x86_64-unknown-linux-musl;  sum="$CODEX_SHA512_X64" ;; \
      aarch64) arch=arm64; triple=aarch64-unknown-linux-musl; sum="$CODEX_SHA512_ARM64" ;; \
      *) echo "unsupported architecture for Codex: $(uname -m)" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /tmp/codex.tgz "https://registry.npmjs.org/@openai/codex/-/codex-${CODEX_VERSION}-linux-${arch}.tgz" \
 && echo "${sum}  /tmp/codex.tgz" | sha512sum -c - \
 && mkdir -p /opt/codex \
 && tar --no-same-owner --strip-components=1 -xzf /tmp/codex.tgz -C /opt/codex \
 && rm -f /tmp/codex.tgz \
 && chown -R root:root /opt/codex && chmod -R go-w /opt/codex \
 && test -x "/opt/codex/vendor/${triple}/bin/codex" \
 && ln -s "/opt/codex/vendor/${triple}/bin/codex" /usr/local/bin/codex
USER agent
ENV HOME=${AGENT_HOME} PATH=${AGENT_HOME}/.local/bin:/usr/local/bin:/usr/bin:/bin \
    DISABLE_AUTOUPDATER=1 COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN curl -fsSL https://claude.ai/install.sh | bash
ENTRYPOINT ["/opt/co-sandbox/co-entrypoint.sh"]
