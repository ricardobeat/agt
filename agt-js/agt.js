#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import pc from "picocolors";
import { parse as parseToml } from "smol-toml";

const HOME = homedir();
const _AGT_DIR = dirname(dirname(new URL(import.meta.url).pathname));
const DEFAULT_IMAGE = "agt-sandbox";
function fatal(msg) {
	console.error(pc.red(msg));
	process.exit(1);
}

import { promptBranchName } from "./lib/cli.js";
import {
	baseDockerfile,
	branchImageName,
	buildImage,
	checkImageFresh,
	cleanContainer,
	containerName,
	listContainers,
	projectDockerfile,
	projectImageName,
	runContainer,
	setupMounts,
} from "./lib/container.js";
import {
	createWorktree,
	gitRoot,
	hasGitHistory,
	removeWorktree,
	worktreePath,
} from "./lib/git.js";
import { renderSandboxProfile } from "./lib/sandbox.js";

const MODES_FILE = join(HOME, ".agt", "modes.json");

// --- CLI ---

const COMMANDS = {
	start: { min: 0, usage: "agt start [branch] [prompt...]" },
	enter: { min: 0, usage: "agt enter [branch]" },
	build: { min: 0, usage: "agt build [--image tag] <dockerfile>" },
	list: { min: 0 },
	ls: { min: 0 },
	rm: { min: 1, usage: "agt rm <branch>" },
};

function usage() {
	console.log(`agt — sandboxed AI agent development tool

Usage:
  agt start [branch] [prompt...]   Create worktree + sandbox, run agent inside
  agt enter [branch]               Create worktree + sandbox, drop into a shell
  agt build [dockerfile]           Build container image (container mode only)
  agt list                         List running agt containers
  agt rm <branch>                  Remove worktree and container

Options:
  --image <name>                   Use a custom image (container mode, skips auto-build)
  --mode <container|sandbox>       Override execution mode

Execution modes (set via agt.toml):
  container                        Run inside an Apple container (default)
  sandbox                          Run via sandbox-exec (macOS seatbelt)

Config file (agt.toml) is loaded from ./agt.toml or ~/.config/agt/config.toml:
  [container]
  mode = "sandbox"          # or "container" (default)
  entrypoint = "claude"     # command to run inside the container
  cpus = 2                  # number of CPUs (default: 2)
  memory = "4G"             # memory limit (default: 4G)
  init-image = "my-image"   # base image (skips Dockerfile.agt)
  dns-domain = "local"      # default DNS domain
  volumes = ["/host/path:/container/path"]
  publish = ["8080:80"]     # host:container port mappings
  read-only = false         # mount root filesystem read-only

  [worktree]
  clone = [".secrets"]      # extra paths to clone into worktrees

Examples:
  agt start my-feature
  agt enter my-feature
  agt start my-feature --image my-custom-image
  agt build ./Dockerfile
  agt build --image my-tag ./path/to/Dockerfile
`);
	process.exit(1);
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) usage();

const spec = COMMANDS[cmd];
if (!spec) {
	console.error(pc.red(`Unknown command: ${cmd}`));
	usage();
}
if (spec.min && rest.length < spec.min) fatal(`Usage: ${spec.usage}`);

process.on("unhandledRejection", (err) => fatal(err?.message ?? String(err)));

switch (cmd) {
	case "start":
		await cmdStart(rest);
		break;
	case "enter":
		await cmdEnter(rest);
		break;
	case "list":
	case "ls": {
		const root = (await gitRoot()) ?? process.cwd();
		const containers = await listContainers(projectImageName(root));
		if (!containers.length) {
			console.log("No agt containers found");
			break;
		}
		for (const c of containers) {
			const state = c.state === "running" ? pc.green(c.state) : pc.dim(c.state);
			const branch = pc.bold(c.branch);
			const info = [state, `${c.cpus} cpus`, c.memory];
			if (c.started) info.push(c.started);
			console.log(`  ${branch}  ${info.join("  ")}`);
		}
		break;
	}
	case "rm":
		await cmdClean(rest[0]);
		break;
	case "build": {
		const args = [...rest];
		let tag = null,
			file = null;
		while (args.length) {
			const a = args.shift();
			if (a === "--image") tag = args.shift();
			else file = a;
		}
		file ??= baseDockerfile();
		tag ??= DEFAULT_IMAGE;
		if (!file) fatal(`Usage: ${spec.usage}`);
		const { hash } = await checkImageFresh(tag, [file]);
		console.log(pc.bold(`Building ${tag} from ${file}...`));
		await buildImage(tag, file, hash);
		console.log(pc.green(`Image ${tag} built successfully`));
		break;
	}
}

