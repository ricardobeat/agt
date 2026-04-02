// The Agt class — setup pipeline, worktree management, and execution dispatch.

import { existsSync, mkdirSync, writeFileSync, copyFileSync, readdirSync } from "fs";
import { join, dirname, basename } from "path";
import pc from "picocolors";
import { $ } from "bun";

import { HOME, AGT_DIR, DEFAULT_IMAGE, fatal, gitRoot, readJson, writeJson, loadToml } from "./shared.js";
import { renderSandboxProfile } from "./sandbox.js";
import {
  containerName, resolveImage,
  ensureImage, ensureContainer, execContainer,
  setupMounts, buildImage, listContainers, stopContainer, cleanContainer,
} from "./container.js";

export { DEFAULT_IMAGE, resolveImage };

const MODES_FILE = join(HOME, ".agt", "modes.json");

// --- class ---

export default class Agt {
  mode = "container";
  image = DEFAULT_IMAGE;
  envVars = {};
  mounts = [];

  constructor() {
    const file = ["./agt.toml", join(HOME, ".config", "agt", "config.toml")].find(existsSync);
    if (file) this.mode = loadToml(file)?.execution?.mode ?? this.mode;
  }

  // --- setup pipeline ---

  async setup(args) {
    args = [...args];
    let modeOverride = false;

    while (args[0]?.startsWith("--")) {
      const flag = args.shift();
      if (flag === "--image") this.image = args.shift();
      else if (flag === "--mode") {
        this.mode = args.shift();
        modeOverride = true;
      }
    }
    if (!args.length) fatal("branch name required");

    this.branch = args.shift();
    this.remainingArgs = args;
    this.cname = containerName(this.branch);
    this.envVars.AGT_NAME = this.cname;

    if (this.mode === "container") await ensureImage(this.image);
    await this.setupWorktree(modeOverride);
    await this.setupClaudeConfig();
    await this.setupAuth();

    if (this.mode === "container") {
      const m = setupMounts(this.configDir);
      this.mounts = m.mounts;
      Object.assign(this.envVars, m.envVars);
    } else {
      this.envVars.CLAUDE_CONFIG_DIR = this.configDir;
    }
  }

  async run(cmd) {
    if (this.mode === "sandbox") this.execSandbox(cmd);
    else {
      await ensureContainer(this);
      execContainer(cmd, this);
    }
  }

  // --- setup steps ---

  async setupWorktree(modeOverride) {
    const root = await gitRoot();
    if (!root) {
      this.worktree = process.cwd();
      this.gitRootPath = this.gitDir = null;
      console.log(pc.bold("Using current directory as workspace"));
      return;
    }

    this.worktree = join(root, ".worktrees", this.branch);
    this.gitRootPath = root;
    this.gitDir = join(root, ".git");

    if (existsSync(this.worktree)) {
      console.log(pc.yellow(`Worktree already exists at ${this.worktree}`));
      if (modeOverride) writeJson(MODES_FILE, { ...readJson(MODES_FILE), [this.worktree]: this.mode });
      else this.mode = readJson(MODES_FILE)[this.worktree] ?? this.mode;
    } else {
      console.log(pc.bold(`Creating worktree for branch '${this.branch}'...`));
      const r = await $`git -C ${root} worktree add ${this.worktree} -b ${this.branch}`.nothrow().quiet();
      if (r.exitCode !== 0) {
        const r2 = await $`git -C ${root} worktree add ${this.worktree} ${this.branch}`.nothrow();
        if (r2.exitCode !== 0) fatal(`Command failed: git worktree add`);
      }
      console.log(pc.green(`Worktree created at ${this.worktree}`));
      writeJson(MODES_FILE, { ...readJson(MODES_FILE), [this.worktree]: this.mode });
    }

    // copy .env files
    const r = await $`git -C ${root} ls-files --others --ignored --exclude-standard`.nothrow().quiet();
    if (r.exitCode !== 0) return;
    for (const rel of r.text().trim().split("\n").filter((l) => l.includes(".env"))) {
      try {
        const dest = join(this.worktree, dirname(rel));
        mkdirSync(dest, { recursive: true });
        copyFileSync(join(root, rel), join(dest, basename(rel)));
      } catch {}
    }
  }

  get settingsPath() {
    return join(HOME, ".agt", ".claude", "settings.json");
  }

