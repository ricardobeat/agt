#!/usr/bin/env ruby
# frozen_string_literal: true

require "json"
require "fileutils"
require "open3"

class Agt
  DEFAULT_IMAGE = "agt-sandbox"
  HOME = Dir.home
  MODES_FILE = File.join(HOME, ".agt", "modes.json")
  AGT_DIR = File.dirname(File.realpath(__FILE__))

  COMMANDS = {
    "start" => { min: 1, usage: "agt start <branch> [prompt...]" },
    "enter" => { min: 1, usage: "agt enter <branch>" },
    "build" => { min: 0, usage: "agt build [--image tag] <dockerfile>" },
    "list"  => { min: 0 }, "ls" => { min: 0 },
    "stop"  => { min: 1, usage: "agt stop <branch>" },
    "clean" => { min: 1, usage: "agt clean <branch>" },
  }.freeze

  # --- colors & output ---

  def red(msg)    ; $stderr.puts("\e[31m#{msg}\e[0m") end
  def green(msg)  ; puts("\e[32m#{msg}\e[0m") end
  def yellow(msg) ; puts("\e[33m#{msg}\e[0m") end
  def bold(msg)   ; puts("\e[1m#{msg}\e[0m") end

  def fatal(msg)
    red(msg)
    exit(1)
  end

  # --- shell helpers ---

  def sh(*args)
    system(*args) or fatal("Command failed: #{args.first(3).join(' ')}")
  end

  def capture(*args)
    out, _, status = Open3.capture3(*args)
    [out.strip, status.success?]
  end

  def capture!(*args)
    out, ok = capture(*args)
    fatal("Command failed: #{args.first(3).join(' ')}") unless ok
    out
  end

  # --- config ---

  def toml_get(file, key)
    section, field = key.split(".", 2)
    return nil unless section && field
    in_section = false
    File.foreach(file) do |line|
      line = line.strip
      if line.start_with?("[")
        in_section = (line == "[#{section}]")
      elsif in_section && (eq = line.index("=")) && line[0...eq].strip == field
        return line[(eq + 1)..-1].strip.gsub(/\A["']|["']\z/, "")
      end
    end
    nil
  rescue Errno::ENOENT
    nil
  end

  def load_config
    config = ["./agt.toml", File.join(HOME, ".config", "agt", "config.toml")].find { |f| File.exist?(f) }
    @mode = toml_get(config, "execution.mode") || "container" if config
  end

  # --- mode persistence ---

  def load_modes
    JSON.parse(File.read(MODES_FILE)) rescue {}
  end

  def save_mode(path, mode)
    modes = load_modes.merge(path => mode)
    FileUtils.mkdir_p(File.dirname(MODES_FILE))
    File.write(MODES_FILE, JSON.pretty_generate(modes))
  end

  def recall_mode(path)
    load_modes[path]
  end

  # --- git ---

  def git_root
    out, ok = capture("git", "rev-parse", "--show-toplevel")
    ok ? out : nil
  end

  def resolve_image
    root = git_root
    [root && File.join(root, "Dockerfile.agt"), File.join(AGT_DIR, "Dockerfile")]
      .compact.find { |p| File.exist?(p) }
  end

  def image_exists?(name)
    out, ok = capture("container", "image", "list")
    ok && out.include?(name)
  end

  def container_name(branch)
    "agt-" + branch.tr("/", "-")
  end

  # --- sandbox profile ---

  def sandbox_profile(worktree, git_root_path)
    read_paths = [
      '(literal "/")',
      *%w[Applications usr bin sbin cores home Library System private dev opt tmp var Volumes].map { |p| "(subpath \"/#{p}\")" },
      "(subpath \"#{worktree}\")",
      git_root_path && "(subpath \"#{git_root_path}\")",
      "(regex #\"^#{HOME}/\\\\..*\")",
      "(subpath \"#{HOME}/Library\")",
    ].compact.map { |l| "  #{l}" }.join("\n")

    write_paths = [
      *%w[/dev /tmp /private/tmp /private/var/folders].map { |p| "(subpath \"#{p}\")" },
      "(subpath \"#{worktree}\")",
      git_root_path && "(subpath \"#{File.join(git_root_path, ".git")}\")",
      "(subpath \"#{HOME}/.agt\")",
      "(subpath \"#{HOME}/.local\")",
    ].compact.map { |l| "  #{l}" }.join("\n")

    <<~PROFILE
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

  # --- environment setup ---

  def setup(args)
    args = args.dup
    @image = DEFAULT_IMAGE
    mode_override = false

    # Consume flags
    while args.first&.start_with?("--") || (args.length > 1 && %w[--image --mode].include?(args[0]))
      case args.shift
      when "--image" then @image = args.shift
      when "--mode"  then @mode = args.shift; mode_override = true
      else break
      end
    end

    fatal("branch name required") if args.empty?
    @branch = args.shift
    @remaining_args = args
    @cname = container_name(@branch)
    @env_vars = { "AGT_NAME" => @cname }

    ensure_image if @mode == "container"
    setup_worktree(mode_override)
    setup_claude_config
    setup_auth
    setup_mounts
    self
  end

  private

  def ensure_image
    return if image_exists?(@image)
    if @image == DEFAULT_IMAGE
      dockerfile = resolve_image or fatal("No image '#{@image}' found and no Dockerfile to build one.")
      yellow("Image not found, building from #{dockerfile}...")
      cmd_build(@image, dockerfile)
    else
      fatal("Image '#{@image}' not found. Build it first or check the name.")
    end
  end

  def setup_worktree(mode_override)
    root = git_root
    unless root
      @worktree = Dir.pwd
      @git_root_path = @git_dir = nil
      bold("Using current directory as workspace")
      return
    end

    @worktree = File.join(root, ".worktrees", @branch)
    @git_root_path = root
    @git_dir = File.join(root, ".git")

    if Dir.exist?(@worktree)
      yellow("Worktree already exists at #{@worktree}")
      if mode_override
        save_mode(@worktree, @mode)
      else
        @mode = recall_mode(@worktree) || @mode
      end
    else
      bold("Creating worktree for branch '#{@branch}'...")
      system("git", "-C", root, "worktree", "add", @worktree, "-b", @branch) ||
        sh("git", "-C", root, "worktree", "add", @worktree, @branch)
      green("Worktree created at #{@worktree}")
      save_mode(@worktree, @mode)
    end

    copy_env_files(root)
  end

  def copy_env_files(root)
    out, ok = capture("git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard")
    return unless ok
    out.each_line do |relpath|
      relpath = relpath.strip
      next if relpath.empty? || !relpath.include?(".env")
      src = File.join(root, relpath)
      next unless File.exist?(src)
      dest = File.join(@worktree, File.dirname(relpath))
      FileUtils.mkdir_p(dest)
      FileUtils.cp(src, File.join(dest, File.basename(relpath)))
    end
  end

  def setup_claude_config
    @config_dir = File.join(HOME, ".agt", "claude-config")
    FileUtils.mkdir_p(@config_dir)

    init_agt_settings
    rsync_claude_dir
    FileUtils.cp(File.join(AGT_DIR, "claude.json"), File.join(@config_dir, ".claude.json")) rescue nil
    FileUtils.cp(agt_settings_path, File.join(@config_dir, "settings.json")) rescue nil
  end

  def agt_settings_path
    File.join(HOME, ".agt", ".claude", "settings.json")
  end

  def init_agt_settings
    return if File.exist?(agt_settings_path)
    FileUtils.mkdir_p(File.dirname(agt_settings_path))
    host = File.join(HOME, ".claude", "settings.json")
    settings = File.exist?(host) ? JSON.parse(File.read(host)) : {}
    settings["sandbox"] = (settings["sandbox"] || {}).merge("enabled" => false)
    File.write(agt_settings_path, JSON.pretty_generate(settings))
    green("Created agt Claude settings at #{agt_settings_path}")
  end

  def rsync_claude_dir
    src = File.join(HOME, ".claude")
    return unless Dir.exist?(src)
    excludes = %w[.credentials.json settings.json sessions history.jsonl todos statsig telemetry cache]
    sh("rsync", "-a", "--delete", *excludes.flat_map { |e| ["--exclude", e] }, "#{src}/", "#{@config_dir}/")
  end

  def setup_auth
    api_key = ENV["ANTHROPIC_API_KEY"]
    if api_key && !api_key.empty?
      @env_vars["ANTHROPIC_API_KEY"] = api_key
    else
      creds, ok = capture("security", "find-generic-password", "-s", "Claude Code-credentials", "-w")
      if ok && !creds.empty?
        path = File.join(@config_dir, ".credentials.json")
        File.write(path, creds)
        File.chmod(0o600, path)
      else
        yellow("Warning: no API key or OAuth token found. Run 'claude' on the host to authenticate first.")
      end
    end
  end

  def setup_mounts
    @mounts = []
    if @mode == "container"
      cache_dir = File.join(HOME, ".agt", "cache")
      %w[pnpm npm bun mise].each do |sub|
        FileUtils.mkdir_p(File.join(cache_dir, sub))
        @mounts << [File.join(cache_dir, sub), "/cache/#{sub}"]
      end
      @mounts << [@config_dir, @config_dir]
      @env_vars.merge!(
        "npm_config_store_dir" => "/cache/pnpm",
        "NPM_CONFIG_CACHE" => "/cache/npm",
        "BUN_INSTALL_CACHE_DIR" => "/cache/bun",
        "MISE_DATA_DIR" => "/cache/mise",
        "CLAUDE_CONFIG_DIR" => @config_dir,
      )
    else
      @env_vars["CLAUDE_CONFIG_DIR"] = @config_dir
    end
  end

  # --- container management ---

  def container_state(cname)
    out, ok = capture("container", "ls", "--all", "--format", "json")
    return nil unless ok
    containers = JSON.parse(out) rescue []
    c = containers.find { |c| c.dig("configuration", "id") == cname }
    c&.fetch("status", nil)
  end

  def ensure_container
    state = container_state(@cname)

    case state
    when nil
      bold("Creating container #{@cname}...")
      args = ["container", "run", "-d", "--name", @cname,
              "--cpus", ENV["AGT_CPUS"] || "4", "--memory", ENV["AGT_MEMORY"] || "4G",
              "-v", "#{@worktree}:/work"]
      args.push("-v", "#{@git_dir}:#{@git_dir}") if @git_dir
      @mounts.each { |src, dst| args.push("-v", "#{src}:#{dst}") }
      @env_vars.each { |k, v| args.push("-e", "#{k}=#{v}") }
      args.push("-w", "/work", @image, "sleep", "infinity")
      sh(*args)
      green("Container #{@cname} created")
    when "stopped"
      bold("Restarting container #{@cname}...")
      sh("container", "start", @cname)
      green("Container #{@cname} restarted")
    else
      yellow("Container #{@cname} already running")
    end

    30.times do
      _, ok = capture("container", "exec", @cname, "true")
      return if ok
      sleep(0.2)
    end
    fatal("Container failed to become ready")
  end

  def exec_container(cmd_args)
    args = ["container", "exec", "-it", "-w", "/work"]
    @env_vars.each { |k, v| args.push("-e", "#{k}=#{v}") }
    args.push(@cname, *cmd_args)
    exec(*args)
  end

  def exec_sandbox(cmd_args)
    profile_file = "/tmp/agt-sandbox.#{$$}.sb"
    File.write(profile_file, sandbox_profile(@worktree, @git_root_path))

    bold("Starting sandbox for #{@branch} in #{@worktree}...")

    zdotdir = "/tmp/agt-sandbox-zd.#{$$}"
    FileUtils.mkdir_p(zdotdir)
    File.write(File.join(zdotdir, ".zshrc"),
      %([[ -f "$HOME/.zshrc" ]] && source "$HOME/.zshrc"\nPROMPT="%F{yellow}[sandbox]%f $PROMPT"\n))

    env_args = ["AGT_SANDBOX=1", "ZDOTDIR=#{zdotdir}"]
    @env_vars.each { |k, v| env_args << "#{k}=#{v}" }

    exec("sandbox-exec", "-f", profile_file,
         "/usr/bin/env", *env_args,
         "/bin/zsh", "-c", "cd '#{@worktree}' && exec \"$@\"", "--",
         *cmd_args)
  end

  def run_agt(cmd_args)
    if @mode == "sandbox"
      exec_sandbox(cmd_args)
    else
      ensure_container
      exec_container(cmd_args)
    end
  end

  public

  # --- commands ---

  def cmd_build(tag, dockerfile)
    fatal("Dockerfile not found at #{dockerfile}") unless File.exist?(dockerfile)
    bold("Building #{tag} from #{dockerfile}...")
    sh("container", "build", "--tag", tag, "--file", dockerfile, File.dirname(dockerfile))
    green("Image #{tag} built successfully")
  end

  def cmd_start(args)
    setup(args)
    claude_args = ["claude", "--dangerously-skip-permissions", "--channels", "plugin:telegram@claude-plugins-official"]

    sessions_dir = File.join(@config_dir, "sessions")
    if Dir.exist?(File.join(@config_dir, "projects")) && Dir.exist?(sessions_dir)
      claude_args << "--continue" if Dir.entries(sessions_dir).any? { |e| e.end_with?(".json") }
    end

    claude_args.push("-p", @remaining_args.join(" ")) unless @remaining_args.empty?
    run_agt(claude_args)
  end

  def cmd_enter(args)
    setup(args)
    run_agt(["zsh"])
  end

  def cmd_list
    out, ok = capture("container", "ls", "--all")
    lines = ok ? out.lines.select { |l| l.start_with?("ID") || l.start_with?("agt-") } : []
    lines.empty? ? puts("No agt containers found") : lines.each { |l| print l }
  end

  def cmd_stop(args)
    cname = container_name(args[0])
    bold("Stopping #{cname}...")
    sh("container", "stop", cname)
    green("Stopped #{cname}")
  end

  def cmd_clean(args)
    branch = args[0]
    root = git_root or fatal("Not inside a git repository")
    worktree_dir = File.join(root, ".worktrees", branch)
    cname = container_name(branch)

    capture("container", "stop", cname).last && yellow("Stopped container #{cname}")
    capture("container", "rm", cname).last && yellow("Removed container #{cname}")

    if Dir.exist?(worktree_dir)
      sh("git", "-C", root, "worktree", "remove", worktree_dir, "--force")
      green("Removed worktree at #{worktree_dir}")
    end
    green("Cleaned up #{branch}")
  end

  # --- main ---

  def self.usage
    puts <<~USAGE
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

      Config file (agt.toml) is loaded from ./agt.toml or ~/.config/agt/config.toml:
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

  def self.run
    agt = new
    agt.send(:load_config)

    self.usage if ARGV.empty?

    cmd = ARGV[0]
    rest = ARGV[1..-1]

    spec = COMMANDS[cmd]
    unless spec
      agt.send(:red, "Unknown command: #{cmd}")
      self.usage
    end

    if spec[:min] && rest.length < spec[:min]
      agt.send(:fatal, "Usage: #{spec[:usage]}")
    end

    case cmd
    when "start"       then agt.cmd_start(rest)
    when "enter"       then agt.cmd_enter(rest)
    when "list", "ls"  then agt.cmd_list
    when "stop"        then agt.cmd_stop(rest)
    when "clean"       then agt.cmd_clean(rest)
    when "build"
      tag, file = DEFAULT_IMAGE, nil
      args = rest.dup
      while (arg = args.shift)
        arg == "--image" ? tag = args.shift : file = arg
      end
      file ||= agt.send(:resolve_image)
      agt.send(:fatal, "Usage: #{spec[:usage]}") unless file
      agt.cmd_build(tag, file)
    end
  end
end

Agt.run
