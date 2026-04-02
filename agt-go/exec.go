package main

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// --- colors ---

func red(msg string)    { fmt.Fprintf(os.Stderr, "\033[31m%s\033[0m\n", msg) }
func green(msg string)  { fmt.Printf("\033[32m%s\033[0m\n", msg) }
func yellow(msg string) { fmt.Printf("\033[33m%s\033[0m\n", msg) }
func bold(msg string)   { fmt.Printf("\033[1m%s\033[0m\n", msg) }

func fatal(msg string) {
	red(msg)
	os.Exit(1)
}

// --- shell ---

// sh runs a command with inherited stdio, fataling on failure.
func sh(name string, args ...string) {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	if err := cmd.Run(); err != nil {
		fatal(fmt.Sprintf("Command failed: %s %s", name, strings.Join(args[:min(len(args), 2)], " ")))
	}
}

// try runs a command with inherited stdio, returning success.
func try(name string, args ...string) bool {
	cmd := exec.Command(name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run() == nil
}

// capture runs a command silently and returns trimmed stdout + ok.
func capture(name string, args ...string) (string, bool) {
	out, err := exec.Command(name, args...).Output()
	return strings.TrimSpace(string(out)), err == nil
}

// --- file helpers ---

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func dirExists(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

func copyFile(src, dst string) {
	data, err := os.ReadFile(src)
	if err != nil {
		return
	}
	os.WriteFile(dst, data, 0o644)
}
