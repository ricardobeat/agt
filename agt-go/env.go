package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// Env holds all state for an agt session.
type Env struct {
	Mode         string
	Image        string
	Branch       string
	Remaining    []string
	Cname        string
	Worktree     string
	GitRoot      string
	GitDir       string
	Vars         map[string]string
	Mounts       [][2]string
	ConfigDir    string
	modeOverride bool
}

// Setup parses flags, creates the worktree, and prepares the execution environment.
func (e *Env) Setup(args []string) {
	e.Mode = agtMode
	e.Image = defaultImage
	e.Vars = map[string]string{}

	e.parseFlags(args)
	e.Cname = containerName(e.Branch)
	e.Vars["AGT_NAME"] = e.Cname

	if e.Mode == "container" {
		e.ensureImage()
	}
	e.setupWorktree()
	e.setupClaudeConfig()
	e.setupAuth()
	e.setupMounts()
}

// Run hands off to the appropriate executor.
func (e *Env) Run(cmdArgs []string) {
	if e.Mode == "sandbox" {
		e.execSandbox(cmdArgs)
	} else {
		e.ensureContainer()
		e.execContainer(cmdArgs)
	}
}

// envFlags returns ["-e", "K=V", "-e", "K=V", ...] for container commands.
func (e *Env) envFlags() []string {
	out := make([]string, 0, len(e.Vars)*2)
	for k, v := range e.Vars {
		out = append(out, "-e", k+"="+v)
	}
	return out
}

// envArgs returns ["K=V", "K=V", ...] for sandbox-exec / env commands.
func (e *Env) envArgs() []string {
	out := make([]string, 0, len(e.Vars))
	for k, v := range e.Vars {
		out = append(out, k+"="+v)
	}
	return out
}

// --- private setup steps ---

func (e *Env) parseFlags(args []string) {
	var remaining []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--image":
			i++
			e.Image = args[i]
		case "--mode":
			i++
			e.Mode = args[i]
			e.modeOverride = true
		default:
			remaining = append(remaining, args[i])
		}
	}
	if len(remaining) == 0 {
		fatal("branch name required")
	}
	e.Branch = remaining[0]
	e.Remaining = remaining[1:]
}

func (e *Env) ensureImage() {
	if imageExists(e.Image) {
		return
	}
	if e.Image != defaultImage {
		fatal(fmt.Sprintf("Image '%s' not found. Build it first or check the name.", e.Image))
	}
	dockerfile := resolveImage()
	if dockerfile == "" {
		fatal(fmt.Sprintf("No image '%s' found and no Dockerfile to build one.", e.Image))
	}
	yellow("Image not found, building from " + dockerfile + "...")
	cmdBuild(e.Image, dockerfile)
}

func (e *Env) setupWorktree() {
	root := gitRoot()
	if root == "" {
		e.Worktree, _ = os.Getwd()
		bold("Using current directory as workspace")
		return
	}

	e.Worktree = filepath.Join(root, ".worktrees", e.Branch)
	e.GitRoot = root
	e.GitDir = filepath.Join(root, ".git")

	if dirExists(e.Worktree) {
		yellow("Worktree already exists at " + e.Worktree)
		if e.modeOverride {
			saveMode(e.Worktree, e.Mode)
		} else if saved := recallMode(e.Worktree); saved != "" {
			e.Mode = saved
		}
	} else {
		bold(fmt.Sprintf("Creating worktree for branch '%s'...", e.Branch))
		if !try("git", "-C", root, "worktree", "add", e.Worktree, "-b", e.Branch) {
			sh("git", "-C", root, "worktree", "add", e.Worktree, e.Branch)
		}
		green("Worktree created at " + e.Worktree)
		saveMode(e.Worktree, e.Mode)
	}

	e.copyEnvFiles(root)
}

func (e *Env) copyEnvFiles(root string) {
	out, ok := capture("git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard")
	if !ok {
		return
	}
	for _, relpath := range strings.Split(out, "\n") {
		if relpath == "" || !strings.Contains(relpath, ".env") {
			continue
		}
		src := filepath.Join(root, relpath)
		if !fileExists(src) {
			continue
		}
		dest := filepath.Join(e.Worktree, filepath.Dir(relpath))
		os.MkdirAll(dest, 0o755)
		copyFile(src, filepath.Join(dest, filepath.Base(relpath)))
	}
}