  async setupClaudeConfig() {
    this.configDir = join(HOME, ".agt", "claude-config");
    mkdirSync(this.configDir, { recursive: true });

    // init shared settings once
    if (!existsSync(this.settingsPath)) {
      mkdirSync(dirname(this.settingsPath), { recursive: true });
      const host = join(HOME, ".claude", "settings.json");
      const settings = existsSync(host) ? readJson(host) : {};
      settings.sandbox = { ...settings.sandbox, enabled: false };
      writeJson(this.settingsPath, settings);
      console.log(pc.green(`Created agt Claude settings at ${this.settingsPath}`));
    }

    // rsync host claude config (excluding ephemeral/sensitive data)
    if (existsSync(join(HOME, ".claude"))) {
      const excludes = [
        ".credentials.json", "settings.json", "sessions",
        "history.jsonl", "todos", "statsig", "telemetry", "cache",
      ];
      const args = ["rsync", "-a", "--delete",
        ...excludes.flatMap((e) => ["--exclude", e]),
        join(HOME, ".claude") + "/", this.configDir + "/"];
      try { await $`${args}`; }
      catch { fatal(`rsync failed`); }
    }

    try { copyFileSync(join(AGT_DIR, "claude.json"), join(this.configDir, ".claude.json")); } catch {}
    try { copyFileSync(this.settingsPath, join(this.configDir, "settings.json")); } catch {}
  }

  async setupAuth() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.envVars.ANTHROPIC_API_KEY = apiKey;
      return;
    }
    const r = await $`security find-generic-password -s ${"Claude Code-credentials"} -w`.nothrow().quiet();
    if (r.exitCode === 0 && r.text().trim()) {
      writeFileSync(join(this.configDir, ".credentials.json"), r.text().trim(), { mode: 0o600 });
    } else {
      console.log(pc.yellow("Warning: no API key or OAuth token found. Run 'claude' on the host to authenticate first."));
    }
  }

  // --- sandbox execution ---

  execSandbox(cmd) {
    const profileFile = `/tmp/agt-sandbox.${process.pid}.sb`;
    writeFileSync(profileFile, renderSandboxProfile(this.worktree, this.gitRootPath));

    console.log(pc.bold(`Starting sandbox for ${this.branch} in ${this.worktree}...`));

    const zdotdir = `/tmp/agt-sandbox-zd.${process.pid}`;
    mkdirSync(zdotdir, { recursive: true });
    writeFileSync(join(zdotdir, ".zshrc"),
      `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\nPROMPT="%F{yellow}[sandbox]%f $PROMPT"\n`);

    const envArgs = Object.entries(this.envVars).map(([k, v]) => `${k}=${v}`);
    const args = ["sandbox-exec", "-f", profileFile,
      "/usr/bin/env", "AGT_SANDBOX=1", `ZDOTDIR=${zdotdir}`, ...envArgs,
      "/bin/zsh", "-c", `cd '${this.worktree}' && exec "$@"`, "--", ...cmd];
    const { exitCode } = Bun.spawnSync(args, { stdio: ["inherit", "inherit", "inherit"] });
    process.exit(exitCode);
  }

  // --- commands ---

  async cmdStart(args) {
    await this.setup(args);
    const claudeArgs = [
      "claude", "--dangerously-skip-permissions",
      "--channels", "plugin:telegram@claude-plugins-official",
    ];

    const sessionsDir = join(this.configDir, "sessions");
    if (existsSync(join(this.configDir, "projects")) && existsSync(sessionsDir)
      && readdirSync(sessionsDir).some((e) => e.endsWith(".json")))
      claudeArgs.push("--continue");

    if (this.remainingArgs.length) claudeArgs.push("-p", this.remainingArgs.join(" "));
    await this.run(claudeArgs);
  }

  async cmdEnter(args) {
    await this.setup(args);
    await this.run(["zsh"]);
  }

  async cmdClean(branch) {
    const root = (await gitRoot()) || fatal("Not inside a git repository");
    const wt = join(root, ".worktrees", branch);

    await cleanContainer(branch);

    if (existsSync(wt)) {
      try { await $`git -C ${root} worktree remove ${wt} --force`; }
      catch { fatal(`git worktree remove failed`); }
      console.log(pc.green(`Removed worktree at ${wt}`));
    }
    console.log(pc.green(`Cleaned up ${branch}`));
  }
}