// --- setup pipeline ---

async function setup(args) {
	args = [...args];
	let modeOverride = false;

	const ctx = {
		mode: "container",
		projectImage: DEFAULT_IMAGE,
		imageOverride: false,
		envVars: {},
		mounts: [],
		containerFlags: [],
	};

	const file = ["./agt.toml", join(HOME, ".config", "agt", "config.toml")].find(
		existsSync,
	);
	if (file)
		try {
			const toml = parseToml(readFileSync(file, "utf8"));
			const container = toml?.container ?? {};

			ctx.mode = container.mode ?? ctx.mode;
			ctx.entrypoint = container.entrypoint;
			if (container.cpus) ctx.cpus = String(container.cpus);
			if (container.memory) ctx.memory = String(container.memory);
			if (container["init-image"]) ctx.projectImage = container["init-image"];
			if (container["read-only"]) ctx.containerFlags.push("--read-only");
			if (container["dns-domain"])
				ctx.containerFlags.push("--dns-domain", container["dns-domain"]);
			for (const v of [].concat(container.volumes ?? []))
				ctx.containerFlags.push("-v", v);
			for (const p of [].concat(container.publish ?? []))
				ctx.containerFlags.push("--publish", p);

			ctx.clonePaths = toml?.worktree?.clone ?? [];
		} catch {}

	while (args[0]?.startsWith("--")) {
		const flag = args.shift();
		if (flag === "--image") {
			ctx.projectImage = args.shift();
			ctx.imageOverride = true;
		} else if (flag === "--mode") {
			ctx.mode = args.shift();
			modeOverride = true;
		}
	}
	if (!args.length || !args[0] || args[0].startsWith("--")) {
		ctx.branch = await promptBranchName();
	} else {
		ctx.branch = args.shift();
	}
	ctx.remainingArgs = args;
	ctx.cname = containerName(ctx.branch);
	ctx.envVars.AGT_NAME = ctx.cname;

	if (ctx.mode === "container") {
		const root = await gitRoot();

		// Ensure base image is up to date
		const baseDf = baseDockerfile();
		if (baseDf) {
			const { needsBuild, hash } = await checkImageFresh(DEFAULT_IMAGE, [
				baseDf,
			]);
			if (needsBuild) {
				console.log(pc.yellow(`Building base image from ${baseDf}...`));
				await buildImage(DEFAULT_IMAGE, baseDf, hash);
				console.log(pc.green("Base image built successfully"));
			}
		}

		// Resolve project image
		if (!ctx.imageOverride) {
			ctx.projectImage = projectImageName(root ?? process.cwd());
		}
		const projectDf = await projectDockerfile();
		if (projectDf) {
			const configFiles = [projectDf, file].filter(Boolean);
			const { needsBuild, hash, stateWillBeLost } = await checkImageFresh(
				ctx.projectImage,
				configFiles,
			);
			if (needsBuild) {
				if (stateWillBeLost) {
					console.log(
						pc.yellow(
							"Warning: Dockerfile changed — rebuilding image. All container state will be lost.",
						),
					);
				}
				console.log(pc.yellow(`Building image from ${projectDf}...`));
				await buildImage(ctx.projectImage, projectDf, hash);
				console.log(pc.green(`Image ${ctx.projectImage} built successfully`));
			}
		} else if (!ctx.imageOverride) {
			// No project Dockerfile — use the base image directly
			ctx.projectImage = DEFAULT_IMAGE;
		}

		ctx.branchImage = branchImageName(root ?? process.cwd(), ctx.branch);
	}

	await setupWorktree(ctx, modeOverride);

	if (ctx.mode === "container") {
		const m = setupMounts(`${ctx.projectImage}-${ctx.branch}`);
		ctx.mounts = m.mounts;
		Object.assign(ctx.envVars, m.envVars);
	}

	return ctx;
}

