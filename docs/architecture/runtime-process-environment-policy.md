# Runtime Process Environment Policy

Desktop captures the user's login-shell environment in the main process so local Runtime adapters can
resolve tools installed by shell startup files. A successful capture means the shell snapshot was
read; it does not mean every captured variable is passed to a Runtime. The global policy projects
that private snapshot immediately before adapter materialization.

The renderer receives capture status only. Variable values are not sent over IPC, written to
diagnostic logs, or persisted in the environment settings file. Runtime child processes receive the
environment assembled by their adapter, including variables allowed by the global policy.

## Policy

One global policy is stored in `~/.pragma/state/runtime-process-environment-settings.json` (or the
configured `PRAGMA_HOME`) and applies to every local Runtime. The Desktop app and CLI read the same
setting.

- `filtered` is the default. Pragma passes its common execution and toolchain variables, including
  Java, Android SDK, Gradle, Maven, Kotlin, Flutter, and package-manager paths. Additional variables
  can be added to the global allowlist.
- `inherit-all` passes every variable from the captured Desktop shell environment, or from the CLI
  process environment, to all local Runtimes.
- A blocklist entry is always removed and takes precedence over both modes and the allowlist.

Full access can expose credentials and other secrets to local Runtimes and their child processes. The
General Settings page calls this out when the mode is enabled. The settings file stores the policy
mode and variable names only; it never stores environment variable values.