func (e *Env) setupClaudeConfig() {
	e.ConfigDir = filepath.Join(home, ".agt", "claude-config")
	os.MkdirAll(e.ConfigDir, 0o755)

	e.initAgtSettings()
	e.rsyncClaudeDir()

	copyFile(filepath.Join(agtDir, "claude.json"), filepath.Join(e.ConfigDir, ".claude.json"))
	copyFile(agtSettingsPath(), filepath.Join(e.ConfigDir, "settings.json"))
}

func agtSettingsPath() string {
	return filepath.Join(home, ".agt", ".claude", "settings.json")
}

func (e *Env) initAgtSettings() {
	path := agtSettingsPath()
	if fileExists(path) {
		return
	}
	os.MkdirAll(filepath.Dir(path), 0o755)

	hostPath := filepath.Join(home, ".claude", "settings.json")
	settings := readJSON(hostPath) // returns empty map if missing
	sandbox, ok := settings["sandbox"].(map[string]any)
	if !ok {
		sandbox = map[string]any{}
	}
	sandbox["enabled"] = false
	settings["sandbox"] = sandbox
	writeJSON(path, settings)
	green("Created agt Claude settings at " + path)
}

func (e *Env) rsyncClaudeDir() {
	src := filepath.Join(home, ".claude")
	if !dirExists(src) {
		return
	}
	excludes := []string{".credentials.json", "settings.json", "sessions", "history.jsonl", "todos", "statsig", "telemetry", "cache"}
	args := []string{"-a", "--delete"}
	for _, ex := range excludes {
		args = append(args, "--exclude", ex)
	}
	args = append(args, src+"/", e.ConfigDir+"/")
	sh("rsync", args...)
}

func (e *Env) setupAuth() {
	if key := os.Getenv("ANTHROPIC_API_KEY"); key != "" {
		e.Vars["ANTHROPIC_API_KEY"] = key
		return
	}
	creds, ok := capture("security", "find-generic-password", "-s", "Claude Code-credentials", "-w")
	if ok && creds != "" {
		path := filepath.Join(e.ConfigDir, ".credentials.json")
		os.WriteFile(path, []byte(creds), 0o600)
	} else {
		yellow("Warning: no API key or OAuth token found. Run 'claude' on the host to authenticate first.")
	}
}

func (e *Env) setupMounts() {
	if e.Mode == "container" {
		cacheDir := filepath.Join(home, ".agt", "cache")
		for _, sub := range []string{"pnpm", "npm", "bun", "mise"} {
			p := filepath.Join(cacheDir, sub)
			os.MkdirAll(p, 0o755)
			e.Mounts = append(e.Mounts, [2]string{p, "/cache/" + sub})
		}
		e.Mounts = append(e.Mounts, [2]string{e.ConfigDir, e.ConfigDir})
		for k, v := range map[string]string{
			"npm_config_store_dir":    "/cache/pnpm",
			"NPM_CONFIG_CACHE":        "/cache/npm",
			"BUN_INSTALL_CACHE_DIR":    "/cache/bun",
			"MISE_DATA_DIR":            "/cache/mise",
			"CLAUDE_CONFIG_DIR":        e.ConfigDir,
		} {
			e.Vars[k] = v
		}
	} else {
		e.Vars["CLAUDE_CONFIG_DIR"] = e.ConfigDir
	}
}

// --- shared helpers ---

func containerName(branch string) string {
	return "agt-" + strings.ReplaceAll(branch, "/", "-")
}

func gitRoot() string {
	out, ok := capture("git", "rev-parse", "--show-toplevel")
	if !ok {
		return ""
	}
	return out
}

func resolveImage() string {
	root := gitRoot()
	candidates := []string{
		filepath.Join(root, "Dockerfile.agt"),
		filepath.Join(agtDir, "Dockerfile"),
	}
	for _, p := range candidates {
		if p != "" && fileExists(p) {
			return p
		}
	}
	return ""
}

func imageExists(name string) bool {
	out, ok := capture("container", "image", "list")
	return ok && strings.Contains(out, name)
}
