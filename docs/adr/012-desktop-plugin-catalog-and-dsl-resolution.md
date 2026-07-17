# ADR 012: Desktop Plugin Catalog and DSL Resolution

## Status

Accepted.

## Context

Expert plugins were loadable by Core, but Desktop Studio had no governed catalog, no distinction
between product-shipped and user-installed plugins, and no way to configure or activate a plugin per
Expert. A filesystem path in an Expert definition would also make the DSL machine-specific and would
not identify the exact plugin contents or credentials used by a compilation.

## Decision

Desktop owns a device-local plugin catalog with two origins:

- built-in plugins are immutable, versioned bundles shipped under the application's `plugins`
  resource directory;
- user plugins are imported only from ZIP archives after a preview and validation phase, then stored
  outside Agent workspaces under the Pragma application-data directory.

Every installed plugin is addressed by the exact reference `plugin:<id>@<version>`. An `(id,
version)` pair is immutable: importing different bytes for an existing reference is a conflict.
Desktop accepts only strict `pragma.plugin/v2` manifests and prebuilt, self-contained ESM entries.
It never runs package-manager installation or plugin build scripts. ZIP validation enforces archive
size and file-count limits, rejects escaping paths and dependencies, checks the manifest and package
version, and verifies the declared runtime entry before installation.

Plugin execution uses an explicit trusted-host model. A plugin declares `runtime.trust` as
`trusted-host` and executes inside the host Node process. Manifest permissions are mandatory
advisory disclosures for review and audit; they are not a sandbox and cannot constrain dishonest
plugin code. Import and activation UI must state that the user is trusting arbitrary code.

Desktop stores non-secret catalog defaults separately from plugin files. Secret values are encrypted
through Electron `safeStorage`; Expert and catalog records contain only binding references. Effective
configuration is merged in this order: manifest defaults, Desktop defaults, Expert overrides, then
resolved secret bindings. Required values and declared types are validated after merging.

The `pragma/v2` Expert DSL references plugins without local paths:

```yaml
plugins:
  - ref: plugin:memory@0.0.0
    config:
      task:
        enabled: true
    secretBindings:
      apiToken: binding:plugin-secret-memory-api
```

`@pragma/interpreter` does not discover or install plugins. The compile host must supply a plugin
resolver that maps each exact reference and binding set to a Core plugin source, effective config,
and verification fingerprint. Plugin fingerprints are included in the environment fingerprint so
the compiled environment records the installed bytes, Desktop defaults, Expert overrides, and
credential revision that were resolved.

## Consequences

- Built-in and user plugins share one Studio directory and configuration UI while retaining clear
  origin and deletion semantics.
- Experts activate plugins explicitly and can override catalog defaults without copying secrets into
  DSL or Expert JSON.
- A project that references plugins cannot compile in a host that has no plugin resolver or lacks the
  exact installed version.
- User plugins must be distributed as already bundled ESM ZIPs; dependency installation and arbitrary
  build scripts are intentionally outside the Desktop trust boundary.
- Plugin upgrades use a new versioned reference and require explicit Expert activation.
