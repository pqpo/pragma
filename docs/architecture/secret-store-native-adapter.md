# SecretStore native adapter selection

`@pragma/local-host` uses `@napi-rs/keyring@1.3.0` as the OS keychain adapter. The package is a
N-API binding to keyring-rs and exposes binary secret reads/writes without invoking `security`,
`cmdkey`, PowerShell, or a shell. It maps Darwin to the Login Keychain and Windows to Credential
Manager. Unsupported platforms, a locked keychain, and user denial remain explicit errors; there
is no plaintext, file-key, environment-key, or machine-derived fallback.

The adapter is intentionally contained below the Local Host Node boundary. Browser packages and
`@pragma/core` do not import the N-API package. Its keychain identity is stable per canonical
Pragma data home plus the explicit install namespace: `com.pqpo.pragma.secret-store` /
`home:<sha256-home-id>:master-key:v1`. Desktop and CLI pass the same canonical data root; the
SecretStore subdirectory is not part of this identity. A missing master-key entry is only created
for an empty store. Any ref, immutable object, manifest, or migration evidence makes the condition
fail closed as `SECRET_MASTER_KEY_MISSING`, preserving the existing evidence.

Store roots and atomic-write parents are hardened to `0700` on POSIX, files and lock owners to
`0600`; rename durability includes a parent-directory sync where the platform supports it. Windows
uses its capability-gated filesystem behavior and never falls back to a plaintext or file master key.

Release gate: verify native loading in Node >=22 and Electron Main on macOS x64/arm64 and Windows
x64 from the packaged application before publishing. The dependency is pinned in `pnpm-lock.yaml`;
the release SBOM must include the package and its platform packages.

## M5 supply-chain audit (2026-08-24)

- Direct production dependency: `@napi-rs/keyring@1.3.0` (exact version; no range) in
  `@pragma/local-host`.
- License: `MIT`, verified from the installed package manifest.
- `pnpm-lock.yaml` pins the package and each optional native binary with immutable SHA-512 integrity.
  The supported release binaries are `darwin-arm64`, `darwin-x64`, and `win32-x64-msvc`; the lock
  also retains the upstream optional variants, which are not released by this product.
- The full release SBOM must be generated from the packed Desktop/CLI artifacts and compared against
  this lock entry. Windows packaging verification is environment-limited here and is deferred to
  M10/CI; it is not represented as a passed local test.
