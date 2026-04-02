#!/usr/bin/env bun

import pc from "picocolors";
import Agt, { DEFAULT_IMAGE, resolveImage } from "./agt.js";
import { buildImage, listContainers, stopContainer } from "./container.js";
import { fatal } from "./shared.js";

const COMMANDS = {
  start: { min: 1, usage: "agt start <branch> [prompt...]" },
  enter: { min: 1, usage: "agt enter <branch>" },
  build: { min: 0, usage: "agt build [--image tag] <dockerfile>" },
  list:  { min: 0 },
  ls:    { min: 0 },
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
  agt build ./Dockerfile
  agt build --image my-tag ./path/to/Dockerfile
`);
  process.exit(1);
}

// --- dispatch ---

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) usage();

const spec = COMMANDS[cmd];
if (!spec) {
  console.error(pc.red(`Unknown command: ${cmd}`));
  usage();
}
if (spec.min && rest.length < spec.min) fatal(`Usage: ${spec.usage}`);

const agt = new Agt();

switch (cmd) {
  case "start":
    await agt.cmdStart(rest);
    break;
  case "enter":
    await agt.cmdEnter(rest);
    break;
  case "list":
  case "ls":
    await listContainers();
    break;
  case "stop":
    await stopContainer(rest[0]);
    break;
  case "clean":
    await agt.cmdClean(rest[0]);
    break;
  case "build": {
    const args = [...rest];
    let tag = DEFAULT_IMAGE, file = null;
    while (args.length) {
      const a = args.shift();
      a === "--image" ? (tag = args.shift()) : (file = a);
    }
    file ??= await resolveImage();
    if (!file) fatal(`Usage: ${spec.usage}`);
    await buildImage(tag, file);
    break;
  }
}
