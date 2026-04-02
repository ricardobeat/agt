package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

const defaultImage = "agt-sandbox"

// --- colors ---

func red(msg string)    { fmt.Fprintf(os.Stderr, "\033[31m%s\033[0m\n", msg) }
func green(msg string)  { fmt.Printf("\033[32m%s\033[0m\n", msg) }
func yellow(msg string) { fmt.Printf("\033[33m%s\033[0m\n", msg) }
func bold(msg string)   { fmt.Printf("\033[1m%s\033[0m\n", msg) }

func fatal(msg string) {
	red(msg)
	os.Exit(1)
}

// --- config ---

var (
	agtMode    = "container"
	agtDir     string
	home       string
	modesFile  string
)

func init() {
	home = os.Getenv("HOME")
	modesFile = filepath.Join(home, ".agt", "modes.json")

	// Resolve directory of the executable
	exe, err := os.Executable()
	if err == nil {
		exe, _ = filepath.EvalSymlinks(exe)
		agtDir = filepath.Dir(exe)
	} else {
		agtDir, _ = os.Getwd()
	}
}

// tomlGet reads a flat key like "execution.mode" from a TOML file.
func tomlGet(file, key string) string {
	parts := strings.SplitN(key, ".", 2)
	if len(parts) != 2 {
		return ""
	}
	section, field := parts[0], parts[1]

	f, err := os.Open(file)
	if err != nil {
		return ""
	}
	defer f.Close()

	inSection := false
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if strings.HasPrefix(line, "[") {
			inSection = line == "["+section+"]"
			continue
		}
		if inSection {
			if idx := strings.Index(line, "="); idx > 0 {
				k := strings.TrimSpace(line[:idx])
				if k == field {
					v := strings.TrimSpace(line[idx+1:])
					v = strings.Trim(v, `"'`)
					return v
				}
			}
		}
	}
	return ""
}

func loadConfig() {
	configFile := ""
	if fileExists("./agt.toml") {
		configFile = "./agt.toml"
	} else if fileExists(filepath.Join(home, ".config", "agt", "config.toml")) {
		configFile = filepath.Join(home, ".config", "agt", "config.toml")
	}
	if configFile != "" {
		if mode := tomlGet(configFile, "execution.mode"); mode != "" {
			agtMode = mode
		}
	}
}

// --- mode persistence ---

func loadModes() map[string]string {
	data, err := os.ReadFile(modesFile)
	if err != nil {
		return map[string]string{}
	}
	m := map[string]string{}
	json.Unmarshal(data, &m)
	return m
}

func saveMode(path, mode string) {
	m := loadModes()
	m[path] = mode
	os.MkdirAll(filepath.Dir(modesFile), 0o755)
	data, _ := json.MarshalIndent(m, "", "  ")
	os.WriteFile(modesFile, data, 0o644)
}

func recallMode(path string) string {
	return loadModes()[path]
}

// --- helpers ---

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func run(name string, args ...string) error {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}

func runSilent(name string, args ...string) (string, error) {
	out, err := exec.Command(name, args...).Output()
	return strings.TrimSpace(string(out)), err
}

func gitRoot() (string, error) {
	root, err := runSilent("git", "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("not inside a git repository")
	}
	return root, nil
}

func resolveImage() string {
	root, err := gitRoot()
	if err == nil {
		p := filepath.Join(root, "Dockerfile.agt")
		if fileExists(p) {
			return p
		}
	}
	p := filepath.Join(agtDir, "Dockerfile")
	if fileExists(p) {
		return p
	}
	return ""
}

func imageExists(name string) bool {
	out, err := runSilent("container", "image", "list")
	return err == nil && strings.Contains(out, name)
}

func containerName(branch string) string {
	return "agt-" + strings.ReplaceAll(branch, "/", "-")
}

// --- sandbox profile ---

