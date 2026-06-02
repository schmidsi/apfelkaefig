ARG AKF_BASE
FROM ${AKF_BASE}

# Deno for working on the akf CLI itself (deno task test / fmt / compile).
# Single static binary — install once as root into /usr/local/bin.
USER root
ARG DENO_VERSION=v2.8.1
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      arm64) DENO_ARCH=aarch64 ;; \
      amd64) DENO_ARCH=x86_64 ;; \
      *) echo "unsupported arch $ARCH" && exit 1 ;; \
    esac && \
    curl -fsSL "https://github.com/denoland/deno/releases/download/${DENO_VERSION}/deno-${DENO_ARCH}-unknown-linux-gnu.zip" -o /tmp/deno.zip && \
    unzip /tmp/deno.zip -d /usr/local/bin && \
    rm /tmp/deno.zip && \
    chmod +x /usr/local/bin/deno

USER node
