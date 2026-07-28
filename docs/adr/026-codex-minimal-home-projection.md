# ADR 026: Codex minimal Home projection

## Status

Accepted.

## Context

ADR 016 isolated Codex Runtime Contexts with a private writable Home backed by a versioned cache
base. The base copied and fingerprinted the complete host `plugins`, `packages`, and `cache`
directories. Current Codex installations can keep hundreds of megabytes of plugin packages and
standalone releases there, even though an app-server Session only needs a small configuration
snapshot, its own mutable state, and access to the rebuildable native plugin cache.

Building the base made Session startup depend on the total host cache size. A symbolic link into the
base also did not enforce filesystem immutability, so the cost did not establish a complete
read-only boundary.

## Decision

Each Codex Runtime Context receives a minimal private `CODEX_HOME`:

- `sessions`, logs, temporary files, configuration, model-cache state, and Agent Skills are private;
- `CODEX_SQLITE_HOME` is a separate private directory;
- authentication is projected through Pragma's protected credential store;
- small user configuration files and a relative custom model catalog are atomically copied;
- a fresh Context may seed `models_cache.json`, bound to the effective provider and catalog
  configuration;
- the host `~/.codex/plugins/cache` is linked directly as shared, rebuildable cache;
- complete `plugins`, `packages`, generic `cache`, and host `sessions` trees are neither scanned nor
  copied.

If a host plugin cache exists but cannot be linked, Session preparation fails explicitly instead of
copying the tree or silently removing native plugin capability. Existing Pragma cache bases are not
deleted during preparation. The lease-aware storage maintenance path remains their bounded,
recoverable cleanup mechanism.

## Consequences

- Managed Home preparation is independent of host package and plugin byte size.
- Native plugin cache updates are visible across concurrent Contexts; it is explicitly classified as
  rebuildable host cache rather than authoritative Session state.
- Session history, SQLite databases, configuration, permissions, sandbox behavior, and Agent Skills
  remain isolated.
- Restoring a legacy Context replaces only known links into Pragma's old base and never follows them
  to delete the base.