func generateSandboxProfile(worktree, gitRoot string) string {
	gitRootLine, gitDirLine := "", ""
	if gitRoot != "" {
		gitRootLine = fmt.Sprintf("  (subpath %q)", gitRoot)
		gitDirLine = fmt.Sprintf("  (subpath %q)", filepath.Join(gitRoot, ".git"))
	}
	return fmt.Sprintf(`(version 1)
(deny default)

;; Process, IPC, mach, and system calls
(allow process*)
(allow signal)
(allow sysctl*)
(allow mach*)
(allow ipc*)
(allow file-ioctl)

;; Metadata and xattr reads
(allow file-read-metadata)
(allow file-read-xattr)

;; File content reads
(allow file-read-data
  (literal "/")
  (subpath "/Applications")
  (subpath "/usr")
  (subpath "/bin")
  (subpath "/sbin")
  (subpath "/cores")
  (subpath "/home")
  (subpath "/Library")
  (subpath "/System")
  (subpath "/private")
  (subpath "/dev")
  (subpath "/opt")
  (subpath "/tmp")
  (subpath "/var")
  (subpath "/Volumes")
  (subpath %q)
%s
  (regex #"^%s/\..*")
  (subpath "%s/Library"))

;; Writes
(allow file-write*
  (subpath "/dev")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath %q)
%s
  (subpath "%s/.agt")
  (subpath "%s/.local"))

;; Network and sockets
(allow network*)
(allow system-socket)
`, worktree, gitRootLine, home, home, worktree, gitDirLine, home, home)
}

// --- environment setup ---

type env struct {
	mode          string
	modeOverride  bool
	image         string
	branch        string
	remainingArgs []string
	cname         string
	worktree      string
	gitRoot       string
	gitDir        string
	envVars       []string // KEY=VALUE pairs
	mounts        [][2]string
	configDir     string
}

