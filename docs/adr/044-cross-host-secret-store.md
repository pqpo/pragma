# ADR 044: Cross-Host SecretStore

## Status

Accepted

## Context

Electron `safeStorage` ciphertext cannot be decrypted by a standalone Node CLI after Desktop exits.
The supported Hosts must use the same local credentials without writing a master key or plaintext
secret to the filesystem.

## Decision

`@pragma/local-host` defines the Host-neutral `SecretStore` and OS-keychain ports. For each canonical
Pragma home, macOS Login Keychain or Windows Credential Manager stores one random 256-bit master key.
Each secret is persisted separately as a versioned AES-256-GCM envelope under the authoritative data
root. Envelope writes use canonical AAD, CAS, redaction, locks, journals, backups, atomic replacement,
and the owning package's adjacent migration chain.

Electron `safeStorage` is only a Desktop-only legacy decryption source for migration. The CLI never
imports Electron or attempts to decrypt legacy ciphertext; it returns
`SECRET_MIGRATION_REQUIRED`, `SECRET_STORE_LOCKED`, or `KEYCHAIN_UNAVAILABLE` as applicable. A failed
credential owner migration degrades only that owner and does not block unrelated commands.

## Consequences

- New secret plaintext, master-key files, environment-variable persistence, and shell/file fallbacks
  are prohibited.
- The Native keychain dependency must be proven for macOS x64/arm64 and Windows x64 in both Electron
  Main and Node.js >=22 before it is selected for release.
- Provider, Capability, and Plugin legacy migrations each require real historical fixtures, no-op,
  chain, crash-replay, and future-version rejection tests in their owning families.
