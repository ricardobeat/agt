// Sandbox profile generation — allow-first model with targeted credential blocking.

import { readdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const HOME = homedir();

// Credential directories to always block
const PROTECTED_DIRS = [
	".ssh",
	".gnupg",
	".docker",
	".aws",
	".azure",
	".azd",
	".kube",
	".config/gcloud",
	".config/op",
	".1password",
	".zsh_sessions",
	"Library/Keychains",
	"Library/Accounts",
	"Library/Mail",
	"Library/Messages",
	"Library/Safari",
	"Library/Cookies",
	"Library/Finance",
	"Library/Calendars",
	"Library/Contacts",
	"Library/Photos",
];

// Credential files to always block
const PROTECTED_FILES = [
	".netrc",
	".git-credentials",
	".pypirc",
	".extra",
	".zsh_history",
	".bash_history",
	".sh_history",
];

// Shell init files — allow read (default), deny write
const SHELL_INIT_FILES = [
	".zshrc",
	".zprofile",
	".zshenv",
	".zlogin",
	".zlogout",
	".bashrc",
	".bash_profile",
	".bash_login",
	".bash_logout",
	".profile",
];

// Directories to skip when scanning for siblings (expensive or already handled)
const SCAN_SKIP = new Set(["node_modules", "Library", ".Trash"]);

// Walk from worktree up to $HOME, collecting non-dot sibling directories at each level.
// These are "other projects" and user data dirs that the agent should not access.
function collectSiblings(worktree, gitRoot) {
	const blocked = [];
	const seen = new Set();

	let current = worktree;
	while (true) {
		const parent = dirname(current);
		if (parent === current) break;
		// Stop once we've processed $HOME itself; don't go above it
		if (parent !== HOME && !parent.startsWith(HOME + "/")) break;

		try {
			for (const entry of readdirSync(parent, { withFileTypes: true })) {
				if (!entry.isDirectory()) continue;
				if (entry.name.startsWith(".")) continue; // dotdirs handled by PROTECTED_DIRS
				if (SCAN_SKIP.has(entry.name)) continue;

				const fullPath = join(parent, entry.name);
				if (seen.has(fullPath)) continue;
				seen.add(fullPath);

				if (fullPath === current) continue;
				// Don't block ancestors of the worktree or git root
				if (worktree.startsWith(fullPath + "/") || fullPath === worktree) continue;
				if (gitRoot && (gitRoot.startsWith(fullPath + "/") || fullPath === gitRoot)) continue;

				blocked.push(fullPath);
			}
		} catch {}

		if (parent === HOME) break;
		current = parent;
	}

	return blocked.sort();
}

// Generate a macOS sandbox-exec SBPL profile.
//
// Uses allow-first: (allow default) then deny specific sensitive paths.
// This avoids having to enumerate every tool/cache path the agent might need,
// and ensures credentials are protected even if new paths are added to $HOME.
//
// options.extraDenyPaths: additional paths to deny, from agt.toml [sandbox] deny = [...]
export function renderSandboxProfile(worktree, gitRoot, options = {}) {
	const { extraDenyPaths = [] } = options;
	const lines = ["(version 1)", "(allow default)", ""];

	// Shell init files: readable, not writable
	const initFiles = SHELL_INIT_FILES.map((f) => join(HOME, f)).filter(existsSync);
	if (initFiles.length) {
		lines.push("; shell init files are read-only");
		lines.push("(deny file-write*");
		for (const f of initFiles) lines.push(`  (literal "${f}")`);
		lines.push(")", "");
	}

	// Credential directories and files
	const credDirs = PROTECTED_DIRS.map((d) => join(HOME, d)).filter(existsSync);
	const credFiles = PROTECTED_FILES.map((f) => join(HOME, f)).filter(existsSync);
	if (credDirs.length || credFiles.length) {
		lines.push("; credentials — read and write blocked");
		lines.push("(deny file*");
		for (const d of credDirs) lines.push(`  (subpath "${d}")`);
		for (const f of credFiles) lines.push(`  (literal "${f}")`);
		lines.push(")", "");
	}

	// Block sibling directories — other projects and user data dirs within $HOME
	const siblings = collectSiblings(worktree, gitRoot);
	if (siblings.length) {
		lines.push("; other projects and user data directories");
		lines.push("(deny file*");
		for (const s of siblings) lines.push(`  (subpath "${s}")`);
		lines.push(")", "");
	}

	// Custom deny rules from agt.toml [sandbox] deny = [...]
	if (extraDenyPaths.length) {
		const resolved = extraDenyPaths.map((p) =>
			p.startsWith("~/") ? join(HOME, p.slice(2)) : p,
		);
		lines.push("; custom deny rules from agt.toml");
		lines.push("(deny file*");
		for (const p of resolved) lines.push(`  (subpath "${p}")`);
		lines.push(")", "");
	}

	return lines.join("\n") + "\n";
}
