// Shared constants, helpers, and utilities used across agt-js modules.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname } from "path";
import { homedir } from "os";
import { parse as parseToml } from "smol-toml";
import pc from "picocolors";
import { $ } from "bun";

export const HOME = homedir();
export const AGT_DIR = dirname(new URL(import.meta.url).pathname);
export const DEFAULT_IMAGE = "agt-sandbox";

export function fatal(msg) { console.error(pc.red(msg)); process.exit(1); }

export async function gitRoot() {
  const r = await $`git rev-parse --show-toplevel`.nothrow().quiet();
  return r.exitCode === 0 ? r.text().trim() : null;
}

export function readJson(path, fallback = {}) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { return fallback; }
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

export function loadToml(file) {
  try { return parseToml(readFileSync(file, "utf8")); }
  catch { return null; }
}
