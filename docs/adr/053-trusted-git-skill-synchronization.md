# ADR 053: Trusted Git Skill synchronization

## Status

Accepted.

## Context

ADR 052 requires human review before authoring workflows publish a Skill. Cross-device replication
needs a distinct boundary: repeating authoring review prevents automatic synchronization, while
activating arbitrary remote content without validation could introduce unsafe instructions or
scripts. Bundle-origin Skills also use device-local Capability IDs.

## Decision

- Skill sync uses an independently configured Git repository and copies only current, published,
  non-system Skill snapshots.
- Configuring the repository marks it as a trusted replication source. A one-sided remote change may
  activate without another authoring review only after full deterministic Skill validation. This is
  the synchronization exception to ADR 052; authoring flows still require review.
- Remote updates append through the Capability revision coordinator. Invalid content never changes
  the formal Skill, synchronization base, current Project, or System Expert customization.
- Ordinary Skills use their Capability UUID as portable identity. Bundle Skills use
  `origin.logicalId`, preserving an existing local Capability UUID.
- Concurrent changes are resolved as complete local or remote snapshots. Local deletion upload is
  opt-in, and remote deletion still uses normal reference and deletion protections.

## Consequences

Published Skills converge across trusted devices without copying drafts or history. The repository
can change active Agent behavior, which is disclosed in settings and bounded by deterministic
validation. Concurrent Bundle-source and Git changes become explicit conflicts.
