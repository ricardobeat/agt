## agt

agt is a development tool to work with AI agents in a sandboxed environment.

- uses Apple containers for sandboxing
- native worktree support

For each feature, agt creates a git worktree, copies over .env files, spawns a new container with the worktree root and npm/pnpm cache directories mounted as volumes; then it runs claude with --dangerously-skip-permissions inside

### Container image

The image is alpine based and has the following pre-installed:

- bun
- node 24
- claude (curl -fsSL https://claude.ai/install.sh | bash)
- zsh as the shell
- mise
- jq
- ripgrep
- fzf
- updated nano editor with nanorc files