async function run(ctx, cmd) {
	if (ctx.mode === "sandbox") execSandbox(ctx, cmd);
	else {
		console.log(pc.bold(`Starting container ${ctx.cname}...`));
		await runContainer({ ...ctx, cmd });
	}
}

// --- setup steps ---

async function setupWorktree(ctx, modeOverride) {
	const root = await gitRoot();
	if (!root || !(await hasGitHistory(root))) {
		ctx.worktree = process.cwd();
		ctx.gitRootPath = ctx.gitDir = null;
		console.log(pc.bold("Using current directory as workspace"));
		return;
	}

	ctx.gitRootPath = root;
	ctx.gitDir = join(root, ".git");

	let result;
	try {
		result = await createWorktree(root, ctx.branch, ctx.clonePaths);
	} catch (e) {
		fatal(e.message);
	}

	ctx.worktree = result.path;

	const modes = (() => {
		try {
			return JSON.parse(readFileSync(MODES_FILE, "utf8"));
		} catch {
			return {};
		}
	})();
	if (result.existed) {
		console.log(pc.yellow(`Worktree already exists at ${ctx.worktree}`));
		if (modeOverride)
			writeFileSync(
				MODES_FILE,
				JSON.stringify({ ...modes, [ctx.worktree]: ctx.mode }, null, 2),
			);
		else ctx.mode = modes[ctx.worktree] ?? ctx.mode;
	} else {
		console.log(pc.green(`Worktree created at ${ctx.worktree}`));
		mkdirSync(dirname(MODES_FILE), { recursive: true });
		writeFileSync(
			MODES_FILE,
			JSON.stringify({ ...modes, [ctx.worktree]: ctx.mode }, null, 2),
		);
	}
}

// --- sandbox execution ---

function execSandbox(ctx, cmd) {
	const profileFile = `/tmp/agt-sandbox.${process.pid}.sb`;
	writeFileSync(
		profileFile,
		renderSandboxProfile(ctx.worktree, ctx.gitRootPath),
	);

	console.log(
		pc.bold(`Starting sandbox for ${ctx.branch} in ${ctx.worktree}...`),
	);

	const zdotdir = `/tmp/agt-sandbox-zd.${process.pid}`;
	mkdirSync(zdotdir, { recursive: true });
	writeFileSync(
		join(zdotdir, ".zshrc"),
		`[[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\nPROMPT="%F{yellow}[sandbox]%f $PROMPT"\n`,
	);

	const envArgs = Object.entries(ctx.envVars).map(([k, v]) => `${k}=${v}`);
	const args = [
		"sandbox-exec",
		"-f",
		profileFile,
		"/usr/bin/env",
		"AGT_SANDBOX=1",
		`ZDOTDIR=${zdotdir}`,
		...envArgs,
		"/bin/zsh",
		"-c",
		`cd '${ctx.worktree}' && exec "$@"`,
		"--",
		...cmd,
	];
	const { exitCode } = Bun.spawnSync(args, {
		stdio: ["inherit", "inherit", "inherit"],
	});
	process.exit(exitCode);
}

// --- commands ---

async function cmdStart(args) {
	const ctx = await setup(args);
	const entry = ctx.entrypoint ?? "claude";
	const agentCmd =
		entry === "claude" ? ["claude", "--dangerously-skip-permissions"] : [entry];
	if (ctx.remainingArgs.length)
		agentCmd.push("-p", ctx.remainingArgs.join(" "));
	await run(ctx, agentCmd);
}

async function cmdEnter(args) {
	const ctx = await setup(args);
	await run(ctx, ["/bin/bash"]);
}

async function cmdClean(branch) {
	const root = (await gitRoot()) || fatal("Not inside a git repository");
	await cleanContainer(branch, branchImageName(root, branch));
	try {
		await removeWorktree(root, branch);
	} catch (e) {
		fatal(e.message);
	}
	console.log(pc.green(`Removed worktree at ${worktreePath(root, branch)}`));
	console.log(pc.green(`Cleaned up ${branch}`));
}
