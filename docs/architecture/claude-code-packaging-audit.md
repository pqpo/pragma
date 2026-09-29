# Desktop Claude Code packaging audit — issue #327

Claude Code is a user-installed prerequisite on every platform. Desktop ships the
ACP adapter, Agent SDK JavaScript and `claude-acp-worker.js`, but never the SDK's
Claude CLI, including the executable matching the installer architecture. There
is no automatic download or implicit SDK fallback.

## Published artifact comparison

The September 29, 2026 investigation downloaded the actual GitHub Release assets
from [v0.2.46](https://github.com/pqpo/pragma/releases/tag/v0.2.46) and
[v0.2.47](https://github.com/pqpo/pragma/releases/tag/v0.2.47). macOS ZIPs were
extracted; Windows NSIS installers were extracted with 7-Zip, followed by their
embedded `$PLUGINSDIR/app-64.7z`. The inventory includes `app.asar` members,
`app.asar.unpacked`, production `node_modules`, and all extra resources.
Sizes below are bytes, with MB using decimal units.

| Target                                | v0.2.46 installer | v0.2.47 installer | Resources before | Resources after | Unneeded CLI bytes |
| ------------------------------------- | ----------------: | ----------------: | ---------------: | --------------: | -----------------: |
| macOS arm64 (DMG size; ZIP inspected) |       265,482,519 |       462,425,049 |      488,850,141 |     959,629,742 |        442,819,600 |
| macOS x64 (DMG size; ZIP inspected)   |       271,581,646 |       468,516,811 |      498,252,591 |     969,032,196 |        442,819,600 |
| Windows x64 (NSIS inspected)          |       230,740,886 |       534,229,793 |      590,143,044 |   1,523,146,277 |        905,026,896 |

The following files are new in v0.2.47. Paths are relative to
`Resources/app.asar.unpacked/node_modules/@anthropic-ai/` on macOS or
`resources/app.asar.unpacked/node_modules/@anthropic-ai/` on Windows.
All four dependencies are version 0.3.280.

| Dependency / file                         |       Bytes | Present in macOS arm64/x64 | Present in Windows x64 |
| ----------------------------------------- | ----------: | -------------------------- | ---------------------- |
| `claude-agent-sdk-darwin-arm64/claude`    | 217,254,576 | Yes                        | Yes                    |
| `claude-agent-sdk-darwin-x64/claude`      | 225,565,024 | Yes                        | Yes                    |
| `claude-agent-sdk-win32-arm64/claude.exe` | 225,107,104 | No executable              | Yes                    |
| `claude-agent-sdk-win32-x64/claude.exe`   | 237,100,192 | No executable              | Yes                    |

ASAR contains **unpacked references** to these files, not a second binary copy.
Both macOS packages also contain Windows platform package metadata in ASAR,
but not their executables. Lockfile presence alone therefore does not establish
binary inclusion. No Linux CLI payload appeared in these published artifacts.

Other large newly included files: the unpacked ACP worker (3,188,548 bytes on
macOS, 3,185,788 on Windows), SDK `sdk.mjs` (1,585,922), `bridge.mjs`
(1,507,701), and `browser-sdk.js` (1,437,026). The worker embeds SDK JavaScript
while the production dependency graph also includes SDK JavaScript. Those are
retained; this fix does not delete the SDK or broadly disable optional native
modules. Renderer assets and generated chunks also changed across the releases.
After subtracting CLI binaries, the physical resource delta is 27,960,001 bytes
on macOS arm64, 27,960,005 on macOS x64, and 27,976,337 on Windows. These numbers
include metadata and other changes; compressed installer differences cannot be
attributed byte-for-byte from uncompressed inventory.

## Packaging boundary and regression gate

`electron-builder.yml` excludes all `claude-agent-sdk-*` platform packages,
`@anthropic-ai/claude-code`, and historical SDK CLI/vendor layouts on every target.
It preserves SDK JavaScript and the explicitly unpacked ACP worker.

The `afterPack` hook in `apps/desktop/scripts/audit-packaged-app.mjs` reads the
actual ASAR and recursively inspects unpacked/extra resources. It rejects CLI
packages and names, old embedded layouts, renamed Mach-O/PE/ELF binaries inside
the SDK, and unexpected SDK files larger than 5 MiB (including renamed scripts).
It also verifies that the worker exists outside ASAR. SDK size growth requires
review; other runtimes' native modules remain allowed. A failure blocks creation
of installers on all three Release matrix jobs. Each job uploads a full JSON
inventory with largest files and physical resource bytes as a separate artifact.
ASAR unpacked-reference entries are labelled so downstream comparisons avoid
double counting.

Run the fixture gate with `pnpm --filter @pragma/desktop test:packaging` (also
part of `test:core`), or inspect an extracted package with:

```sh
node apps/desktop/scripts/audit-packaged-app.mjs /path/to/resources > audit.json
```

Availability probes return `claude_cli_unavailable` and installation/path repair
guidance for invalid external CLIs. Shim parsing errors are contained in Claude
availability; command resolution occurs when opening a session so Host runtime
composition remains safe and a new user installation can be discovered. The
worker requires `CLAUDE_CODE_EXECUTABLE` before running ACP and preserves the
Host-selected value across managed-policy environment initialization, preventing
upstream SDK discovery or policy replacement of the validated command. Native installers,
Windows npm/pnpm shims, and paths containing spaces remain supported.

## Initial fixed local artifacts and execution evidence

Local packaging and real-runtime validation results are recorded below after
building the fix. Cross-compilation and package inspection do not substitute for
native Windows or Apple Silicon runtime/UI acceptance.

The fix was built locally from remote main
`4f905313c224c456cc371f6e8583d3fba16d441b`, keeping Desktop version 0.2.47
for comparison (these are validation builds, not a new Release).

| Target           | Fixed local installer bytes | Final extracted resource bytes | Claude payload violations |
| ---------------- | --------------------------: | -----------------------------: | ------------------------: |
| macOS arm64 DMG  |                 234,188,754 |                    419,696,999 |                         0 |
| macOS x64 DMG    |                 235,654,471 |                    418,003,249 |                         0 |
| Windows x64 NSIS |                 196,884,656 |                    470,481,726 |                         0 |

Fixed ZIP sizes: 234,194,365 bytes (arm64), 235,686,367 (x64). Both **final
ZIPs** and the **final NSIS installer** were independently extracted and audited
after packaging; SDK `sdk.mjs` and the unpacked worker were present in all three.
The Windows NSIS resources add `elevate.exe` (107,520 bytes) after `afterPack`;
it is included in the final inventory above. The macOS DMGs were generated from
the same audited applications.

These local sizes must not be treated as the size of the Claude-only reduction:
the fresh local dependency installation also lacked the unrelated Qoder SDK's
`dist/_bundled/qodercli` payload (109,231,616 bytes in published macOS packages)
and `qodercli.exe` (160,588,784 bytes in published Windows packages). The Qoder
SDK JavaScript remains packaged. This change does not filter Qoder files or
alter global optional-dependency policy. Native CI installer sizes can therefore
differ from these local measurements. The Claude binary totals in the published
artifact table are the directly established removable payload sizes.

macOS packaging used cached Electron 43.2.0 distributions because the host's
Node downloader rejected its certificate chain. The Windows Electron archive
was downloaded from the official Release and matched its SHASUMS256.txt:
`eba5f5088af40ecb364fe258809c79a5234c6ece5a75c64722772eba01b02786`.
Windows was cross-packaged on macOS with `win.signAndEditExecutable=false` for
local verification; the committed Release matrix retains native Windows
packaging and its normal executable editing policy.

Validation completed:

- Frozen-lockfile install, repository lint, repository typecheck, repository
  build, and core quick tests passed. Main, Preload/Bridge and renderer-style
  artifact verification passed. After the final test edits, focused lint and
  Claude runtime typecheck passed again.
- The ASAR/unpacked/extra-resource fixture audit passed. Focused Claude runtime
  validation passed 37 tests, including real subprocess availability checks for
  no installation, installation, non-executable/removal, paths with spaces,
  shim resolution failure containment, and existing ACP failure/compaction
  behavior. Existing simulated Windows native/npm/pnpm shim tests also passed.
- A fresh HOME/Pragma root and isolated Electron user-data directory booted the
  packaged macOS x64 app, registered the runtime environments, remained alive
  and recorded no error/fatal diagnostic events before graceful termination.
  macOS PATH recovery still discovers globally installed tools; absence of an
  external Claude CLI is established by the unmocked availability tests, rather
  than claimed from this startup smoke.
- The packaged x64 Electron executable ran the packaged worker (`--version`
  returned 0.81.2). Without `CLAUDE_CODE_EXECUTABLE`, the worker returned exit 1
  with explicit installation/path repair guidance.
- The real external Claude CLI was 2.1.195. The historical-session ACP smoke
  passed through the packaged Electron/worker, including two subsequent prompts,
  system/startup markers and reported usage. An initial run timed out during
  initialization under concurrent packaging; after packaging it passed in 10.4 s.
- Dedicated real probes through the packaged Electron/worker passed native Bash
  execution, managed MCP discovery/execution, and active-turn steering. Their
  receipts in the Host runtime-probe archive are
  `bmF0aXZlLXRvb2w-5291d3dd-c2c8-4880-baec-1a5d3328c7b5.json`,
  `bWNw-60eb83cb-802d-477c-8aed-27aee296aa8f.json`, and
  `c3RlZXJpbmc-61da0304-a53a-4416-8660-b769b888c779.json`.
  The initial aggregate `full` probe stopped on its text-stream ordering assertion
  during the native-tool step; its stream step passed, and the dedicated native
  tool/MCP/steering probes then passed. No assertion or capability readiness was
  weakened to accept that aggregate run.

Native Windows and Apple Silicon runtime/UI validation still require their
respective machines. Local cross-packaging establishes absence of CLI payloads;
the x64 execution results do not establish those platforms' execution matrix.

## Code review follow-up

The September 29 review checked the full change against issue #327, including
the upstream ACP command selection and policy initialization order. It confirmed
and repaired an additional fallback path: `applyManagedPolicyEnv()` could clear or
replace `CLAUDE_CODE_EXECUTABLE` after the initial guard. The worker now captures
the Host-selected external command and restores it after applying policy env.
Other managed-policy variables still apply.

A bundled-worker subprocess regression uses the real upstream policy env merger
with deterministic policy settings. Before the fix, clearing the command caused
an SDK CLI lookup and the external CLI invocation marker was absent. After the
fix, both clearing and replacing the command invoke the external CLI at a path
containing spaces; the marker also proves that unrelated policy env was applied.
Missing and whitespace-only command values exit with installation guidance, and
`--version` remains usable. The policy/external executable cases run on POSIX;
the missing-command and version cases also run on Windows.

Release verification now runs this worker regression separately from quick core
tests, together with availability, external installation and Windows shim tests.
The external installation test covers both explicit paths and discovery through
PATH before installation, after installation, after permission loss and removal.
The worker test can be run with `pnpm --filter @pragma/desktop test:claude-worker`.

The review also investigated two misleading live-probe failures:

- The historical-session smoke rejected any new reasoning that mentioned the
  old output marker. It now checks message identities from the real historical
  fixture and rejects replay of the complete historical output, while retaining
  recall, startup/system prompt and exact usage assertions.
- The aggregate probe treated an empty assistant segment before a tool call as
  text completion before any text delta. Core's conformance inspector now skips
  these empty segments for text ordering. It also reads completed text from both
  string snapshots and full assistant messages, strengthening duplicate/output
  checks. Regression cases still reject missing deltas, early nonempty completion
  and duplicated snapshots. Runtime execution and capability readiness are unchanged.

Review validation: repository core tests, 15 conformance tests, the bundled-worker
subprocess regression, 37 focused runtime tests, the extended PATH discovery
regression, Core/runtime typecheck, focused ESLint and formatting checks passed.
The final repository build passed all 19 tasks, including Main, Preload/Bridge
and renderer verification. All 74 generated Desktop files were compared byte for
byte with all three packaged applications and matched after the final review edits.
The latest packaged x64 app passed the historical-session smoke and the complete
real `full` probe: text streaming, native Bash, MCP, Skills, image/file/directory
attachments, native session refresh/resume, and active-turn steering. The new
successful receipt is `ZnVsbA-741d26ed-bc8e-4df2-8794-e6056b75e345.json` in the
same Host archive described above. Initial parallel runs timed out during ACP
initialization under packaging load; serial runs then identified and resolved
the two assertion problems. The original failed receipts remain evidence of the
investigation, rather than successful acceptance records.

The worker fix was rebuilt and all three installers were regenerated. Both final
macOS ZIPs and the final Windows NSIS installer were independently extracted and
audited again, with zero Claude CLI violations:

| Target           | Latest installer bytes | Latest extracted resource bytes | Violations |
| ---------------- | ---------------------: | ------------------------------: | ---------: |
| macOS arm64 DMG  |            234,186,669 |                     419,703,090 |          0 |
| macOS x64 DMG    |            235,997,431 |                     419,703,090 |          0 |
| Windows x64 NSIS |            196,983,828 |                     471,473,628 |          0 |

Latest ZIP sizes are 234,202,077 bytes (arm64) and 236,042,896 bytes (x64).
The dependency/environment and native-platform limitations above still apply.
There are no remaining confirmed defects in the reviewed changes. Native Windows
and Apple Silicon execution/UI acceptance, including Desktop operation on a
machine without an external Claude installation, remain pending; isolated
availability tests and clean-HOME startup do not constitute that complete matrix.
