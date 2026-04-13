#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync, copyFileSync, readdirSync, rmSync } from "fs";
import { join, dirname, basename, resolve } from "path";
import { homedir } from "os";

const HOME = homedir();
const DEFAULT_IMAGE = "agt-sandbox";
const MODES_FILE = join(HOME, ".agt", "modes.json");
const AGT_DIR = dirname(resolve(import.meta.path));

// --- output ---

const red    = (msg) => console.error(`\x1b[31m${msg}\x1b[0m`);
const green  = (msg) => console.log(`\x1b[32m${msg}\x1b[0m`);
const yellow = (msg) => console.log(`\x1b[33m${msg}\x1b[0m`);
const bold   = (msg) => console.log(`\x1b[1m${msg}\x1b[0m`);
const fatal  = (msg) => { red(msg); process.exit(1); };

// --- shell ---

async function capture(...args) {
  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  return { ok: code === 0, out: out.trim() };
}

async function sh(...args) {
  const proc = Bun.spawn(args, { stdio: ["inherit", "inherit", "inherit"] });
  const code = await proc.exited;
  if (code !== 0) fatal(`Command failed: ${args.slice(0, 3).join(" ")}`);
}

function exec(...args) {
  const proc = Bun.spawnSync(args, { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(proc.exitCode);
}

// --- config ---

function tomlGet(file, key) {
  const [section, field] = key.split(".", 2);
  if (!section || !field) return null;
  try {
    let inSection = false;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (line.startsWith("[")) { inSection = line === `[${section}]`; continue; }
      const eq = line.indexOf("=");
      if (inSection && eq > 0 && line.slice(0, eq).trim() === field)
        return line.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    }
  } catch {}
  return null;
}

// --- modes ---

const readJson = (path, fallback = {}) => { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; } };
const writeJson = (path, data) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(data, null, 2)); };

function saveMode(path, mode) { writeJson(MODES_FILE, { ...readJson(MODES_FILE), [path]: mode }); }
function recallMode(path) { return readJson(MODES_FILE)[path]; }

// --- git helpers ---

async function gitRoot() { const r = await capture("git", "rev-parse", "--show-toplevel"); return r.ok ? r.out : null; }

async function resolveImage() {
  const root = await gitRoot();
  return [root && join(root, "Dockerfile.agt"), join(AGT_DIR, "Dockerfile")]
    .filter(Boolean).find(existsSync) ?? null;
}

async function imageExists(name) { const r = await capture("container", "image", "list"); return r.ok && r.out.includes(name); }

function containerName(branch) { return "agt-" + branch.replaceAll("/", "-"); }

// --- sandbox profile ---

function sandboxProfile(worktree, gitRoot) {
  const subpath = (p) => `  (subpath "${p}")`;
  const readPaths = [
    '  (literal "/")',
    ...["Applications", "usr", "bin", "sbin", "cores", "home", "Library", "System", "private", "dev", "opt", "tmp", "var", "Volumes"].map((p) => subpath(`/${p}`)),
    subpath(worktree),
    gitRoot && subpath(gitRoot),
    `  (regex #"^${HOME}/\\\\..*")`,
    subpath(`${HOME}/Library`),
  ].filter(Boolean);

  const writePaths = [
    ...["dev", "tmp", "private/tmp", "private/var/folders"].map((p) => subpath(`/${p}`)),
    subpath(worktree),
    gitRoot && subpath(join(gitRoot, ".git")),
    subpath(`${HOME}/.agt`),
    subpath(`${HOME}/.local`),
  ].filter(Boolean);

  return `(version 1)
(deny default)
(allow process*)
(allow signal)
(allow sysctl*)
(allow mach*)
(allow ipc*)
(allow file-ioctl)
(allow file-read-metadata)
(allow file-read-xattr)
(allow file-read-data
${readPaths.join("\n")})
(allow file-write*
${writePaths.join("\n")})
(allow network*)
(allow system-socket)
`;
}

// --- agt environment ---

class Agt {
  constructor() {
    this.mode = "container";
    this.image = DEFAULT_IMAGE;
    this.envVars = {};
    this.mounts = [];
    this.loadConfig();
  }

  loadConfig() {
    const file = ["./agt.toml", join(HOME, ".config", "agt", "config.toml")].find(existsSync);
    if (file) this.mode = tomlGet(file, "execution.mode") ?? this.mode;
  }

