# ADR 068: Desktop bundled CLI and terminal registration

- Status: Accepted
- Date: 2026-10-11

## Decision

Desktop distributes the complete CLI from the same source commit. npm and Desktop share the bundle
builder, worker inventory and CLI implementation. The CLI keeps its own package version; “latest”
means the version shipped in the installed Desktop release, not a separately downloaded npm version.
Desktop runs the bundled CLI through its Electron executable in Node mode. No user Node installation
or running Desktop window is required. Distribution metadata records both versions and the source commit.

The full CLI is unpacked under `resources/app.asar.unpacked/out/main/desktop-cli/`; native keyring
packages are also unpacked. The packaging gate executes the actual CLI and workers with an empty PATH,
checks native loading, distribution identity and workspace/build-path leaks. External agent CLIs remain
user-installed. Electron's Node-mode switch is removed from the CLI environment before Runtime composition.

## Registration and precedence

On macOS, an installed packaged app registers after its first window is created and before background
work begins. Development, mounted DMG and translocated apps do not register. Stable user-owned entrypoints
are `~/.pragma/bin/pragma` and `pragma-desktop`. Zsh (including ZDOTDIR), Bash login/interactive startup
and Fish configuration prepend that directory through identifiable blocks. Original user content and
permissions are preserved; a one-time backup is retained. Existing unowned entrypoints are never overwritten.
A targeted disabled marker outside cache preserves explicit removal across application restarts.

Windows NSIS changes from selectable user scope to administrator, all-users installation. Its existing
upgrade mechanism uninstalls the machine installation and the invoking user's prior HKCU installation,
passing `--updated` to preserve user data. Other users' private installations cannot be discovered or
removed through the invoking user's HKCU and are not scanned. Each such user must remove their old
private installation if one exists. Machine PATH registration places `<install directory>\bin` first;
`pragma.cmd` and `pragma-desktop.cmd` refer to application resources with relative ASCII paths. Upgrade,
repair and removal are serialized by a machine mutex and modify only the owned PATH entries and scripts.
Environment changes are broadcast; existing terminal processes keep their environment.

The repository has no application auto-updater. New installers perform upgrades and require elevation;
NSIS retains its elevate helper for a future electron-updater integration. No new update service is added.

Default command lookup prefers Desktop. Aliases, functions, current-directory lookup on Windows and
intentional PATH modifications remain user overrides. Other npm/pnpm/Homebrew installations remain
untouched and are usable by absolute path or an explicit `npx --package=@pqpo/pragma@VERSION pragma ...`.
No runtime version arbitration or automatic highest-semver selection is introduced.

## Management and protocols

The Execution-private `pragma manage` channel remains independent and ahead of public PATH entries.
Public registration grants no Execution credentials or new approval authority. Both distributions reuse
the Local Host Mission application factory and existing storage upgrade and future-version rejection rules.
This change does not alter persistent DSL/storage schemas or the versioned CLI JSON envelope. New
terminal-integration IPC methods are additive, with a runtime-validated snapshot. Human doctor output adds
local execution and PATH diagnostics without placing those fields in JSON/JSONL.

## Removal and failure handling

Settings exposes status, repair and removal. Windows operations request administrator elevation and
explicitly disclose their all-users effect. Registration failures do not block the window or Missions.
macOS removal deletes owned blocks/scripts only; backups and Pragma data remain. Moving the app to Trash
cannot execute an uninstall hook, so surviving launchers provide an actionable message. Reopening the
installed app refreshes launchers after moves or upgrades unless the user opted out.

## Validation

Local verification and the release matrix must cover complete packaged CLI/worker/native execution,
argument/stdio behavior, independent execution, other-version coexistence, idempotence, user config
preservation, removal opt-out, and installation upgrade. Platform installation and UAC behavior require
real Windows and macOS acceptance; mocks alone are not release evidence.

### Implementation verification (2026-10-11)

Local macOS x64 passed repository lint/typecheck/core gates, npm tarball auditing, packaged CLI/native
worker execution with an empty PATH, shipped-bootstrap stdin/argv/exit-code/environment isolation, Zsh
and Bash registration, removal/opt-out, symlink and permission preservation, management-channel regression,
and three-language Settings rendering and repair/removal interactions. The shared Local Host gate first
passed 932 cases with two failures (cross-process commit timeout and cold Flow command convergence); both
failed cases passed isolated reruns. No Local Host implementation was changed to mask those failures.

The native release matrix now gates Windows installer install/upgrade/coexistence/repair/removal/uninstall
and macOS registration including Fish. Those new Windows/Fish jobs and macOS arm64 were not executed on
this x64 Mac. Genuine previous per-user installer migration and interactive UAC remain release acceptance
requirements; the Windows same-version reinstall check is not presented as historical migration evidence.

Code review reproduced and fixed two boundary failures: atomic shell-config replacement previously
applied the process umask instead of preserving the original permissions, and the Claude ACP Node
worker forwarded Electron's startup switch to the external Claude CLI. Regression checks exercise a
strict umask and the external CLI environment, including managed-policy environment merging and
execution through the real Electron binary.
