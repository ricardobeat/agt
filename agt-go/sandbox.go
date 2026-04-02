package main

import (
	"bytes"
	_ "embed"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"text/template"
)

//go:embed sandbox.sb
var sandboxTemplate string

var sandboxTmpl = template.Must(template.New("sandbox").Parse(sandboxTemplate))

type sandboxData struct {
	Worktree string
	GitRoot  string
	Home     string
}

func renderSandboxProfile(worktree, gitRoot string) string {
	var buf bytes.Buffer
	sandboxTmpl.Execute(&buf, sandboxData{
		Worktree: worktree,
		GitRoot:  gitRoot,
		Home:     home,
	})
	return buf.String()
}

func (e *Env) execSandbox(cmdArgs []string) {
	profileFile := fmt.Sprintf("/tmp/agt-sandbox.%d.sb", os.Getpid())
	os.WriteFile(profileFile, []byte(renderSandboxProfile(e.Worktree, e.GitRoot)), 0o644)

	bold(fmt.Sprintf("Starting sandbox for %s in %s...", e.Branch, e.Worktree))

	zdotdir := fmt.Sprintf("/tmp/agt-sandbox-zd.%d", os.Getpid())
	os.MkdirAll(zdotdir, 0o755)
	os.WriteFile(filepath.Join(zdotdir, ".zshrc"), []byte(
		"[[ -f \"$HOME/.zshrc\" ]] && source \"$HOME/.zshrc\"\nPROMPT=\"%F{yellow}[sandbox]%f $PROMPT\"\n",
	), 0o644)

	args := []string{"sandbox-exec", "-f", profileFile, "/usr/bin/env",
		"AGT_SANDBOX=1", "ZDOTDIR=" + zdotdir}
	args = append(args, e.envArgs()...)
	args = append(args, "/bin/zsh", "-c", "cd '"+e.Worktree+"' && exec \"$@\"", "--")
	args = append(args, cmdArgs...)

	bin, _ := findBin("sandbox-exec")
	syscall.Exec(bin, args, os.Environ())
}