  async setup(args) {
    args = [...args];
    let modeOverride = false;

    // consume flags
    while (args.length && args[0].startsWith("--")) {
      const flag = args.shift();
      if (flag === "--image") this.image = args.shift();
      else if (flag === "--mode") { this.mode = args.shift(); modeOverride = true; }
      else if (flag === "--run") this.runCmd = args.shift();
    }

    if (!args.length) fatal("branch name required");
    this.branch = args.shift();
    this.remainingArgs = args;
    this.cname = containerName(this.branch);
    this.envVars.AGT_NAME = this.cname;

    if (this.mode === "container") await this.#ensureImage();
    await this.#setupWorktree(modeOverride);
    await this.#setupClaudeConfig();
    await this.#setupAuth();
    this.#setupMounts();
    return this;
  }

  // --- private setup steps ---

  async #ensureImage() {
    if (await imageExists(this.image)) return;
    if (this.image !== DEFAULT_IMAGE) fatal(`Image '${this.image}' not found.`);
    const dockerfile = await resolveImage();
    if (!dockerfile) fatal(`No image '${this.image}' found and no Dockerfile to build one.`);
    yellow(`Image not found, building from ${dockerfile}...`);
    await this.cmdBuild(this.image, dockerfile);
  }

  async #setupWorktree(modeOverride) {
    const root = await gitRoot();
    if (!root) {
      this.worktree = process.cwd();
      this.gitRootPath = this.gitDir = null;
      bold("Using current directory as workspace");
      return;
    }

    this.worktree = join(root, ".worktrees", this.branch);
    this.gitRootPath = root;
    this.gitDir = join(root, ".git");

    if (existsSync(this.worktree)) {
      yellow(`Worktree already exists at ${this.worktree}`);
      if (modeOverride) saveMode(this.worktree, this.mode);
      else this.mode = recallMode(this.worktree) ?? this.mode;
    } else {
      bold(`Creating worktree for branch '${this.branch}'...`);
      const r = await capture("git", "-C", root, "worktree", "add", this.worktree, "-b", this.branch);
      if (!r.ok) await sh("git", "-C", root, "worktree", "add", this.worktree, this.branch);
      green(`Worktree created at ${this.worktree}`);
      saveMode(this.worktree, this.mode);
    }

    // copy .env files
    const r = await capture("git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard");
    if (!r.ok) return;
    for (const rel of r.out.split("\n").filter((l) => l.includes(".env"))) {
      try {
        const dest = join(this.worktree, dirname(rel));
        mkdirSync(dest, { recursive: true });
        copyFileSync(join(root, rel), join(dest, basename(rel)));
      } catch {}
    }
  }

  get #agtSettingsPath() { return join(HOME, ".agt", ".claude", "settings.json"); }

  async #setupClaudeConfig() {
    this.configDir = join(HOME, ".agt", "claude-config");
    mkdirSync(this.configDir, { recursive: true });

    // init shared settings once
    if (!existsSync(this.#agtSettingsPath)) {
      mkdirSync(dirname(this.#agtSettingsPath), { recursive: true });
      const host = join(HOME, ".claude", "settings.json");
      const settings = existsSync(host) ? readJson(host) : {};
      settings.sandbox = { ...settings.sandbox, enabled: false };
      writeJson(this.#agtSettingsPath, settings);
      green(`Created agt Claude settings at ${this.#agtSettingsPath}`);
    }

    // rsync claude dir (excluding ephemeral/sensitive data)
    if (existsSync(join(HOME, ".claude"))) {
      const excludes = [".credentials.json", "settings.json", "sessions", "history.jsonl", "todos", "statsig", "telemetry", "cache"];
      await sh("rsync", "-a", "--delete", ...excludes.flatMap((e) => ["--exclude", e]),
        join(HOME, ".claude") + "/", this.configDir + "/");
    }

    try { copyFileSync(join(AGT_DIR, "claude.json"), join(this.configDir, ".claude.json")); } catch {}
    try { copyFileSync(this.#agtSettingsPath, join(this.configDir, "settings.json")); } catch {}
  }

  async #setupAuth() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.envVars.ANTHROPIC_API_KEY = apiKey;
      return;
    }
    const r = await capture("security", "find-generic-password", "-s", "Claude Code-credentials", "-w");
    if (r.ok && r.out) {
      const path = join(this.configDir, ".credentials.json");
      writeFileSync(path, r.out, { mode: 0o600 });
    } else {
      yellow("Warning: no API key or OAuth token found. Run 'claude' on the host to authenticate first.");
    }
  }

  #setupMounts() {
    if (this.mode === "container") {
      const cacheDir = join(HOME, ".agt", "cache");
      for (const sub of ["pnpm", "npm", "bun", "mise"]) {
        mkdirSync(join(cacheDir, sub), { recursive: true });
        this.mounts.push([join(cacheDir, sub), `/cache/${sub}`]);
      }
      this.mounts.push([this.configDir, this.configDir]);
      Object.assign(this.envVars, {
        npm_config_store_dir: "/cache/pnpm", NPM_CONFIG_CACHE: "/cache/npm",
        BUN_INSTALL_CACHE_DIR: "/cache/bun", MISE_DATA_DIR: "/cache/mise",
        CLAUDE_CONFIG_DIR: this.configDir,
      });
    } else {
      this.envVars.CLAUDE_CONFIG_DIR = this.configDir;
    }
  }

  // --- container management ---

  async #containerState() {
    const r = await capture("container", "ls", "--all", "--format", "json");
    if (!r.ok) return null;
    try {
      const c = JSON.parse(r.out).find((c) => c.configuration?.id === this.cname);
      return c?.status ?? null;
    } catch { return null; }
  }

  async #ensureContainer() {
    const state = await this.#containerState();

    if (!state) {
      bold(`Creating container ${this.cname}...`);
      const args = ["container", "run", "-d", "--name", this.cname,
        "--cpus", process.env.AGT_CPUS || "4", "--memory", process.env.AGT_MEMORY || "4G",
        "-v", `${this.worktree}:/work`];
      if (this.gitDir) args.push("-v", `${this.gitDir}:${this.gitDir}`);
      for (const [src, dst] of this.mounts) args.push("-v", `${src}:${dst}`);
      for (const [k, v] of Object.entries(this.envVars)) args.push("-e", `${k}=${v}`);
      args.push("-w", "/work", this.image, "sleep", "infinity");
      await sh(...args);
      green(`Container ${this.cname} created`);
    } else if (state === "stopped") {
      bold(`Restarting container ${this.cname}...`);
      await sh("container", "start", this.cname);
      green(`Container ${this.cname} restarted`);
    } else {
      yellow(`Container ${this.cname} already running`);
    }

    for (let i = 0; i < 30; i++) {
      if ((await capture("container", "exec", this.cname, "true")).ok) return;
      await Bun.sleep(200);
    }
    fatal("Container failed to become ready");
  }

  #envFlags() { return Object.entries(this.envVars).flatMap(([k, v]) => ["-e", `${k}=${v}`]); }
  #envArgs()  { return Object.entries(this.envVars).map(([k, v]) => `${k}=${v}`); }

  #execContainer(cmd) {
    exec("container", "exec", "-it", "-w", "/work", ...this.#envFlags(), this.cname, ...cmd);
  }

  #execSandbox(cmd) {
    const profileFile = `/tmp/agt-sandbox.${process.pid}.sb`;
    writeFileSync(profileFile, sandboxProfile(this.worktree, this.gitRootPath));

    bold(`Starting sandbox for ${this.branch} in ${this.worktree}...`);

    const zdotdir = `/tmp/agt-sandbox-zd.${process.pid}`;
    mkdirSync(zdotdir, { recursive: true });
    writeFileSync(join(zdotdir, ".zshrc"),
      `[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\nPROMPT="%F{yellow}[sandbox]%f $PROMPT"\n`);

    exec("sandbox-exec", "-f", profileFile,
      "/usr/bin/env", `AGT_SANDBOX=1`, `ZDOTDIR=${zdotdir}`, ...this.#envArgs(),
      "/bin/zsh", "-c", `cd '${this.worktree}' && exec "$@"`, "--", ...cmd);
  }

  async run(cmd) {
    if (this.mode === "sandbox") this.#execSandbox(cmd);
    else { await this.#ensureContainer(); this.#execContainer(cmd); }
  }

  // --- commands ---

  async cmdBuild(tag, dockerfile) {
    if (!existsSync(dockerfile)) fatal(`Dockerfile not found at ${dockerfile}`);
    bold(`Building ${tag} from ${dockerfile}...`);
    await sh("container", "build", "--tag", tag, "--file", dockerfile, dirname(dockerfile));
    green(`Image ${tag} built successfully`);
  }

  async cmdStart(args) {
    await this.setup(args);
    const cmdToRun = this.runCmd ? this.runCmd.split(/\s+/).filter(Boolean) : ["claude", "--dangerously-skip-permissions", "--channels", "plugin:telegram@claude-plugins-official"];

    const sessionsDir = join(this.configDir, "sessions");
    if (!this.runCmd && existsSync(join(this.configDir, "projects")) && existsSync(sessionsDir)
      && readdirSync(sessionsDir).some((e) => e.endsWith(".json")))
      cmdToRun.push("--continue");

    if (this.remainingArgs.length) cmdToRun.push("-p", this.remainingArgs.join(" "));
    await this.run(cmdToRun);
  }

  async cmdEnter(args) { await this.setup(args); await this.run(["zsh"]); }

  async cmdStop(branch) {
    const cname = containerName(branch);
    bold(`Stopping ${cname}...`);
    await sh("container", "stop", cname);
    green(`Stopped ${cname}`);
  }

  async cmdClean(branch) {
    const root = await gitRoot() || fatal("Not inside a git repository");
    const cname = containerName(branch);
    const wt = join(root, ".worktrees", branch);

    if ((await capture("container", "stop", cname)).ok) yellow(`Stopped container ${cname}`);
    if ((await capture("container", "rm", cname)).ok) yellow(`Removed container ${cname}`);
    if (existsSync(wt)) { await sh("git", "-C", root, "worktree", "remove", wt, "--force"); green(`Removed worktree at ${wt}`); }
    green(`Cleaned up ${branch}`);
  }

  async cmdList() {
    const r = await capture("container", "ls", "--all");
    const lines = r.ok ? r.out.split("\n").filter((l) => l.startsWith("ID") || l.startsWith("agt-")) : [];
    lines.length ? lines.forEach((l) => console.log(l)) : console.log("No agt containers found");
  }
}

