FROM node:24-slim

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
    ca-certificates && \
    apt-get clean

# mise (runtime manager) — install as root, globally available
RUN sudo install -dm 755 /etc/apt/keyrings && \
  curl -fSs https://mise.jdx.dev/gpg-key.pub | sudo tee /etc/apt/keyrings/mise-archive-keyring.asc 1> /dev/null && \
  echo "deb [signed-by=/etc/apt/keyrings/mise-archive-keyring.asc] https://mise.jdx.dev/deb stable main" | sudo tee /etc/apt/sources.list.d/mise.list && \
  sudo apt-get update && sudo apt-get install -y mise

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash agt && echo 'agt ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers
USER agt

# Claude default settings (skip first-run prompts)
COPY --chown=agt:agt claude.json /home/agt/.claude.json

# Shell setup
ENV SHELL=/bin/bash
RUN echo 'PS1="\[\033[33m\]agt »\[\033[0m\] \[\033[1m\]${AGT_BRANCH:-}\[\033[0m\] \w \$ "' >> /home/agt/.bashrc
ENV MISE_DATA_DIR=/cache/mise
RUN echo 'export PATH="/cache/mise/shims:$PATH"' >> /home/agt/.bashrc \
 && echo 'mise activate --shims 2>/dev/null || true' >> /home/agt/.bashrc \
 && printf 'export PATH="/cache/mise/shims:$PATH"\nmise activate --shims 2>/dev/null || true\n' | sudo tee /etc/profile.d/mise.sh
RUN sudo mkdir -p /cache/mise && sudo chmod 777 /cache/mise

WORKDIR /work
ENTRYPOINT []
