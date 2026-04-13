// Git utilities and worktree management.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { $ } from "bun";

export async function gitRoot() {
	const r = await $`git rev-parse --show-toplevel`.nothrow().quiet();
	return r.exitCode === 0 ? r.text().trim() : null;
}

export async function hasGitHistory(root) {
	const r = await $`git -C ${root} rev-parse HEAD`.nothrow().quiet();
	return r.exitCode === 0;
}

export function worktreePath(root, branch) {
	return join(root, ".worktrees", branch);
}

/** Create worktree for branch (creates branch if needed). Returns path. */
export async function createWorktree(root, branch, extraClonePaths = []) {
	const path = worktreePath(root, branch);
	if (existsSync(path)) return { path, existed: true };

	const r = await $`git -C ${root} worktree add ${path} -b ${branch}`
		.nothrow()
		.quiet();
	if (r.exitCode !== 0) {
		const r2 = await $`git -C ${root} worktree add ${path} ${branch}`.nothrow();
		if (r2.exitCode !== 0) throw new Error("git worktree add failed");
	}

	await cloneUntracked(root, path, extraClonePaths);
	return { path, existed: false };
}

/** Remove worktree for branch. */
export async function removeWorktree(root, branch) {
	const path = worktreePath(root, branch);
	if (!existsSync(path)) return;
	const r = await $`git -C ${root} worktree remove ${path} --force`.nothrow();
	if (r.exitCode !== 0) throw new Error("git worktree remove failed");
}

/** List worktrees (excluding the main one). */
export async function listWorktrees(root) {
	const r = await $`git -C ${root} worktree list --porcelain`.nothrow().quiet();
	if (r.exitCode !== 0) return [];

	const worktrees = [];
	let current = {};
	for (const line of r.text().trim().split("\n")) {
		if (line.startsWith("worktree ")) {
			current = { path: line.slice(9) };
		} else if (line.startsWith("branch refs/heads/")) {
			current.branch = line.slice(18);
		} else if (line === "") {
			if (current.branch && current.path !== root) worktrees.push(current);
			current = {};
		}
	}
	if (current.branch && current.path !== root) worktrees.push(current);
	return worktrees;
}

/** Clone untracked files/directories into worktree using APFS copy-on-write. */
async function cloneUntracked(root, worktree, extraPaths = []) {
	const topLevel = new Set();

	// Always include agent harness directories
	const harnessDirs = [
		".env",
		".claude",
		".gemini",
		".codex",
		".opencode",
		".vibe",
		".pi",
	];
	for (const dir of harnessDirs) {
		topLevel.add(dir);
	}

	// Get all untracked files that aren't gitignored
	const r = await $`git -C ${root} ls-files --others --exclude-standard`
		.nothrow()
		.quiet();
	if (r.exitCode === 0) {
		const untracked = r
			.text()
			.trim()
			.split("\n")
			.filter((line) => line);

		for (const path of untracked) {
			const parts = path.split("/");
			topLevel.add(parts[0]);
		}
	}

	// Include any extra paths from config
	for (const extra of extraPaths) {
		topLevel.add(extra.startsWith("./") ? extra.slice(2) : extra);
	}

	// Clone each top-level entry
	for (const entry of topLevel) {
		const src = join(root, entry);
		if (!existsSync(src)) continue;
		await $`cp -c -R ${src} ${join(worktree, entry)}`.nothrow().quiet();
	}
}