// --- main ---

const COMMANDS = {
  start: { min: 1, usage: "agt start <branch> [prompt...]" },
  enter: { min: 1, usage: "agt enter <branch>" },
  build: { min: 0, usage: "agt build [--image tag] <dockerfile>" },
  list:  { min: 0 }, ls: { min: 0 },
  stop:  { min: 1, usage: "agt stop <branch>" },
  clean: { min: 1, usage: "agt clean <branch>" },
};

function usage() {
  console.log(`agt — sandboxed AI agent development tool

Usage:
  agt start <branch> [prompt...]   Create worktree + sandbox, run Claude inside
  agt enter <branch>               Create worktree + sandbox, drop into a shell
  agt build [dockerfile]           Build container image (container mode only)
  agt list                         List running agt containers
  agt stop <branch>                Stop a running container
  agt clean <branch>               Remove worktree and container

Options:
  --image <name>                   Use a custom image (container mode, skips auto-build)
  --mode <container|sandbox>       Override execution mode
  --run <command>                  Run a custom command instead of claude

Execution modes (set via agt.toml):
  container                        Run inside an Apple container (default)
  sandbox                          Run via sandbox-exec (macOS seatbelt)

Config file (agt.toml) is loaded from ./agt.toml or ~/.config/agt/config.toml:
  [execution]
  mode = "sandbox"   # or "container"

Examples:
  agt start my-feature
  agt enter my-feature
  agt start my-feature --image my-custom-image
  agt start my-feature --run codex
  agt build ./Dockerfile
  agt build --image my-tag ./path/to/Dockerfile
`);
  process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) usage();

const spec = COMMANDS[cmd];
if (!spec) { red(`Unknown command: ${cmd}`); usage(); }
if (spec.min && rest.length < spec.min) fatal(`Usage: ${spec.usage}`);

const agt = new Agt();

switch (cmd) {
  case "start":       await agt.cmdStart(rest); break;
  case "enter":       await agt.cmdEnter(rest); break;
  case "list": case "ls": await agt.cmdList(); break;
  case "stop":        await agt.cmdStop(rest[0]); break;
  case "clean":       await agt.cmdClean(rest[0]); break;
  case "build": {
    const args = [...rest];
    let tag = DEFAULT_IMAGE, file = null;
    while (args.length) {
      const a = args.shift();
      a === "--image" ? tag = args.shift() : file = a;
    }
    file ??= await resolveImage();
    if (!file) fatal(`Usage: ${spec.usage}`);
    await agt.cmdBuild(tag, file);
    break;
  }
}
