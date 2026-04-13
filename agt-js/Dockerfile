FROM docker.io/node:24-trixie-slim

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    curl \
    wget \
    git \
    jq \
    ripgrep \
    fzf \
    nano \
    sudo \
    openssh-client \
    ca-certificates \
    python3 python3-pip \
    build-essential gcc pkg-config make cmake ninja-build clang-format

# mise (runtime manager) — install as root, globally available
RUN curl https://mise.run | sh && mv /root/.local/bin/mise /usr/local/bin/

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash agt && echo 'agt ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
USER agt

# Claude default settings (skip first-run prompts)
COPY --chown=agt:agt claude.json /home/agt/.claude.json

# Shell setup
ENV SHELL=/bin/bash
RUN echo 'PS1="\[\033[33m\]agt\[\033[0m\] \[\033[1m\]${AGT_BRANCH:-}\[\033[0m\] \w \$ "' >> /home/agt/.bashrc
ENV MISE_DATA_DIR=/cache/mise
ENV PATH="/cache/mise/shims:${PATH}"
RUN sudo mkdir -p /cache/mise && sudo chmod 777 /cache/mise
# RUN echo 'eval "$(mise activate bash)"' >> /home/agt/.bashrc
RUN mise activate --shims

# Default tools via mise — installed into /cache/mise so the mount persists them
ENV MISE_NPM_PACKAGE_MANAGER=bun
RUN mise use -g fd
RUN mise use -g bun
RUN mise use --global npm:@anthropic-ai/claude-code
RUN mise use --global npm:@mariozechner/pi-coding-agent

WORKDIR /work
ENTRYPOINT []
