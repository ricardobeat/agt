package main

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"time"
)

func (e *Env) containerState() string {
	out, ok := capture("container", "ls", "--all", "--format", "json")
	if !ok {
		return ""
	}
	var containers []map[string]any
	if json.Unmarshal([]byte(out), &containers) != nil {
		return ""
	}
	for _, c := range containers {
		if cfg, ok := c["configuration"].(map[string]any); ok && cfg["id"] == e.Cname {
			if s, ok := c["status"].(string); ok {
				return s
			}
		}
	}
	return ""
}

func (e *Env) ensureContainer() {
	switch state := e.containerState(); state {
	case "":
		bold(fmt.Sprintf("Creating container %s...", e.Cname))
		cpus := envOr("AGT_CPUS", "4")
		mem := envOr("AGT_MEMORY", "4G")
		args := []string{"run", "-d", "--name", e.Cname,
			"--cpus", cpus, "--memory", mem,
			"-v", e.Worktree + ":/work"}
		if e.GitDir != "" {
			args = append(args, "-v", e.GitDir+":"+e.GitDir)
		}
		for _, m := range e.Mounts {
			args = append(args, "-v", m[0]+":"+m[1])
		}
		for _, ev := range e.envFlags() {
			args = append(args, ev)
		}
		args = append(args, "-w", "/work", e.Image, "sleep", "infinity")
		sh("container", args...)
		green(fmt.Sprintf("Container %s created", e.Cname))

	case "stopped":
		bold(fmt.Sprintf("Restarting container %s...", e.Cname))
		sh("container", "start", e.Cname)
		green(fmt.Sprintf("Container %s restarted", e.Cname))

	default:
		yellow(fmt.Sprintf("Container %s already running", e.Cname))
	}

	for range 30 {
		if exec.Command("container", "exec", e.Cname, "true").Run() == nil {
			return
		}
		time.Sleep(200 * time.Millisecond)
	}
	fatal("Container failed to become ready")
}

func (e *Env) execContainer(cmdArgs []string) {
	args := []string{"container", "exec", "-it", "-w", "/work"}
	args = append(args, e.envFlags()...)
	args = append(args, e.Cname)
	args = append(args, cmdArgs...)
	bin, _ := findBin("container")
	syscall.Exec(bin, args, os.Environ())
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func findBin(name string) (string, error) {
	return exec.LookPath(name)
}
