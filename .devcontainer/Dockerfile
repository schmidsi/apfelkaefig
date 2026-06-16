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

# >>> akf plugin: ssh
# Install sshd so the box is reachable for `akf up --serve`. Drop the
# package-generated host keys: the persistent one in /var/lib/akf-ssh (a named
# volume) is authoritative, generated on first --serve and reused thereafter.
RUN apt-get update && apt-get install -y --no-install-recommends openssh-server && \
    rm -rf /var/lib/apt/lists/* && \
    rm -f /etc/ssh/ssh_host_*

# Minimal, pubkey-only sshd config. UsePAM no avoids PAM treating the
# passwordless 'node' account as locked and rejecting pubkey auth.
RUN printf '%s\n' \
    'PasswordAuthentication no' \
    'PermitRootLogin no' \
    'UsePAM no' \
    'AuthorizedKeysFile /home/node/.ssh/authorized_keys' \
    'HostKey /var/lib/akf-ssh/ssh_host_ed25519_key' \
    > /etc/ssh/sshd_config.d/akf.conf

# Entrypoint (the command `akf up --serve` runs): ensure the host key exists
# in the persistent volume, install the authorized key injected via env, then
# exec sshd in the foreground (-D) logging to stderr (-e) so logs stream.
RUN printf '%s\n' \
    '#!/bin/sh' \
    'set -e' \
    'mkdir -p /run/sshd /var/lib/akf-ssh' \
    'if [ ! -f /var/lib/akf-ssh/ssh_host_ed25519_key ]; then ssh-keygen -t ed25519 -N "" -f /var/lib/akf-ssh/ssh_host_ed25519_key; fi' \
    'install -d -m 700 -o node -g node /home/node/.ssh' \
    'if [ -n "$AKF_SSH_AUTHORIZED_KEY" ]; then' \
    '  printf "%s\\n" "$AKF_SSH_AUTHORIZED_KEY" > /home/node/.ssh/authorized_keys' \
    '  chown node:node /home/node/.ssh/authorized_keys' \
    '  chmod 600 /home/node/.ssh/authorized_keys' \
    'fi' \
    'exec /usr/sbin/sshd -D -e' \
    > /usr/local/bin/akf-sshd && chmod +x /usr/local/bin/akf-sshd
# <<< akf plugin: ssh
