FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl sudo ca-certificates jq \
    ripgrep fd-find tree vim unzip \
    && rm -rf /var/lib/apt/lists/*

# Install GitHub CLI
RUN ARCH=$(dpkg --print-architecture) && \
    curl -fsSL "https://github.com/cli/cli/releases/latest/download/gh_$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | jq -r '.tag_name' | sed 's/^v//')_linux_${ARCH}.tar.gz" \
    | tar xz --strip-components=1 -C /usr/local

# Install 1Password CLI (op) for on-demand secret resolution via OP_SERVICE_ACCOUNT_TOKEN.
# See docs/secrets.md for the full pattern.
RUN ARCH=$(dpkg --print-architecture) && \
    OP_VERSION=v2.30.3 && \
    curl -sSfo /tmp/op.zip "https://cache.agilebits.com/dist/1P/op2/pkg/${OP_VERSION}/op_linux_${ARCH}_${OP_VERSION}.zip" && \
    unzip -o /tmp/op.zip -d /usr/local/bin op && \
    rm /tmp/op.zip && chmod +x /usr/local/bin/op

# Non-root user
RUN useradd -m -s /bin/bash node

# Install Claude Code (as node user so auto-update works)
USER node
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/home/node/.local/bin:$PATH"

USER root
WORKDIR /workspace
