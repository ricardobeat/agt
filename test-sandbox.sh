#!/bin/zsh
# Test whether sandbox-exec actually enforces the seatbelt profile.
# Run from the agt directory: ./test-sandbox.sh
set -uo pipefail

red()    { printf "\033[31m  FAIL: %s\033[0m\n" "$1"; }
green()  { printf "\033[32m  PASS: %s\033[0m\n" "$1"; }

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKTREE="$SCRIPT_DIR/.worktrees/sandbox-test"
PROFILE="$(mktemp /tmp/agt-test-profile.XXXXXX)"

mkdir -p "$WORKTREE"

cat > "$PROFILE" <<SBEOF
(version 1)
(deny default)

(allow process*)
(allow signal)
(allow sysctl*)
(allow mach*)
(allow ipc*)
(allow file-ioctl)

(allow file-read-metadata)
(allow file-read-xattr)

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
  (subpath "$WORKTREE")
  (subpath "$HOME/.agt")
  (subpath "$HOME/.claude")
  (subpath "$HOME/.local")
  (subpath "$HOME/.bun")
  (subpath "$HOME/.npm")
  (subpath "$HOME/.nvm")
  (subpath "$HOME/.mise")
  (subpath "$HOME/Library")
  (literal "$HOME/.zshrc")
  (literal "$HOME/.zshenv")
  (literal "$HOME/.zprofile")
  (literal "$HOME/.zlogin"))

(allow file-write*
  (subpath "/dev")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "$WORKTREE")
  (subpath "$HOME/.agt"))

(allow network*)
SBEOF

pass=0
fail=0

check() {
  local desc="$1" expect="$2"
  shift 2
  sandbox-exec -f "$PROFILE" /bin/zsh -c "$*" >/dev/null 2>&1
  local rc=$?

  if [[ "$expect" == "ok" && $rc -eq 0 ]]; then
    green "$desc"; ((pass++))
  elif [[ "$expect" == "deny" && $rc -ne 0 ]]; then
    green "$desc (blocked, rc=$rc)"; ((pass++))
  elif [[ "$expect" == "ok" ]]; then
    red "$desc (expected success, got rc=$rc)"; ((fail++))
  else
    red "$desc (expected denial, got rc=$rc)"; ((fail++))
  fi
}

echo ""
echo "Sandbox enforcement tests"
echo "  worktree: $WORKTREE"
echo ""

echo "== Allowed =="
check "Run a command"               ok    "echo hello"
check "Write inside worktree"       ok    "touch '$WORKTREE/testfile'"
check "Read inside worktree"        ok    "cat '$WORKTREE/testfile'"
check "Write to /tmp"               ok    "touch /tmp/agt-test-tmpwrite"
check "Read system binaries"        ok    "ls /usr/bin/env"
check "Read .zshrc"                 ok    "cat '$HOME/.zshrc' > /dev/null"

echo ""
echo "== Denied writes =="
check "Write to home dir"           deny  "touch '$HOME/agt-sandbox-test-nope'"
check "Write to parent dir"         deny  "touch '$SCRIPT_DIR/agt-sandbox-test-nope'"
check "Write to /usr"               deny  "touch /usr/agt-test-nope"

echo ""
echo "== Denied reads =="
check "Read ~/.ssh"                 deny  "cat '$HOME/.ssh/id_ed25519' 2>&1"
check "Read ~/Desktop"              deny  "cat '$HOME/Desktop/.localized' 2>&1"
check "Read ~/Documents"            deny  "cat '$HOME/Documents/.localized' 2>&1"
check "Read files outside worktree" deny  "cat '$SCRIPT_DIR/agt' 2>&1"

echo ""
echo "Results: $pass passed, $fail failed"

# Cleanup
rm -rf "$WORKTREE" "$PROFILE" /tmp/agt-test-tmpwrite 2>/dev/null
exit $fail
