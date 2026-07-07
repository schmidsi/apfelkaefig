FROM debian:bookworm-slim

# Minimal base for `akf up` drive-by mode. Codex, Gemini CLI, Python, etc. are
# BYO via a custom Dockerfile that does `ARG AKF_BASE` / `FROM ${AKF_BASE}`
# (akf build injects AKF_BASE=apfelkaefig-base:<hash>).

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl sudo ca-certificates jq \
    ripgrep fd-find tree vim unzip xz-utils tmux \
    && rm -rf /var/lib/apt/lists/*

# Without a UTF-8 locale tmux falls back to POSIX and renders every non-ASCII
# glyph as '_' (Claude Code's spinner, bullets, banner). C.UTF-8 ships with
# glibc, so no locales package needed.
ENV LANG=C.UTF-8

# GitHub CLI
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cli/cli/releases/latest/download/gh_$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | sed 's/^v//')_linux_${ARCH}.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local

# 1Password CLI for on-demand secret resolution via OP_SERVICE_ACCOUNT_TOKEN.
RUN ARCH=$(dpkg --print-architecture) && \
    OP_VERSION=v2.30.3 && \
    curl -sSfo /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/${OP_VERSION}/op_linux_${ARCH}_${OP_VERSION}.zip" && \
    unzip -o /tmp/op.zip -d /usr/local/bin op && \
    rm /tmp/op.zip && chmod +x /usr/local/bin/op

# Node (for `claude` and most coding agents that ship as npm packages).
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      arm64) NODE_ARCH=arm64 ;; \
      amd64) NODE_ARCH=x64 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac && \
    NODE_VERSION=v22.20.0 && \
    curl -fsSL "https://nodejs.org/dist/${NODE_VERSION}/node-${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz" \
    | tar -xJ --strip-components=1 -C /usr/local

# Non-root user. focus-events lets terminal apps (Claude Code) track pane
# focus through tmux instead of nagging about it in the status area.
RUN useradd -m -s /bin/bash node && \
    echo 'set -g focus-events on' > /home/node/.tmux.conf && \
    chown node:node /home/node/.tmux.conf

# Install Claude Code as the node user so its self-update path works. Pinned
# so bumping the version busts the Docker layer cache (an unpinned `| bash`
# would keep serving the stale cached layer on rebuilds) and changes the
# content hash → new base tag.
ARG CLAUDE_CODE_VERSION=2.1.175
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash -s ${CLAUDE_CODE_VERSION}
ENV PATH="/home/node/.local/bin:$PATH"

USER root
WORKDIR /workspace
