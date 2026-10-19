# Pragma CLI

Pragma CLI runs the local Pragma Host from a terminal. It uses the same
`~/.pragma` data and SecretStore as Pragma Desktop, but does not require
Desktop to be running.

## Requirements

- Node.js 22 or later for the npm distribution; Desktop supplies its own runtime
- macOS (Apple Silicon or Intel) or Windows (x64)

Linux and other operating systems are not supported by this release.

## Install

Pragma Desktop includes the complete CLI from its release. On macOS, open the installed app once;
on Windows, the administrator installer registers the commands. Open a new terminal and use
`pragma` or `pragma-desktop`, without installing Node. The bundled CLI updates with Desktop and keeps
its own CLI version number. Settings → General provides terminal integration status, repair and removal.

Desktop takes default PATH priority. Other CLI installations remain untouched and can be invoked by
absolute path or `npx --package=@pqpo/pragma@VERSION pragma ...`. Shell aliases/functions and deliberate
PATH changes remain user overrides. Windows registration/removal affects all users.

For an independent npm installation:

```bash
npm install --global @pqpo/pragma
pragma version
pragma doctor
```

The package does not install a second Node.js runtime, run an installer
downloader, or modify your shell configuration. npm creates the `pragma`
command shim in its global prefix.

Set `PRAGMA_HOME` when an isolated Pragma data root is needed. The default is
`~/.pragma`.

The published npm package is `@pqpo/pragma` and its global executable is
`pragma`. It is an ESM package with an explicit `>=22` engine. It contains the
compiled CLI and one native keychain dependency only; it does not
download a payload, install a second Node.js runtime, or publish a consumer
lockfile.

## Shared Desktop configuration

Configure Runtime Environments, model connections and credentials, and import resources in Desktop
first. Use the same OS user and `PRAGMA_HOME` for both apps, then close Desktop and run an imported
Expert, Team or Flow with the CLI. The CLI reads the saved Environment revisions and model connections;
PI uses the saved SecretRefs through the existing OS keychain, while Harness runtimes retain their
native authentication. Model or credential failures are reported instead of selecting another model.
If credentials require migration, open the current Desktop once and resolve the reported migration
before retrying. Existing Sessions retain their pinned Runtime identity and Environment revision.

```bash
pragma expert discover --format=json --interactive=never
pragma expert run expert:<16-char-id> --workspace /absolute/workspace \
  --prompt "Complete the task" --format=json --interactive=never
pragma mission get <MISSION_ID> --view result --format=json
```

No CLI environment editor, Bundle manager or alternative credential backend is added. Memory Evidence
capture, durable enrichment queueing and recall remain available when policy permits. Enrichment,
index maintenance and Learning require a live, configured Desktop on the same home; capturing Evidence
does not mean a Memory was generated. Knowledge/Skill publication still requires approval.

## Use

Run `pragma --help` for the current command list. Read-only Mission and Board
commands can be used while Desktop is open. A mutation that conflicts with an
active owner reports a stable busy error; it does not silently enqueue a
different operation. Human checkpoints can be answered interactively or
returned as `input_required` for a later response.

Useful read-only commands:

```bash
pragma expert discover "memory"
pragma mission list --executor expert:<16-char-id>
pragma mission get <MISSION_ID> --view summary
pragma mission get <MISSION_ID> --view result
pragma mission get <MISSION_ID> --view events --limit 20
pragma mission queue list <MISSION_ID>
```

`discover` accepts one selector. A canonical `kind:ID` is an exact match;
other selectors search executor names and descriptions. `--query` is the
keyword-search form and cannot be combined with a selector. Event pages return
a durable `nextCursor`; copy it into the printed continuation command.

`mission get --view summary|result|events` is backed by the Local Host query
projection. `chat` and `work` deliberately fail with `INVALID_ARGUMENT` until
their contracts are ready; use `--view events` or `mission watch` meanwhile.
The text renderers use stable Mission/queue columns, while JSON and JSONL stay
pure `pragma.cli-result/v2` and `pragma.cli-event/v2` protocol output. Use the
views printed by `pragma mission get --help` for the installed CLI version.

Runs wait for a terminal result by default. `--detach` returns after the durable
command is persisted (it may still be queued), and `--request-id` is optional
because the CLI generates one when omitted. Text mode prints the request,
Mission, and execution identities;
machine formats keep those identities inside the protocol envelope.
The CLI does not start a resident daemon; without a live Desktop/Host owner, a
queued receipt remains recoverable until a later Host or attached/resume call
consumes it.

Command-specific help includes usage, defaults, output format, idempotency,
and a copyable example, for example `pragma mission get --help` or
`pragma expert discover --help`.

For scripts and other AI tools, use `--format=json` or `--format=jsonl`, inspect
the process exit code, and treat `pragma --help` as the command-line capability
contract for the installed version.

The three documents have separate jobs: this README is the npm installation
and entry-point guide, the human guide explains interactive CLI/Mission
semantics, and the Agent/automation guide defines machine output, recovery,
and cursor handling.

- Human CLI guide → [docs/usage/cli.md](https://github.com/pqpo/pragma/blob/main/docs/usage/cli.md)
- Agent/automation guide → [docs/usage/cli-agent.md](https://github.com/pqpo/pragma/blob/main/docs/usage/cli-agent.md)

## Upgrade, rollback, and uninstall

```bash
npm install --global @pqpo/pragma@latest
npm install --global @pqpo/pragma@<version>
npm uninstall --global @pqpo/pragma
```

Published versions are immutable. Install an explicit version to roll back;
pre-release versions use the `next` tag. Do not use `--force` to hide an
engine, platform, or `pragma` command conflict. The full PATH and binary
diagnosis procedure is in the [CLI distribution runbook](https://github.com/pqpo/pragma/blob/main/docs/usage/cli-release.md).

If Node.js 20 is used, npm may install the package with an `EBADENGINE`
warning when `engine-strict` is disabled, but the `pragma` bootstrap exits 2
before loading the main bundle. Install Node.js 22 or later instead.

## License

Pragma CLI is distributed under the [GNU Affero General Public License v3.0 only](../../LICENSE)
(`AGPL-3.0-only`).