func setupEnv(args []string) *env {
	e := &env{
		mode:  agtMode,
		image: defaultImage,
	}

	// Parse flags
	var remaining []string
	for i := 0; i < len(args); i++ {
		switch args[i] {
		case "--image":
			i++
			if i < len(args) {
				e.image = args[i]
			}
		case "--mode":
			i++
			if i < len(args) {
				e.mode = args[i]
				e.modeOverride = true
			}
		default:
			remaining = append(remaining, args[i])
		}
	}

	if len(remaining) == 0 {
		fatal("branch name required")
	}
	e.branch = remaining[0]
	e.remainingArgs = remaining[1:]
	e.cname = containerName(e.branch)
	e.envVars = append(e.envVars, "AGT_NAME="+e.cname)

	// Ensure image (container mode)
	if e.mode == "container" && !imageExists(e.image) {
		if e.image == defaultImage {
			dockerfile := resolveImage()
			if dockerfile != "" {
				yellow("Image not found, building from " + dockerfile + "...")
				cmdBuild(e.image, dockerfile)
			} else {
				fatal("Error: no image '" + e.image + "' found and no Dockerfile available to build one.\nProvide a Dockerfile.agt in your repo root, or run: agt build <dockerfile>")
			}
		} else {
			fatal("Error: image '" + e.image + "' not found. Build it first or check the name.")
		}
	}

	// Worktree setup
	root, err := gitRoot()
	if err == nil {
		e.worktree = filepath.Join(root, ".worktrees", e.branch)
		e.gitRoot = root
		e.gitDir = filepath.Join(root, ".git")

		if !dirExists(e.worktree) {
			bold("Creating worktree for branch '" + e.branch + "'...")
			err := run("git", "-C", root, "worktree", "add", e.worktree, "-b", e.branch)
			if err != nil {
				run("git", "-C", root, "worktree", "add", e.worktree, e.branch)
			}
			green("Worktree created at " + e.worktree)
			saveMode(e.worktree, e.mode)
		} else {
			yellow("Worktree already exists at " + e.worktree)
			if e.modeOverride {
				saveMode(e.worktree, e.mode)
			} else if saved := recallMode(e.worktree); saved != "" {
				e.mode = saved
			}
		}

		// Copy .env files into worktree
		out, err := runSilent("git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard")
		if err == nil {
			for _, relpath := range strings.Split(out, "\n") {
				if relpath == "" || !strings.Contains(relpath, ".env") {
					continue
				}
				destDir := filepath.Join(e.worktree, filepath.Dir(relpath))
				os.MkdirAll(destDir, 0o755)
				src := filepath.Join(root, relpath)
				data, err := os.ReadFile(src)
				if err == nil {
					os.WriteFile(filepath.Join(destDir, filepath.Base(relpath)), data, 0o644)
				}
			}
		}
	} else {
		e.worktree, _ = os.Getwd()
		bold("Using current directory as workspace")
	}

	// Claude config
	e.configDir = filepath.Join(home, ".agt", "claude-config")
	os.MkdirAll(e.configDir, 0o755)

	// Shared agt Claude settings — initialized once, user can edit later
	agtSettings := filepath.Join(home, ".agt", ".claude", "settings.json")
	if !fileExists(agtSettings) {
		os.MkdirAll(filepath.Dir(agtSettings), 0o755)
		hostSettings := filepath.Join(home, ".claude", "settings.json")
		if fileExists(hostSettings) {
			data, _ := os.ReadFile(hostSettings)
			var settings map[string]any
			json.Unmarshal(data, &settings)
			if settings == nil {
				settings = map[string]any{}
			}
			sandbox, ok := settings["sandbox"].(map[string]any)
			if !ok {
				sandbox = map[string]any{}
			}
			sandbox["enabled"] = false
			settings["sandbox"] = sandbox
			out, _ := json.MarshalIndent(settings, "", "  ")
			os.WriteFile(agtSettings, out, 0o644)
		} else {
			os.WriteFile(agtSettings, []byte(`{"sandbox":{"enabled":false}}`), 0o644)
		}
		green("Created agt Claude settings at " + agtSettings)
	}

	// Rsync ~/.claude/ into config dir (excluding sensitive/ephemeral data)
	if dirExists(filepath.Join(home, ".claude")) {
		run("rsync", "-a", "--delete",
			"--exclude", ".credentials.json",
			"--exclude", "settings.json",
			"--exclude", "sessions",
			"--exclude", "history.jsonl",
			"--exclude", "todos",
			"--exclude", "statsig",
			"--exclude", "telemetry",
			"--exclude", "cache",
			filepath.Join(home, ".claude")+"/",
			e.configDir+"/",
		)
	}

	// Copy agt-specific config files
	copyFile(filepath.Join(agtDir, "claude.json"), filepath.Join(e.configDir, ".claude.json"))
	copyFile(agtSettings, filepath.Join(e.configDir, "settings.json"))

	// Auth
	apiKey := os.Getenv("ANTHROPIC_API_KEY")
	if apiKey != "" {
		e.envVars = append(e.envVars, "ANTHROPIC_API_KEY="+apiKey)
	} else {
		creds, err := runSilent("security", "find-generic-password", "-s", "Claude Code-credentials", "-w")
		if err == nil && creds != "" {
			credsPath := filepath.Join(e.configDir, ".credentials.json")
			os.WriteFile(credsPath, []byte(creds), 0o600)
		} else {
			yellow("Warning: no API key or OAuth token found. Run 'claude' on the host to authenticate first.")
		}
	}

	// Mode-specific setup
	if e.mode == "container" {
		cacheDir := filepath.Join(home, ".agt", "cache")
		for _, sub := range []string{"pnpm", "npm", "bun", "mise"} {
			os.MkdirAll(filepath.Join(cacheDir, sub), 0o755)
		}
		e.mounts = append(e.mounts,
			[2]string{filepath.Join(cacheDir, "pnpm"), "/cache/pnpm"},
			[2]string{filepath.Join(cacheDir, "npm"), "/cache/npm"},
			[2]string{filepath.Join(cacheDir, "bun"), "/cache/bun"},
			[2]string{filepath.Join(cacheDir, "mise"), "/cache/mise"},
			[2]string{e.configDir, e.configDir},
		)
		e.envVars = append(e.envVars,
			"npm_config_store_dir=/cache/pnpm",
			"NPM_CONFIG_CACHE=/cache/npm",
			"BUN_INSTALL_CACHE_DIR=/cache/bun",
			"MISE_DATA_DIR=/cache/mise",
			"CLAUDE_CONFIG_DIR="+e.configDir,
		)
	} else {
		e.envVars = append(e.envVars, "CLAUDE_CONFIG_DIR="+e.configDir)
	}

	return e
}

