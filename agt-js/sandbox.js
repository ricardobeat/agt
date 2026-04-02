// Sandbox profile template and rendering.

import { HOME } from "./shared.js";

const TEMPLATE = `(version 1)
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
  (subpath "{{worktree}}")
{{#gitRoot}}
  (subpath "{{gitRoot}}")
{{/gitRoot}}
  (regex #"^{{home}}/\\..*")
  (subpath "{{home}}/Library"))
(allow file-write*
  (subpath "/dev")
  (subpath "/tmp")
  (subpath "/private/tmp")
  (subpath "/private/var/folders")
  (subpath "{{worktree}}")
{{#gitRoot}}
  (subpath "{{gitRoot}}/.git")
{{/gitRoot}}
  (subpath "{{home}}/.agt")
  (subpath "{{home}}/.local"))
(allow network*)
(allow system-socket)
`;

export function renderSandboxProfile(worktree, gitRoot) {
  let out = TEMPLATE
    .replace(/\{\{worktree\}\}/g, worktree)
    .replace(/\{\{home\}\}/g, HOME);

  if (gitRoot) {
    out = out
      .replace(/\{\{#gitRoot\}\}\n?/g, "")
      .replace(/\{\{\/gitRoot\}\}\n?/g, "")
      .replace(/\{\{gitRoot\}\}/g, gitRoot);
  } else {
    out = out.replace(/\{\{#gitRoot\}\}[\s\S]*?\{\{\/gitRoot\}\}\n?/g, "");
  }

  return out;
}
