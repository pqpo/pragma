# ADR 031: Interpreter-owned `.pragma` bundle protocol

- Status: Accepted
- Date: 2026-08-02
- Replaces the earlier Desktop-owned wire format; Desktop installation transactions remain Host-owned

## Context

An Expert, ExpertTeam, or Flow exported by one Host must be consumable by another Host and directly
loadable by `@pragma/interpreter`. A Desktop-specific archive cannot be the portable contract:
Desktop stores files, a Server may store database objects, and another Agent Host may not persist an
import at all.

Portable definitions and environment assets also have different semantics. DSL resources are stable
content; Runtime installations, credentials, local tools, plugin packages, and external artifacts
must be resolved by the destination environment. Rewriting portable resources during binding would
change their identity and make one archive mean different things in different Hosts.

## Decision

`@pragma/interpreter/ast` owns the versioned wire Schema and compatibility declaration. Version 1 is
`pragma.bundle/v1`. Every producer of v1 must emit the same manifest and every consumer uses the
Interpreter codec. Current `pragma.desktop-bundle/v1` archives are a separate legacy format and are
not accepted as `pragma.bundle/v1`.

The physical v1 container is ZIP with this logical structure:

```text
bundle.json
project/pragma.yaml
project/pragma.lock.yaml
project/**                         # project-local artifacts
assets/<requirement-id>/**         # optional transport payloads
extensions/<extension-id>/**       # versioned Host metadata
```

`bundle.json` is strict and records the bundle version and fingerprint, roots, compiler version,
portable project fingerprint, environment requirements, Host extensions, and a size/SHA-256 index
for every file other than the manifest. Archive limits, normalized relative paths, portable
case-collision checks, exact file-set checks, payload fingerprints, and project fingerprint checks
fail closed.

The portable project contains only the selected roots and their transitive DSL dependencies. Local
binding references are replaced with deterministic bundle binding slots. The manifest retains a
typed requirement without retaining the original Host-local identifier. Optional payload export is
provided through a Host port. Secrets are requirements and are never exported as values.

Loading and validation do not install Host assets. `bindEnvironment()` is the explicit side-effect
boundary: the Host inspects a requirement, lets its caller select a candidate where necessary, and
returns an immutable environment overlay. The Interpreter applies that overlay only while inspecting
or compiling. It never rewrites the loaded portable resources.

Unknown optional Host extensions are ignored. An unknown required extension blocks loading. Host
extension versions are independent from the bundle version and DSL compiler version.

`loadPragmaProject()` accepts an explicit YAML source or bundle file/bytes. The string shorthand
continues to mean a YAML entry path. Bundle loading verifies and extracts the portable project into
an Interpreter-owned temporary directory, and `PragmaProject.dispose()` removes it. Callers must not
depend on that temporary layout.

Encryption, signing, or enterprise envelopes are future outer containers. They decrypt or unwrap to
the same versioned bundle bytes; they do not fork the portable project semantics.

## Consequences

- Desktop, Server, and third-party Hosts share one format contract without sharing storage code.
- Interpreter owns selection closure, canonical DSL/lock generation, archive validation, binding
  diagnostics, and compilation; Hosts own persistence, candidate discovery, asset installation, and
  user interaction.
- Programmatic definitions require registered, named and versioned serializers. Objects compiled by
  the Interpreter reuse DSL provenance directly.
- Bundle, DSL, Host storage, and Host extension versions remain independent compatibility axes.
- Desktop is now a Host Adapter for this protocol. It delegates archive encoding/decoding,
  dependency closure, portable project validation, requirement identity, and typed resource
  localization to Interpreter APIs. Desktop retains only local conflict decisions, payload
  installation, resource binding, project persistence, UI, and the installation transaction.
- Desktop persists a localized project copy while keeping the decoded portable project immutable.
  One root is selected per installation when a Bundle declares multiple roots.
- Desktop installation state v3 records the wire `bundleVersion`, portable
  `sourceProjectFingerprint`, archive `bundleFingerprint`, and selected `sourceRootRef`. The v2 to
  v3 adjacent migration identifies existing records as legacy without attempting to reinterpret
  their retained archives.
- `pragma.desktop-bundle/v1` is a hard compatibility cut. It is not decoded through a long-lived
  Desktop compatibility branch; users receive an offline v0.1.0 import and re-export instruction.
