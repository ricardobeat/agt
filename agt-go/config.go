package main

import (
	"bufio"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
)

var (
	home      string
	agtDir    string
	agtMode   = "container"
	modesFile string
)

func initPaths() {
	home = os.Getenv("HOME")
	modesFile = filepath.Join(home, ".agt", "modes.json")

	exe, err := os.Executable()
	if err == nil {
		exe, _ = filepath.EvalSymlinks(exe)
		agtDir = filepath.Dir(exe)
	} else {
		agtDir, _ = os.Getwd()
	}
}

func loadConfig() {
	configs := []string{
		"./agt.toml",
		filepath.Join(home, ".config", "agt", "config.toml"),
	}
	for _, f := range configs {
		if fileExists(f) {
			if mode := tomlGet(f, "execution.mode"); mode != "" {
				agtMode = mode
			}
			return
		}
	}
}

// tomlGet reads a flat "section.key" from a TOML file.
func tomlGet(file, key string) string {
	section, field, ok := strings.Cut(key, ".")
	if !ok {
		return ""
	}
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
			k, v, ok := strings.Cut(line, "=")
			if ok && strings.TrimSpace(k) == field {
				return strings.Trim(strings.TrimSpace(v), `"'`)
			}
		}
	}
	return ""
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

// --- json helpers ---

func readJSON(path string) map[string]any {
	data, err := os.ReadFile(path)
	if err != nil {
		return map[string]any{}
	}
	m := map[string]any{}
	json.Unmarshal(data, &m)
	return m
}

func writeJSON(path string, v any) {
	os.MkdirAll(filepath.Dir(path), 0o755)
	data, _ := json.MarshalIndent(v, "", "  ")
	os.WriteFile(path, data, 0o644)
}