func copyFile(src, dst string) {
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	os.WriteFile(dst, data, 0o644)
}

// --- container management ---

func containerState(cname string) string {
	out, err := runSilent("container", "ls", "--all", "--format", "json")
	if err != nil {
		return ""
	}
	var containers []map[string]any
	if err := json.Unmarshal([]byte(out), &containers); err != nil {
		return ""
	}
	for _, c := range containers {
		config, ok := c["configuration"].(map[string]any)
		if ok && config["id"] == cname {
			if status, ok := c["status"].(string); ok {
				return status
			}
		}
	}
	return ""
}

func ensureContainer(e *env) {
	state := containerState(e.cname)

	if state == "" {
		bold("Creating container " + e.cname + "...")
		args := []string{"run", "-d", "--name", e.cname}
		cpus := os.Getenv("AGT_CPUS")
		if cpus == "" {
			cpus = "4"
		}
		mem := os.Getenv("AGT_MEMORY")
		if mem == "" {
			mem = "4G"
		}
		args = append(args, "--cpus", cpus, "--memory", mem)
		args = append(args, "-v", e.worktree+":/work")
		if e.gitDir != "" {
			args = append(args, "-v", e.gitDir+":"+e.gitDir)
		}
		for _, m := range e.mounts {
			args = append(args, "-v", m[0]+":"+m[1])
		}
		for _, ev := range e.envVars {
			args = append(args, "-e", ev)
		}
		args = append(args, "-w", "/work", e.image, "sleep", "infinity")
		if err := run("container", args...); err != nil {
			fatal("Failed to create container")
		}
		green("Container " + e.cname + " created")
	} else if state == "stopped" {
		bold("Restarting container " + e.cname + "...")
		run("container", "start", e.cname)
		green("Container " + e.cname + " restarted")
	} else {
		yellow("Container " + e.cname + " already running")
	}

	// Wait for ready
	for i := 0; i < 30; i++ {
		if err := exec.Command("container", "exec", e.cname, "true").Run(); err == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	fatal("Container failed to become ready")
}

func execInContainer(e *env, cmdArgs []string) {
	args := []string{"exec", "-it", "-w", "/work"}
	for _, ev := range e.envVars {
		args = append(args, "-e", ev)
	}
	args = append(args, e.cname)
	args = append(args, cmdArgs...)
	bin, _ := exec.LookPath("container")
	syscall.Exec(bin, append([]string{"container"}, args...), os.Environ())
}

func runInContainer(e *env, cmdArgs []string) {
	ensureContainer(e)
	execInContainer(e, cmdArgs)
}

func runInSandbox(e *env, cmdArgs []string) {
	profileFile, _ := os.CreateTemp("", "agt-sandbox.*.sb")
	profileFile.WriteString(generateSandboxProfile(e.worktree, e.gitRoot))
	profileFile.Close()
	defer os.Remove(profileFile.Name())

	bold("Starting sandbox for " + e.branch + " in " + e.worktree + "...")

	// Create ZDOTDIR with .zshrc
	zdotdir, _ := os.MkdirTemp("", "agt-sandbox-zd.*")
	defer os.RemoveAll(zdotdir)
	os.WriteFile(filepath.Join(zdotdir, ".zshrc"), []byte(
		"[[ -f \"$HOME/.zshrc\" ]] && source \"$HOME/.zshrc\"\nPROMPT=\"%F{yellow}[sandbox]%f $PROMPT\"\n",
	), 0o644)

	envArgs := []string{"AGT_SANDBOX=1", "ZDOTDIR=" + zdotdir}
	for _, ev := range e.envVars {
		envArgs = append(envArgs, ev)
	}

	// sandbox-exec -f <profile> /usr/bin/env <envs> /bin/zsh -c "cd <worktree> && exec $@" -- <cmd>
	allArgs := []string{"-f", profileFile.Name(), "/usr/bin/env"}
	allArgs = append(allArgs, envArgs...)
	allArgs = append(allArgs, "/bin/zsh", "-c", "cd '"+e.worktree+"' && exec \"$@\"", "--")
	allArgs = append(allArgs, cmdArgs...)

	bin, _ := exec.LookPath("sandbox-exec")
	syscall.Exec(bin, append([]string{"sandbox-exec"}, allArgs...), os.Environ())
}

func runAgt(e *env, cmdArgs []string) {
	if e.mode == "sandbox" {
		runInSandbox(e, cmdArgs)
	} else {
		runInContainer(e, cmdArgs)
	}
}

// --- commands ---

func cmdBuild(tag, dockerfile string) {
	if !fileExists(dockerfile) {
		fatal("Error: Dockerfile not found at " + dockerfile)
	}
	context := filepath.Dir(dockerfile)
	bold("Building " + tag + " from " + dockerfile + "...")
	if err := run("container", "build", "--tag", tag, "--file", dockerfile, context); err != nil {
		fatal("Build failed")
	}
	green("Image " + tag + " built successfully")
}

func cmdStart(args []string) {
	e := setupEnv(args)
	claudeArgs := []string{"claude", "--dangerously-skip-permissions", "--channels", "plugin:telegram@claude-plugins-official"}

	// Resume last session if one exists
	sessionsDir := filepath.Join(e.configDir, "sessions")
	if dirExists(filepath.Join(e.configDir, "projects")) && dirExists(sessionsDir) {
		entries, _ := os.ReadDir(sessionsDir)
		for _, entry := range entries {
			if strings.HasSuffix(entry.Name(), ".json") {
				claudeArgs = append(claudeArgs, "--continue")
				break
			}
		}
	}

	if len(e.remainingArgs) > 0 {
		claudeArgs = append(claudeArgs, "-p")
		claudeArgs = append(claudeArgs, strings.Join(e.remainingArgs, " "))
	}
	runAgt(e, claudeArgs)
}

func cmdEnter(args []string) {
	e := setupEnv(args)
	runAgt(e, []string{"zsh"})
}

func cmdList() {
	out, err := runSilent("container", "ls", "--all")
	if err != nil {
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
	if err := run("container", "stop", cname); err != nil {
		fatal("Failed to stop " + cname)
	}
	green("Stopped " + cname)
}

func cmdClean(branch string) {
	root, err := gitRoot()
	if err != nil {
		fatal(err.Error())
	}
	worktreeDir := filepath.Join(root, ".worktrees", branch)
	cname := containerName(branch)

	if exec.Command("container", "stop", cname).Run() == nil {
		yellow("Stopped container " + cname)
	}
	if exec.Command("container", "rm", cname).Run() == nil {
		yellow("Removed container " + cname)
	}
	if dirExists(worktreeDir) {
		run("git", "-C", root, "worktree", "remove", worktreeDir, "--force")
		green("Removed worktree at " + worktreeDir)
	}
	green("Cleaned up " + branch)
}

// --- main ---

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

func main() {
	loadConfig()

	if len(os.Args) < 2 {
		usage()
	}

	switch os.Args[1] {
	case "start":
		if len(os.Args) < 3 {
			fatal("Usage: agt start <branch> [prompt...]")
		}
		cmdStart(os.Args[2:])

	case "enter":
		if len(os.Args) < 3 {
			fatal("Usage: agt enter <branch>")
		}
		cmdEnter(os.Args[2:])

	case "build":
		buildTag := defaultImage
		buildFile := ""
		args := os.Args[2:]
		for i := 0; i < len(args); i++ {
			if args[i] == "--image" && i+1 < len(args) {
				buildTag = args[i+1]
				i++
			} else {
				buildFile = args[i]
			}
		}
		if buildFile == "" {
			buildFile = resolveImage()
		}
		if buildFile == "" {
			fatal("Usage: agt build [--image tag] <dockerfile>")
		}
		cmdBuild(buildTag, buildFile)

	case "list", "ls":
		cmdList()

	case "stop":
		if len(os.Args) < 3 {
			fatal("Usage: agt stop <branch>")
		}
		cmdStop(os.Args[2])

	case "clean":
		if len(os.Args) < 3 {
			fatal("Usage: agt clean <branch>")
		}
		cmdClean(os.Args[2])

	default:
		red("Unknown command: " + os.Args[1])
		usage()
	}
}
