# Skill synchronization

Pragma synchronizes the current published state of every non-system Skill through a dedicated Git
repository. Drafts, revision jobs, historical revisions, credentials, bindings, Missions, and
built-in Skills remain local. The configured repository is an explicit trusted replication boundary:
one-sided remote changes may become active after deterministic validation, while concurrent changes
require user resolution.

## Portable repository format

```text
pragma-skill-sync.yaml
skills/
  capability/<capability UUID>/
    skill.yaml
    files/**
```

Every Skill is identified only by its local Capability UUID. Bundle import resolves conflicts before
the Skill enters the Studio: replacing a local Skill appends a local revision, keeping local makes no
change, and importing a copy creates a new Capability at revision 1. Bundle logical IDs and source
revision numbers remain transfer metadata and never become synchronization identity. The manifest
records names, descriptions, paths, sizes, SHA-256 digests, and executable bits.
Symlinks, hard links, undeclared files, invalid paths, binary content, oversized packages, and
integrity mismatches fail closed. Files outside the managed root are preserved.

Repository protocol v2 enforces this Capability-only identity. The v1 reader accepts only
`capability/<id>` entries. Because the legacy Bundle identity protocol was never released to users,
`bundle/<logicalId>` repository entries and persisted sync keys intentionally fail closed with an
instruction to reinitialize Skill sync; current reconciliation and conflict handling
never branch on Bundle provenance.

## Reconciliation and activation

Remote-only Skills are imported, local-only Skills are published, and a one-sided change is copied
to the other side. Concurrent edits and delete-versus-edit changes create a whole-Skill conflict;
Pragma does not merge files. Local deletion upload is disabled by default.

When configuring a target, `merge_and_publish` runs this same bidirectional reconciliation and
publishes local-only changes; it is not a local-authoritative overwrite. `restore_remote` applies the
selected target without publishing local candidates.

Every incoming package passes the deterministic structure and safety validation used by Skill
revision approval. Updates append through the Capability mutation coordinator. A ready revision
becomes the Capability's active revision after compatibility checks; ID-only Project and System
Expert bindings need no rewrite. Remote deletion uses the ordinary Capability deletion boundary and
cannot remove a referenced Skill.

Desktop startup, window focus, and network-online events perform pull-only refreshes. A successful
local Skill publication schedules a full sync when automatic upload is enabled. Manual sync is
bidirectional. Git uses the system credential helper or SSH agent; remote URLs cannot contain
credentials, and publishing requires the user's global Git identity. Source identity normalization
trims whitespace and trailing slashes only; a `.git` suffix remains significant for generic Git
servers.
