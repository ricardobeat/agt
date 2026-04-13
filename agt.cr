#!/usr/bin/env crystal
# agt — sandboxed AI agent development tool

require "json"
require "file_utils"

# ---------------------------------------------------------------------------
# Tiny TOML reader — supports [section] / key = "value" only
# ---------------------------------------------------------------------------

def toml_get(file : String, key : String) : String?
  section, field = key.split(".", 2)
  return nil unless section && field

  in_section = false
  File.each_line(file) do |line|
    line = line.strip
    if line.starts_with?("[")
      in_section = line == "[#{section}]"
    elsif in_section
      eq = line.index('=')
      next unless eq
      if line[0...eq].strip == field
        return line[(eq + 1)..].strip.lstrip('"').lstrip('\'').rstrip('"').rstrip('\'')
      end
    end
  end
  nil
rescue File::NotFoundError
  nil
end

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------

def red(msg)    ; STDERR.puts "\e[31m#{msg}\e[0m" end
def green(msg)  ; puts "\e[32m#{msg}\e[0m" end
def yellow(msg) ; puts "\e[33m#{msg}\e[0m" end
def bold(msg)   ; puts "\e[1m#{msg}\e[0m" end

def fatal(msg) : NoReturn
  red(msg)
  exit(1)
end

# ---------------------------------------------------------------------------
# Shell helpers
# ---------------------------------------------------------------------------

def sh(*args)
  Process.run(args[0], args[1..], input: :inherit, output: :inherit, error: :inherit).success? ||
    fatal("Command failed: #{args[0..2].join(' ')}")
end

def capture(*args) : {String, Bool}
  result = Process.run(args[0], args[1..], output: :pipe, error: :pipe)
  {result.output.gets_to_end.strip, result.success?}
rescue
  {"", false}
end

def capture!(*args) : String
  out, ok = capture(*args)
  fatal("Command failed: #{args[0..2].join(' ')}") unless ok
  out
end

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

HOME    = Path.home.to_s
AGT_DIR = File.dirname(File.real_path(Process.executable_path || __FILE__))

MODES_FILE = File.join(HOME, ".agt", "modes.json")

DEFAULT_IMAGE = "agt-sandbox"

COMMANDS = {
  "start" => {min: 1, usage: "agt start <branch> [prompt...]"},
  "enter" => {min: 1, usage: "agt enter <branch>"},
  "build" => {min: 0, usage: "agt build [--image tag] <dockerfile>"},
  "list"  => {min: 0, usage: ""},
  "ls"    => {min: 0, usage: ""},
  "stop"  => {min: 1, usage: "agt stop <branch>"},
  "clean" => {min: 1, usage: "agt clean <branch>"},
}

# ---------------------------------------------------------------------------
# Mode persistence
# ---------------------------------------------------------------------------

def load_modes : Hash(String, String)
  JSON.parse(File.read(MODES_FILE)).as_h.transform_values(&.as_s)
rescue
  {} of String => String
end

def save_mode(path : String, mode : String)
  modes = load_modes.merge({path => mode})
  FileUtils.mkdir_p(File.dirname(MODES_FILE))
  File.write(MODES_FILE, modes.to_pretty_json)
end

def recall_mode(path : String) : String?
  load_modes[path]?
end

# ---------------------------------------------------------------------------
# Git helpers
# ---------------------------------------------------------------------------

def git_root : String?
  out, ok = capture("git", "rev-parse", "--show-toplevel")
  ok ? out : nil
end

def resolve_image(root : String?) : String?
  candidates = [
    root.try { |r| File.join(r, "Dockerfile.agt") },
    File.join(AGT_DIR, "Dockerfile"),
  ].compact
  candidates.find { |p| File.exists?(p) }
end

def image_exists?(name : String) : Bool
  out, ok = capture("container", "image", "list")
  ok && out.includes?(name)
end

def container_name(branch : String) : String
  "agt-" + branch.tr("/", "-")
end

# ---------------------------------------------------------------------------
# Sandbox profile (macOS seatbelt)
# ---------------------------------------------------------------------------

