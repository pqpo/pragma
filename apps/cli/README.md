# Pragma CLI

Pragma CLI runs the local Pragma Host from a terminal. It uses the same
`~/.pragma` data and SecretStore as Pragma Desktop, but does not require
Desktop to be running.

## Requirements

- Node.js 22 or later
- macOS (Apple Silicon or Intel) or Windows (x64)

Linux and other operating systems are not supported by this release.

## Install

```bash
npm install --global @pragma/cli
pragma version
pragma doctor
```

The package does not install a second Node.js runtime, run an installer
downloader, or modify your shell configuration. npm creates the `pragma`
command shim in its global prefix.

Set `PRAGMA_HOME` when an isolated Pragma data root is needed. The default is
`~/.pragma`.

The published package is an ESM package with an explicit `>=22` engine. It
contains the compiled CLI and one native keychain dependency only; it does not
download a payload, install a second Node.js runtime, or publish a consumer
lockfile.

## Use

Run `pragma --help` for the current command list. Read-only Mission and Board
commands can be used while Desktop is open. A mutation that conflicts with an
active owner reports a stable busy error; it does not silently enqueue a
different operation. Human checkpoints can be answered interactively or
returned as `input_required` for a later response.

For scripts and other AI tools, use `--format=json` or `--format=jsonl` and
inspect the process exit code.

## Upgrade, rollback, and uninstall

```bash
npm install --global @pragma/cli@latest
npm install --global @pragma/cli@<version>
npm uninstall --global @pragma/cli
```

Published versions are immutable. Install an explicit version to roll back;
pre-release versions use the `next` tag. Do not use `--force` to hide an
engine, platform, or `pragma` command conflict. The full PATH and binary
diagnosis procedure is in the [CLI distribution runbook](https://github.com/pqpo/pragma/blob/main/docs/usage/cli-release.md).

If Node.js 20 is used, npm may install the package with an `EBADENGINE`
warning when `engine-strict` is disabled, but the `pragma` bootstrap exits 2
before loading the main bundle. Install Node.js 22 or later instead.

## License

Pragma CLI is distributed under the [Pragma Source Available License 1.0](./LICENSE).
