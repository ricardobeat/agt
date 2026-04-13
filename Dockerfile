FROM docker.io/node:24-slim

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    zsh \
    curl \
    git \
    jq \
    ripgrep \
    fzf \
    nano \
    openssh-client \
    ca-certificates \
    python3 \
    python3-pip \
    sudo \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Create non-root user with passwordless sudo
RUN useradd -m -s /bin/bash agt \
    && echo 'agt ALL=(ALL) NOPASSWD: ALL' >> /etc/sudoers

# mise (runtime manager) — install as root, globally available
RUN curl https://mise.run | sh \
    && mv /root/.local/bin/mise /usr/local/bin/

# Switch to agt user for user-scoped installs
USER agt
WORKDIR /home/agt

# Default tools via mise
RUN mise use -g bun@latest

# Claude CLI
RUN mise use --global npm:@anthropic-ai/claude-code
RUN mise use --global npm:@mariozechner/pi-coding-agent

# Claude default settings (skip first-run prompts)
COPY --chown=agt:agt claude.json /home/agt/.claude.json

# Shell setup
ENV SHELL=/bin/bash
RUN echo 'eval "$(mise activate bash)"' >> /home/agt/.bashrc \
    && echo 'PS1="\[\033[33m\]agt\[\033[0m\] \[\033[1m\]${AGT_BRANCH:-}\[\033[0m\] \w \$ "' >> /home/agt/.bashrc
ENV PATH="/cache/mise/shims:/home/agt/.local/share/mise/shims:/home/agt/.local/bin:${PATH}"

WORKDIR /work
CMD ["/bin/bash"]
