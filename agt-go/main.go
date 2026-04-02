package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

const defaultImage = "agt-sandbox"

type command struct {
	min   int
	usage string
}

var commands = map[string]command{
	"start": {min: 1, usage: "agt start <branch> [prompt...]"},
	"enter": {min: 1, usage: "agt enter <branch>"},
	"build": {min: 0, usage: "agt build [--image tag] <dockerfile>"},
	"list":  {min: 0},
	"ls":    {min: 0},
	"stop":  {min: 1, usage: "agt stop <branch>"},
	"clean": {min: 1, usage: "agt clean <branch>"},
}

func main() {
	initPaths()
	loadConfig()

	if len(os.Args) < 2 {
		usage()
	}

	cmd := os.Args[1]
	rest := os.Args[2:]

	spec, ok := commands[cmd]
	if !ok {
		red("Unknown command: " + cmd)
		usage()
	}
	if len(rest) < spec.min {
		fatal("Usage: " + spec.usage)
	}

	switch cmd {
	case "start":
		cmdStart(rest)
	case "enter":
		cmdEnter(rest)
	case "build":
		tag, file := parseBuildArgs(rest)
		cmdBuild(tag, file)
	case "list", "ls":
		cmdList()
	case "stop":
		cmdStop(rest[0])
	case "clean":
		cmdClean(rest[0])
	}
}

// --- commands ---

func cmdStart(args []string) {
	e := &Env{}
	e.Setup(args)

	claudeArgs := []string{"claude", "--dangerously-skip-permissions", "--channels", "plugin:telegram@claude-plugins-official"}

	sessionsDir := filepath.Join(e.ConfigDir, "sessions")
	if dirExists(filepath.Join(e.ConfigDir, "projects")) && dirExists(sessionsDir) {
		if entries, err := os.ReadDir(sessionsDir); err == nil {
			for _, entry := range entries {
				if strings.HasSuffix(entry.Name(), ".json") {
					claudeArgs = append(claudeArgs, "--continue")
					break
				}
			}
		}
	}

	if len(e.Remaining) > 0 {
		claudeArgs = append(claudeArgs, "-p", strings.Join(e.Remaining, " "))
	}
	e.Run(claudeArgs)
}

func cmdEnter(args []string) {
	e := &Env{}
	e.Setup(args)
	e.Run([]string{"zsh"})
}

func cmdBuild(tag, dockerfile string) {
	if !fileExists(dockerfile) {
		fatal("Dockerfile not found at " + dockerfile)
	}
	bold(fmt.Sprintf("Building %s from %s...", tag, dockerfile))
	sh("container", "build", "--tag", tag, "--file", dockerfile, filepath.Dir(dockerfile))
	green("Image " + tag + " built successfully")
}

func cmdList() {
	out, ok := capture("container", "ls", "--all")
	if !ok {
		fmt.Println("No agt containers found")
		return
	}
	found := false
	for _, line := range strings.Split(out, "\n") {
		if strings.HasPrefix(line, "ID") || strings.HasPrefix(line, "agt-") {
			fmt.Println(line)
			found = true
		}
	}
	if !found {
		fmt.Println("No agt containers found")
	}
}

func cmdStop(branch string) {
	cname := containerName(branch)
	bold("Stopping " + cname + "...")
	sh("container", "stop", cname)
	green("Stopped " + cname)
}

func cmdClean(branch string) {
	root := gitRoot()
	if root == "" {
		fatal("Not inside a git repository")
	}
	wt := filepath.Join(root, ".worktrees", branch)
	cname := containerName(branch)

	if _, ok := capture("container", "stop", cname); ok {
		yellow("Stopped container " + cname)
	}
	if _, ok := capture("container", "rm", cname); ok {
		yellow("Removed container " + cname)
	}
	if dirExists(wt) {
		sh("git", "-C", root, "worktree", "remove", wt, "--force")
		green("Removed worktree at " + wt)
	}
	green("Cleaned up " + branch)
}

func parseBuildArgs(args []string) (string, string) {
	tag := defaultImage
	file := ""
	for i := 0; i < len(args); i++ {
		if args[i] == "--image" && i+1 < len(args) {
			i++
			tag = args[i]
		} else {
			file = args[i]
		}
	}
	if file == "" {
		file = resolveImage()
	}
	if file == "" {
		fatal("Usage: " + commands["build"].usage)
	}
	return tag, file
}

func usage() {
	fmt.Print(`agt — sandboxed AI agent development tool

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

`)
	os.Exit(1)
}
