// Container lifecycle — image builds, container management, and execution.

import { existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import pc from "picocolors";
import { $ } from "bun";

import { HOME, AGT_DIR, DEFAULT_IMAGE, fatal, gitRoot } from "./shared.js";

function envFlags(envVars) {
  return Object.entries(envVars).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
}

// --- helpers ---

export function containerName(branch) {
  return "agt-" + branch.replaceAll("/", "-");
}

// --- images ---

export async function resolveImage() {
  const root = await gitRoot();
  return (
    [root && join(root, "Dockerfile.agt"), join(AGT_DIR, "Dockerfile")]
      .filter(Boolean)
      .find(existsSync) ?? null
  );
}

export async function ensureImage(image) {
  const r = await $`container image list --format json`.nothrow().quiet();
  if (r.exitCode === 0) {
    const images = JSON.parse(r.text().trim());
    if (images.some((i) => i.names?.some((n) => n.startsWith(image + ":")))) return;
  }
  if (image !== DEFAULT_IMAGE) fatal(`Image '${image}' not found.`);
  const dockerfile = await resolveImage();
  if (!dockerfile) fatal(`No image '${image}' found and no Dockerfile to build one.`);
  console.log(pc.yellow(`Image not found, building from ${dockerfile}...`));
  await buildImage(image, dockerfile);
}

export async function buildImage(tag, dockerfile) {
  if (!existsSync(dockerfile)) fatal(`Dockerfile not found at ${dockerfile}`);
  console.log(pc.bold(`Building ${tag} from ${dockerfile}...`));
  try { await $`container build --tag ${tag} --file ${dockerfile} ${dirname(dockerfile)}`; }
  catch { fatal(`container build failed`); }
  console.log(pc.green(`Image ${tag} built successfully`));
}

// --- mounts ---

export function setupMounts(configDir) {
  const cacheDir = join(HOME, ".agt", "cache");
  const mounts = [];
  const envVars = {};

  for (const sub of ["pnpm", "npm", "bun", "mise"]) {
    mkdirSync(join(cacheDir, sub), { recursive: true });
    mounts.push([join(cacheDir, sub), `/cache/${sub}`]);
  }
  mounts.push([configDir, configDir]);

  Object.assign(envVars, {
    npm_config_store_dir: "/cache/pnpm",
    NPM_CONFIG_CACHE: "/cache/npm",
    BUN_INSTALL_CACHE_DIR: "/cache/bun",
    MISE_DATA_DIR: "/cache/mise",
    CLAUDE_CONFIG_DIR: configDir,
  });

  return { mounts, envVars };
}

// --- container lifecycle ---

async function containerState(cname) {
  const r = await $`container ls --all --format json`.nothrow().quiet();
  if (r.exitCode !== 0) return null;
  try {
    const c = JSON.parse(r.text().trim()).find((c) => c.configuration?.id === cname);
    return c?.status ?? null;
  } catch {
    return null;
  }
}

export async function ensureContainer({ cname, worktree, gitDir, mounts, envVars, image }) {
  const state = await containerState(cname);

  if (!state) {
    console.log(pc.bold(`Creating container ${cname}...`));
    const args = [
      "container", "run", "-d", "--name", cname,
      "--cpus", process.env.AGT_CPUS || "4",
      "--memory", process.env.AGT_MEMORY || "4G",
      "-v", `${worktree}:/work`,
    ];
    if (gitDir) args.push("-v", `${gitDir}:${gitDir}`);
    for (const [src, dst] of mounts) args.push("-v", `${src}:${dst}`);
    args.push(...envFlags(envVars), "-w", "/work", image, "sleep", "infinity");
    try { await $`${args}`; }
    catch { fatal(`container run failed`); }
    console.log(pc.green(`Container ${cname} created`));
  } else if (state === "stopped") {
    console.log(pc.bold(`Restarting container ${cname}...`));
    try { await $`container start ${cname}`; }
    catch { fatal(`container start failed`); }
    console.log(pc.green(`Container ${cname} restarted`));
  } else {
    console.log(pc.yellow(`Container ${cname} already running`));
  }

  for (let i = 0; i < 30; i++) {
    if ((await $`container exec ${cname} true`.nothrow().quiet()).exitCode === 0) return;
    await Bun.sleep(200);
  }
  fatal("Container failed to become ready");
}

export function execContainer(cmd, { cname, envVars }) {
  const args = ["container", "exec", "-it", "-w", "/work", ...envFlags(envVars), cname, ...cmd];
  const { exitCode } = Bun.spawnSync(args, { stdio: ["inherit", "inherit", "inherit"] });
  process.exit(exitCode);
}

// --- commands ---

export async function listContainers() {
  const r = await $`container ls --all`.nothrow().quiet();
  const lines = r.exitCode === 0
    ? r.text().trim().split("\n").filter((l) => l.startsWith("ID") || l.startsWith("agt-"))
    : [];
  lines.length ? lines.forEach((l) => console.log(l)) : console.log("No agt containers found");
}

export async function stopContainer(branch) {
  const cname = containerName(branch);
  console.log(pc.bold(`Stopping ${cname}...`));
  try { await $`container stop ${cname}`; }
  catch { fatal(`container stop failed`); }
  console.log(pc.green(`Stopped ${cname}`));
}

export async function cleanContainer(branch) {
  const cname = containerName(branch);
  if ((await $`container stop ${cname}`.nothrow().quiet()).exitCode === 0)
    console.log(pc.yellow(`Stopped container ${cname}`));
  if ((await $`container rm ${cname}`.nothrow().quiet()).exitCode === 0)
    console.log(pc.yellow(`Removed container ${cname}`));
}
