// Container lifecycle — image builds, container management, and execution.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";

import { parse as parseToml } from "smol-toml";

import { colorizeBuildLine } from "./cli.js";
import { debug } from "./debug.js";
import { gitRoot } from "./git.js";

function loadDefaults() {
	try {
		return parseToml(readFileSync(join(AGT_DIR, "defaults.toml"), "utf8"));
	} catch {
		return {};
	}
}

const HOME = homedir();
const AGT_DIR = dirname(dirname(new URL(import.meta.url).pathname));
export const DEFAULT_IMAGE = "agt-sandbox";

function envFlags(envVars) {
	return Object.entries(envVars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

// --- helpers ---

export function containerName(branch) {
	return `agt-${branch.replaceAll("/", "-")}`;
}

export function projectImageName(projectDir) {
	const shortHash = createHash("sha256")
		.update(projectDir)
		.digest("hex")
		.slice(0, 8);
	return `agt-${basename(projectDir)}-${shortHash}`;
}

// --- images ---

export function baseDockerfile() {
	const f = join(AGT_DIR, "Dockerfile");
	return existsSync(f) ? f : null;
}

export async function projectDockerfile() {
	const root = await gitRoot();
	if (!root) return null;
	return (
		[join(root, "Dockerfile.agt"), join(root, "agt.Dockerfile")].find(
			existsSync,
		) ?? null
	);
}

export function configHash(files) {
	const h = createHash("sha256");
	for (const f of files) {
		try {
			h.update(readFileSync(f));
		} catch {}
	}
	return h.digest("hex").slice(0, 16);
}

async function imageConfigHash(image) {
	const r = await $`container image inspect ${image}`.nothrow().quiet();
	if (r.exitCode !== 0) return null;
	try {
		const info = JSON.parse(r.text().trim());
		return (
			info?.[0]?.variants?.[0]?.config?.config?.Labels?.["agt.config-hash"] ??
			null
		);
	} catch {
		return null;
	}
}

export async function buildImage(tag, dockerfile, hash) {
	if (!existsSync(dockerfile))
		throw new Error(`Dockerfile not found at ${dockerfile}`);
	await $`container system start`.nothrow().quiet();
	const labelArgs = hash ? ["--label", `agt.config-hash=${hash}`] : [];
	const args = [
		"container",
		"build",
		"--progress",
		"plain",
		"--tag",
		tag,
		...labelArgs,
		"--file",
		dockerfile,
		dirname(dockerfile),
	];

	const proc = Bun.spawn(args, {
		stdout: "pipe",
		stderr: "pipe",
	});

	async function streamLines(reader) {
		let buf = "";
		for await (const chunk of reader) {
			buf += new TextDecoder().decode(chunk);
			const lines = buf.split("\n");
			buf = lines.pop();
			for (const line of lines) {
				if (line) console.error(colorizeBuildLine(line));
			}
		}
		if (buf) console.error(colorizeBuildLine(buf));
	}

	await Promise.all([streamLines(proc.stdout), streamLines(proc.stderr)]);
	const exitCode = await proc.exited;
	if (exitCode !== 0)
		throw new Error(`container build failed (exit ${exitCode})`);
}

// Returns true if image needs to be (re)built due to config change or missing image.
// Warns if state will be lost due to Dockerfile change.
export async function checkImageFresh(image, configFiles) {
	const hash = configHash(configFiles);
	const existingHash = await imageConfigHash(image);
	if (existingHash === null)
		return { needsBuild: true, hash, stateWillBeLost: false };
	if (existingHash !== hash)
		return { needsBuild: true, hash, stateWillBeLost: true };
	return { needsBuild: false, hash, stateWillBeLost: false };
}

// --- mounts ---

export function setupMounts(containerKey, projectMiseTools = {}) {
	const cacheDir = join(HOME, ".agt", "cache");
	const mounts = [];
	const envVars = {};

	// Package download caches — shared across projects
	for (const sub of ["pnpm", "npm", "bun"]) {
		const dir = join(cacheDir, sub);
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o777);
		mounts.push([dir, `/cache/${sub}`]);
	}

	// mise tool cache — shared across all containers so installed tools persist
	const miseDir = join(cacheDir, "mise");
	mkdirSync(miseDir, { recursive: true });
	chmodSync(miseDir, 0o777);
	mounts.push([miseDir, "/cache/mise"]);

	// mise config — merge defaults + project tools, write fresh each run
	const defaults = loadDefaults();
	const mergedMiseTools = { ...defaults?.mise?.tools, ...projectMiseTools };
	if (Object.keys(mergedMiseTools).length > 0) {
		const tomlKey = (k) => (/^[a-zA-Z0-9_-]+$/.test(k) ? k : `"${k}"`);
		const toolLines = Object.entries(mergedMiseTools)
			.map(([k, v]) => `${tomlKey(k)} = "${v}"`)
			.join("\n");
		const miseConfigDir = join(HOME, ".agt", "home", containerKey, ".config", "mise");
		mkdirSync(miseConfigDir, { recursive: true });
		const miseConfigPath = join(miseConfigDir, "config.toml");
		writeFileSync(miseConfigPath, `[tools]\n${toolLines}\n`);
		mounts.push([miseConfigPath, "/home/agt/.config/mise/config.toml"]);
	}

	// COW mounts: claude, pi — config drives which files are copied, always refreshed from host
	for (const name of ["claude", "pi"]) {
		const hostDir = join(HOME, `.${name}`);
		if (!existsSync(hostDir)) continue;
		const branchDir = join(HOME, ".agt", "home", containerKey, `.${name}`);
		mkdirSync(branchDir, { recursive: true });
		const files = defaults?.[name]?.files;
		if (files) {
			for (const f of files) {
				const src = join(hostDir, f);
				const dst = join(branchDir, f);
				if (existsSync(src)) {
					const isDir = statSync(src).isDirectory();
					mkdirSync(isDir ? dst : dirname(dst), { recursive: true });
					debug(`rsync .${name}/${f}`);
					Bun.spawnSync(["rsync", "-rlt", "--no-perms", "--delete", isDir ? src + "/" : src, dst]);
				}
			}
		} else {
			debug(`rsync .${name}/`);
			Bun.spawnSync(["rsync", "-rlt", "--no-perms", "--delete", hostDir + "/", branchDir]);
		}
		// Override credentials file with live Keychain data if configured
		const keychainSvc = defaults?.[name]?.["keychain-credentials"];
		if (keychainSvc) {
			const r = Bun.spawnSync(
				["security", "find-generic-password", "-s", keychainSvc, "-w"],
				{ stdout: "pipe", stderr: "pipe" },
			);
			if (r.exitCode === 0 && r.stdout) {
				const dst = join(branchDir, ".credentials.json");
				writeFileSync(dst, r.stdout.toString().trim());
				chmodSync(dst, 0o600);
				debug(`keychain ${name}/.credentials.json`);
			}
		}
		mounts.push([branchDir, `/home/agt/.${name}`]);
	}

	// Home dotfiles — copied fresh each run, mounted individually
	const homeFiles = defaults?.home?.files ?? [];
	if (homeFiles.length) {
		const branchHomeDir = join(HOME, ".agt", "home", containerKey);
		mkdirSync(branchHomeDir, { recursive: true });
		for (const name of homeFiles) {
			const src = join(HOME, name);
			if (!existsSync(src)) continue;
			const dst = join(branchHomeDir, name);
			debug(`cp ${name}`);
			Bun.spawnSync(["cp", src, dst]);
			chmodSync(dst, 0o644);
			mounts.push([dst, `/home/agt/${name}`]);
		}
	}

	Object.assign(envVars, {
		PNPM_HOME: "/cache/pnpm",
		NPM_CONFIG_CACHE: "/cache/npm",
		BUN_INSTALL_CACHE_DIR: "/cache/bun",
		MISE_DATA_DIR: "/cache/mise",
		MISE_NOT_FOUND_AUTO_INSTALL: "1",
	});

	return { mounts, envVars };
}

// --- container lifecycle ---

async function _containerStatus(cname) {
	const r = await $`container inspect ${cname}`.nothrow().quiet();
	if (r.exitCode !== 0) return null;
	try {
		const info = JSON.parse(r.text().trim());
		return info?.[0]?.status ?? null;
	} catch {
		return null;
	}
}

export async function runContainer({
	cname,
	branch,
	projectImage,
	worktree,
	gitDir,
	mounts,
	envVars,
	cpus,
	memory,
	containerFlags = [],
	cmd,
}) {
	envVars.AGT_BRANCH = branch;

	const runArgs = [
		"container",
		"run",
		"-it",
		"--rm",
		"--name",
		cname,
		"--label",
		`agt.branch=${branch}`,
		"--cpus",
		cpus || process.env.AGT_CPUS || "2",
		"--memory",
		memory || process.env.AGT_MEMORY || "4G",
		"--user",
		"agt",
		"-v",
		`${worktree}:/work`,
	];
	if (gitDir) runArgs.push("-v", `${gitDir}:${gitDir}`);
	for (const [src, dst, mode] of mounts) {
		runArgs.push("-v", mode ? `${src}:${dst}:${mode}` : `${src}:${dst}`);
	}
	runArgs.push(...containerFlags);
	// Wrap relative commands in bash so the container's PATH (e.g. mise shims) is searched.
	const finalCmd = cmd[0].startsWith("/")
		? cmd
		: ["/bin/bash", "--login", "-c", 'exec "$@"', "--", ...cmd];
	runArgs.push(...envFlags(envVars), "-w", "/work", projectImage, ...finalCmd);

	const proc = Bun.spawn(runArgs, {
		stdio: ["inherit", "inherit", "inherit"],
	});

	const exitCode = await proc.exited;
	process.exit(exitCode);
}

// --- commands ---

export async function listContainers(projectImage) {
	const r = await $`container ls --all --format json`.nothrow().quiet();
	if (r.exitCode !== 0) return [];

	try {
		const all = JSON.parse(r.text().trim());
		return all
			.filter((c) => {
				const id = c.configuration?.id ?? "";
				const imgRef = c.configuration?.image?.reference ?? "";
				return id.startsWith("agt-") && imgRef.startsWith(`${projectImage}`);
			})
			.map((c) => ({
				branch:
					c.configuration?.labels?.["agt.branch"] ??
					c.configuration.id.replace(/^agt-/, ""),
				state: c.status ?? "unknown",
				memory: `${Math.round((c.configuration?.resources?.memoryInBytes ?? 0) / 1024 / 1024 / 1024)}G`,
				cpus: c.configuration?.resources?.cpus ?? "",
				started: c.startedDate
					? new Date((978307200 + c.startedDate) * 1000).toLocaleString()
					: "",
			}));
	} catch {
		return [];
	}
}

export async function cleanContainer(branch) {
	const cname = containerName(branch);
	await $`container stop ${cname}`.nothrow().quiet();
	await $`container rm ${cname}`.nothrow().quiet();
}