def sandbox_profile(worktree : String, git_root_path : String?) : String
  read_paths = [
    %(  (literal "/")),
    *%w[Applications usr bin sbin cores home Library System private dev opt tmp var Volumes]
      .map { |p| %(  (subpath "/#{p}")) },
    %(  (subpath "#{worktree}")),
    git_root_path.try { |r| %(  (subpath "#{r}")) },
    %(  (regex #"^#{HOME}/\\..*")),
    %(  (subpath "#{HOME}/Library")),
  ].compact.join("\n")

  write_paths = [
    *%w[/dev /tmp /private/tmp /private/var/folders]
      .map { |p| %(  (subpath "#{p}")) },
    %(  (subpath "#{worktree}")),
    git_root_path.try { |r| %(  (subpath "#{File.join(r, ".git")}")) },
    %(  (subpath "#{HOME}/.agt")),
    %(  (subpath "#{HOME}/.local")),
  ].compact.join("\n")

  <<-PROFILE
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
  #{read_paths})
  (allow file-write*
  #{write_paths})
  (allow network*)
  (allow system-socket)
  PROFILE
end

# ---------------------------------------------------------------------------
# Container management
# ---------------------------------------------------------------------------

def container_state(cname : String) : String?
  output, ok = capture("container", "ls", "--all", "--format", "json")
  return nil unless ok
  containers = JSON.parse(output).as_a
  c = containers.find { |c| c.dig?("configuration", "id").try(&.as_s) == cname }
  c.try { |x| x["status"]?.try(&.as_s) }
rescue
  nil
end

def ensure_container(cname, worktree, git_dir, mounts, env_vars, image)
  state = container_state(cname)

  case state
  when nil
    bold("Creating container #{cname}...")
    args = ["container", "run", "-d", "--name", cname,
            "--cpus", ENV.fetch("AGT_CPUS", "4"),
            "--memory", ENV.fetch("AGT_MEMORY", "4G"),
            "-v", "#{worktree}:/work"]
    args += ["-v", "#{git_dir}:#{git_dir}"] if git_dir
    mounts.each { |src, dst| args += ["-v", "#{src}:#{dst}"] }
    env_vars.each { |k, v| args += ["-e", "#{k}=#{v}"] }
    args += ["-w", "/work", image, "sleep", "infinity"]
    sh(*args)
    green("Container #{cname} created")
  when "stopped"
    bold("Restarting container #{cname}...")
    sh("container", "start", cname)
    green("Container #{cname} restarted")
  else
    yellow("Container #{cname} already running")
  end

  30.times do
    _, ok = capture("container", "exec", cname, "true")
    return if ok
    sleep(0.2)
  end
  fatal("Container failed to become ready")
end

def exec_container(cname, env_vars, cmd_args)
  args = ["container", "exec", "-it", "-w", "/work"]
  env_vars.each { |k, v| args += ["-e", "#{k}=#{v}"] }
  args += [cname] + cmd_args
  Process.exec(args[0], args[1..])
end

def exec_sandbox(worktree, git_root_path, env_vars, branch, cmd_args)
  profile_file = "/tmp/agt-sandbox.#{Process.pid}.sb"
  File.write(profile_file, sandbox_profile(worktree, git_root_path))

  bold("Starting sandbox for #{branch} in #{worktree}...")

  zdotdir = "/tmp/agt-sandbox-zd.#{Process.pid}"
  FileUtils.mkdir_p(zdotdir)
  File.write(File.join(zdotdir, ".zshrc"),
    %([[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\nPROMPT="%F{yellow}[sandbox]%f $PROMPT"\n))

  env_args = ["AGT_SANDBOX=1", "ZDOTDIR=#{zdotdir}"]
  env_vars.each { |k, v| env_args << "#{k}=#{v}" }

  Process.exec("sandbox-exec", ["-f", profile_file,
    "/usr/bin/env", *env_args,
    "/bin/zsh", "-c", "cd '#{worktree}' && exec \"$@\"", "--",
    *cmd_args])
end

# ---------------------------------------------------------------------------
# Setup — builds the execution context from CLI flags + environment
# ---------------------------------------------------------------------------

record Context,
  branch       : String,
  worktree     : String,
  git_root_path : String?,
  git_dir      : String?,
  cname        : String,
  image        : String,
  mode         : String,
  mounts       : Array(Tuple(String, String)),
  env_vars     : Hash(String, String),
  remaining    : Array(String)

def load_config : String?
  config_file = ["./agt.toml", File.join(HOME, ".config", "agt", "config.toml")]
    .find { |f| File.exists?(f) }
  config_file.try { |f| toml_get(f, "execution.mode") }
end

def setup(args : Array(String), default_mode : String) : Context
  args = args.dup
  image = DEFAULT_IMAGE
  mode = default_mode
  mode_override = false

  while args.first?.try(&.starts_with?("--"))
    case args.shift
    when "--image" then image = args.shift
    when "--mode"  then mode = args.shift; mode_override = true
    end
  end

  fatal("branch name required") if args.empty?
  branch = args.shift
  remaining = args
  cname = container_name(branch)
  env_vars = {"AGT_NAME" => cname}

  root = git_root

  # Worktree
  worktree, git_root_path, git_dir = if root
    wt = File.join(root, ".worktrees", branch)
    gd = File.join(root, ".git")

    if Dir.exists?(wt)
      yellow("Worktree already exists at #{wt}")
      mode = mode_override ? (save_mode(wt, mode); mode) : (recall_mode(wt) || mode)
    else
      bold("Creating worktree for branch '#{branch}'...")
      Process.run("git", ["-C", root, "worktree", "add", wt, "-b", branch],
        input: :inherit, output: :inherit, error: :inherit).success? ||
        sh("git", "-C", root, "worktree", "add", wt, branch)
      green("Worktree created at #{wt}")
      save_mode(wt, mode)
    end

    copy_env_files(root, wt)
    {wt, root, gd}
  else
    bold("Using current directory as workspace")
    {Dir.current, nil, nil}
  end

  # Build image if needed (container mode only)
  if mode == "container" && !image_exists?(image)
    if image == DEFAULT_IMAGE
      dockerfile = resolve_image(root) || fatal("No image '#{image}' found and no Dockerfile to build one.")
      yellow("Image not found, building from #{dockerfile}...")
      cmd_build(image, dockerfile)
    else
      fatal("Image '#{image}' not found. Build it first or check the name.")
    end
  end

  # Claude config
  config_dir = setup_claude_config
  env_vars["CLAUDE_CONFIG_DIR"] = config_dir

  # Auth
  setup_auth(env_vars)

  # Mounts
  mounts = [] of Tuple(String, String)
  if mode == "container"
    cache_dir = File.join(HOME, ".agt", "cache")
    %w[pnpm npm bun mise].each do |sub|
      FileUtils.mkdir_p(File.join(cache_dir, sub))
      mounts << {File.join(cache_dir, sub), "/cache/#{sub}"}
    end
    mounts << {config_dir, config_dir}
    env_vars.merge!({
      "npm_config_store_dir" => "/cache/pnpm",
      "NPM_CONFIG_CACHE"     => "/cache/npm",
      "BUN_INSTALL_CACHE_DIR" => "/cache/bun",
      "MISE_DATA_DIR"        => "/cache/mise",
    })
  end

  Context.new(
    branch:        branch,
    worktree:      worktree,
    git_root_path: git_root_path,
    git_dir:       git_dir,
    cname:         cname,
    image:         image,
    mode:          mode,
    mounts:        mounts,
    env_vars:      env_vars,
    remaining:     remaining,
  )
end

def run_agt(ctx : Context, cmd_args : Array(String))
  if ctx.mode == "sandbox"
    exec_sandbox(ctx.worktree, ctx.git_root_path, ctx.env_vars, ctx.branch, cmd_args)
  else
    ensure_container(ctx.cname, ctx.worktree, ctx.git_dir, ctx.mounts, ctx.env_vars, ctx.image)
    exec_container(ctx.cname, ctx.env_vars, cmd_args)
  end
end

# ---------------------------------------------------------------------------
# Claude config helpers
# ---------------------------------------------------------------------------

def setup_claude_config : String
  config_dir = File.join(HOME, ".agt", "claude-config")
  FileUtils.mkdir_p(config_dir)

  init_agt_settings(config_dir)
  rsync_claude_dir(config_dir)

  begin
    FileUtils.cp(File.join(AGT_DIR, "claude.json"), File.join(config_dir, ".claude.json"))
  rescue
  end
  begin
    FileUtils.cp(agt_settings_path, File.join(config_dir, "settings.json"))
  rescue
  end

  config_dir
end

def agt_settings_path : String
  File.join(HOME, ".agt", ".claude", "settings.json")
end

def init_agt_settings(config_dir : String)
  path = agt_settings_path
  return if File.exists?(path)

  FileUtils.mkdir_p(File.dirname(path))
  host = File.join(HOME, ".claude", "settings.json")
  settings = File.exists?(host) ? JSON.parse(File.read(host)).as_h : {} of String => JSON::Any
  sandbox = (settings["sandbox"]?.try(&.as_h) || {} of String => JSON::Any)
    .merge({"enabled" => JSON::Any.new(false)})
  settings["sandbox"] = JSON::Any.new(sandbox)
  File.write(path, settings.to_pretty_json)
  green("Created agt Claude settings at #{path}")
end

def rsync_claude_dir(config_dir : String)
  src = File.join(HOME, ".claude")
  return unless Dir.exists?(src)
  excludes = %w[.credentials.json settings.json sessions history.jsonl todos statsig telemetry cache]
  exclude_args = excludes.flat_map { |e| ["--exclude", e] }
  sh("rsync", "-a", "--delete", *exclude_args, "#{src}/", "#{config_dir}/")
end

def setup_auth(env_vars : Hash(String, String))
  api_key = ENV["ANTHROPIC_API_KEY"]?
  if api_key && !api_key.empty?
    env_vars["ANTHROPIC_API_KEY"] = api_key
    return
  end

  creds, ok = capture("security", "find-generic-password", "-s", "Claude Code-credentials", "-w")
  if ok && !creds.empty?
    config_dir = File.join(HOME, ".agt", "claude-config")
    path = File.join(config_dir, ".credentials.json")
    File.write(path, creds)
    File.chmod(path, 0o600)
  else
    yellow("Warning: no API key or OAuth token found. Run 'claude' on the host to authenticate first.")
  end
end

def copy_env_files(root : String, worktree : String)
  out, ok = capture("git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard")
  return unless ok
  out.each_line do |relpath|
    relpath = relpath.strip
    next if relpath.empty? || !relpath.includes?(".env")
    src = File.join(root, relpath)
    next unless File.exists?(src)
    dest = File.join(worktree, File.dirname(relpath))
    FileUtils.mkdir_p(dest)
    FileUtils.cp(src, File.join(dest, File.basename(relpath)))
  end
end

# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------

def cmd_build(tag : String, dockerfile : String)
  fatal("Dockerfile not found at #{dockerfile}") unless File.exists?(dockerfile)
  bold("Building #{tag} from #{dockerfile}...")
  sh("container", "build", "--tag", tag, "--file", dockerfile, File.dirname(dockerfile))
  green("Image #{tag} built successfully")
end

def cmd_start(args : Array(String), default_mode : String)
  ctx = setup(args, default_mode)

  claude_args = ["claude", "--dangerously-skip-permissions",
                 "--channels", "plugin:telegram@claude-plugins-official"]

  sessions_dir = File.join(ctx.env_vars["CLAUDE_CONFIG_DIR"], "sessions")
  projects_dir = File.join(ctx.env_vars["CLAUDE_CONFIG_DIR"], "projects")
  if Dir.exists?(projects_dir) && Dir.exists?(sessions_dir)
    has_sessions = Dir.entries(sessions_dir).any?(&.ends_with?(".json"))
    claude_args << "--continue" if has_sessions
  end

  claude_args += ["-p", ctx.remaining.join(" ")] unless ctx.remaining.empty?
  run_agt(ctx, claude_args)
end

def cmd_enter(args : Array(String), default_mode : String)
  ctx = setup(args, default_mode)
  run_agt(ctx, ["zsh"])
end

def cmd_list
  out, ok = capture("container", "ls", "--all")
  lines = ok ? out.lines.select { |l| l.starts_with?("ID") || l.starts_with?("agt-") } : [] of String
  lines.empty? ? puts("No agt containers found") : lines.each { |l| print l }
end

def cmd_stop(branch : String)
  cname = container_name(branch)
  bold("Stopping #{cname}...")
  sh("container", "stop", cname)
  green("Stopped #{cname}")
end

def cmd_clean(branch : String)
  root = git_root || fatal("Not inside a git repository")
  worktree_dir = File.join(root, ".worktrees", branch)
  cname = container_name(branch)

  _, stopped = capture("container", "stop", cname)
  yellow("Stopped container #{cname}") if stopped
  _, removed = capture("container", "rm", cname)
  yellow("Removed container #{cname}") if removed

  if Dir.exists?(worktree_dir)
    sh("git", "-C", root, "worktree", "remove", worktree_dir, "--force")
    green("Removed worktree at #{worktree_dir}")
  end
  green("Cleaned up #{branch}")
end

# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------

def usage : NoReturn
  puts <<-USAGE
  agt — sandboxed AI agent development tool

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

  Config file (agt.toml) loaded from ./agt.toml or ~/.config/agt/config.toml:
    [execution]
    mode = "sandbox"   # or "container"

  Examples:
    agt start my-feature
    agt enter my-feature
    agt start my-feature --image my-custom-image
    agt build ./Dockerfile
    agt build --image my-tag ./path/to/Dockerfile

  USAGE
  exit(1)
end

# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

usage if ARGV.empty?

default_mode = load_config || "container"

cmd  = ARGV[0]
rest = ARGV[1..]

spec = COMMANDS[cmd]?
unless spec
  red("Unknown command: #{cmd}")
  usage
end

if spec[:min] > 0 && rest.size < spec[:min]
  fatal("Usage: #{spec[:usage]}")
end

case cmd
when "start"
  cmd_start(rest.to_a, default_mode)
when "enter"
  cmd_enter(rest.to_a, default_mode)
when "list", "ls"
  cmd_list
when "stop"
  cmd_stop(rest[0])
when "clean"
  cmd_clean(rest[0])
when "build"
  tag  = DEFAULT_IMAGE
  file = nil
  args = rest.to_a.dup
  while (arg = args.shift?)
    arg == "--image" ? tag = args.shift? || tag : file = arg
  end
  file ||= resolve_image(git_root)
  fatal("Usage: #{spec[:usage]}") unless file
  cmd_build(tag, file)
end
