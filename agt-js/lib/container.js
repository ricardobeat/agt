// Container lifecycle — image builds, container management, and execution.

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { $ } from "bun";

import { colorizeBuildLine } from "./cli.js";
import { gitRoot } from "./git.js";

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

export function branchImageName(projectDir, branch) {
	return `${projectImageName(projectDir)}:${branch}`;
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

export function setupMounts(containerKey) {
	const cacheDir = join(HOME, ".agt", "cache");
	const mounts = [];
	const envVars = {};

	// Package download caches shared across projects (NOT /cache/mise — that's image state)
	for (const sub of ["pnpm", "npm", "bun"]) {
		const dir = join(cacheDir, sub);
		mkdirSync(dir, { recursive: true });
		chmodSync(dir, 0o777);
		mounts.push([dir, `/cache/${sub}`]);
	}

	// Claude config
	const claudeDir = join(HOME, ".claude");
	if (existsSync(claudeDir)) {
		mounts.push([claudeDir, "/home/agt/.claude", "ro"]);
	}

	// pi credentials — COW copy per branch so it's writable but host is untouched
	const hostPi = join(HOME, ".pi");
	if (existsSync(hostPi)) {
		const branchPi = join(HOME, ".agt", "home", containerKey, ".pi");
		if (!existsSync(branchPi)) {
			mkdirSync(dirname(branchPi), { recursive: true });
			Bun.spawnSync(["cp", "-c", "-R", hostPi, branchPi]);
		}
		mounts.push([branchPi, "/home/agt/.pi"]);
	}

	// Git config
	const gitconfig = join(HOME, ".gitconfig");
	if (existsSync(gitconfig)) {
		mounts.push([gitconfig, "/home/agt/.gitconfig", "ro"]);
	}

	Object.assign(envVars, {
		PNPM_HOME: "/cache/pnpm",
		NPM_CONFIG_CACHE: "/cache/npm",
		BUN_INSTALL_CACHE_DIR: "/cache/bun",
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
	branchImage,
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

	// Check if branch-specific image exists, otherwise use project base
	const imageExists = await $`container image inspect ${branchImage}`
		.nothrow()
		.quiet();
	const image = imageExists.exitCode === 0 ? branchImage : projectImage;

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
	runArgs.push(...envFlags(envVars), "-w", "/work", image, ...cmd);

	const { exitCode } = Bun.spawnSync(runArgs, {
		stdio: ["inherit", "inherit", "inherit"],
	});

	// Commit container state to branch-specific image
	await $`container commit ${cname} ${branchImage}`.nothrow().quiet();

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

export async function cleanContainer(branch, branchImage) {
	const cname = containerName(branch);
	await $`container stop ${cname}`.nothrow().quiet();
	await $`container rm ${cname}`.nothrow().quiet();
	if (branchImage) await $`container image rm ${branchImage}`.nothrow().quiet();
}
