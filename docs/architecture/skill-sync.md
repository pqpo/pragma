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
  bundle/<Bundle logical UUID>/
    skill.yaml
    files/**
```

Ordinary Skills retain their Capability UUID across devices. Bundle Skills use the portable Bundle
logical ID as their synchronization identity and retain each device's existing local Capability ID.
The manifest records names, descriptions, paths, sizes, SHA-256 digests, and executable bits.
Symlinks, hard links, undeclared files, invalid paths, binary content, oversized packages, and
integrity mismatches fail closed. Files outside the managed root are preserved.

## Reconciliation and activation

Remote-only Skills are imported, local-only Skills are published, and a one-sided change is copied
to the other side. Concurrent edits and delete-versus-edit changes create a whole-Skill conflict;
Pragma does not merge files. Local deletion upload is disabled by default.

Every incoming package passes the deterministic structure and safety validation used by Skill
revision approval. Updates append through the Capability revision coordinator so current Project and
System Expert bindings advance consistently. Remote deletion uses the ordinary Capability deletion
boundary and cannot remove a referenced Skill.

Desktop startup, window focus, and network-online events perform pull-only refreshes. A successful
local Skill publication schedules a full sync when automatic upload is enabled. Manual sync is
bidirectional. Git uses the system credential helper or SSH agent; remote URLs cannot contain
credentials, and publishing requires the user's global Git identity.
