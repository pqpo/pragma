# Individual knowledge and Skill Git synchronization

Studio can associate one managed knowledge base or user Skill with one Git repository and branch.
The asset occupies ordinary repository files: Markdown documents and YAML metadata sidecars for
knowledge, and the complete Skill tree rooted at `SKILL.md`. New local directory imports omit `.git` at every directory level for
both asset types. Studio's Knowledge and Skill file browsers hide and reject `.git` paths. Older
immutable revisions retain their original internal file and hash semantics. Knowledge synchronization preserves other repository files; Skill
synchronization owns the repository file tree. One configured remote address and branch can be
bound to only one asset on a device.

Import creates a local asset from an existing repository. Binding an existing asset starts with an
unbased three-way reconciliation: distinct paths are combined, while different content on the same
path is reported as a conflict. Later syncs compare the last synchronized local revision with the
current local revision and remote branch head. Independent file edits and deletions propagate in
either direction. Concurrent changes to different lines of a UTF-8 text file use Git's three-way
merge. Conflicting edits, binary files, and competing executable-bit changes are reported by path;
neither side is overwritten. Git pushes use the user's configured identity and credential helper
or SSH agent, with no force push. Incoming files are validated and published as a local revision
before a Git push. A remote head race causes a fresh fetch and merge attempt.
Skill executable flags come from the Git index and are recorded in the local revision definition;
sync and ordinary Skill revisions carry those flags when a filesystem cannot reliably retain
executable mode bits.

Desktop stores only the remote address, branch, last local revision, remote commit, status, and a
small retry journal in `~/.pragma/state/asset-git/`. Each operation uses a temporary shallow Git
checkout and removes it afterward. On interruption after a push or local publication, repeating
Sync re-evaluates the current local revision and remote head, then clears the journal once both
sides agree. Removing the asset association deletes its local binding and journal; it does not
delete the remote repository.

This is separate from [core asset sync](core-asset-sync.md), which backs up the Desktop's
published Experts, ExpertTeams, Flows, RuntimeProfiles, ContextStore bindings, Knowledge Bases,
Skills and all user-managed Capability definitions as categorized YAML and native files under
`pragma-sync/`. Automatic overall backup respects its own `autoPush` setting. Individual asset associations remain local to the device;
the core asset repository does not clone another asset repository on restore.

## Knowledge document metadata

Knowledge Git repositories also contain a reserved `.pragma/metadata/` tree.
Each Markdown path maps to the same path below this directory with `.yaml`
appended: `guides/setup.md` maps to `.pragma/metadata/guides/setup.md.yaml`.
These sidecars are Git-managed configuration, not knowledge documents; Markdown
bytes are unchanged. Knowledge-base names, descriptions and device bindings are
not part of this protocol.

```yaml
schemaVersion: pragma.knowledge-document-metadata/v1
description: Development environment setup
trigger: manual
priority: high
trustLevel: workspace
sensitivity: internal
```

`trigger` and `priority` are required. `description`, `trustLevel`, and
`sensitivity` are optional and follow the Desktop document metadata contract.
Removing an optional field explicitly clears it. Sidecars are UTF-8 YAML with
unique keys, no aliases, no unknown fields, and a 64 KiB file limit. Unsupported
YAML tags and version directives are rejected. Future
protocol versions fail closed. Symbolic links into or inside the reserved tree,
invalid mirrored paths, and orphan sidecars are rejected before a local revision
is published or Git is pushed. Existing local documents cannot occupy the
reserved directory; move them before binding or syncing.

Import restores all document metadata. When a sidecar is missing, an existing
document retains its metadata; a new document receives `trigger: manual` and
`priority: normal`. Sync writes missing sidecars, including those removed manually.
A content-only import is therefore pending until its first metadata sync.

Metadata uses field-by-field three-way merging, independent of YAML formatting.
Changes to different fields merge automatically. Conflicting changes to the same
field appear as a YAML file in the existing conflict editor, whose favored merge
previews include the other automatically merged fields. Local and remote choices
select that side's conflicting fields while retaining all independent edits.
Metadata conflicts offer local, remote, and validated manual choices;
the delete action applies to documents. Every manual YAML decision is validated
even when its associated document is deleted in the same resolution. Deleting a
document also removes its sidecar. Deletion against a content
or metadata edit is one document conflict, and choosing a side applies to both
content and metadata. Removing only a sidecar never resets metadata.

## Association state upgrade

Association records and sync journals now use `pragma.asset-git/v2` and
`pragma.asset-git-journal/v2`. `knowledgeMetadataVersion: 0` denotes a content-only
baseline; `1` denotes a baseline including document metadata. Skill synchronization
retains its existing behavior.

A statically registered v1-to-v2 step upgrades both files at the target's first
access under its storage lock. Original files are backed up by their byte hash;
the Core atomic migration journal supports replay after either replacement.
Identity-only association enumeration does not upgrade other targets. Corrupt or
future versions fail closed with `asset_git_state_upgrade_failed` and retain the
source files. The knowledge revision storage format is unchanged.

For a content-only baseline, the first metadata synchronization reconciles existing
sidecars without treating the previous local metadata as a shared Git baseline.
Missing sidecars inherit local metadata; differing fields present on both sides
require a decision. After success, the local snapshot is the metadata baseline.
An interrupted v1 transaction with a durable published revision first resumes its
original content-only result, then performs full metadata synchronization in the
same operation. V2 transaction recovery includes metadata and preserves the
existing no-force-push, remote-head-race and local-revision checks.

Association enumeration checks the local authority directory before scheduling a target. A
missing Knowledge store or Skill is unbound through the ordinary target lock, removing its
association and pending sync journal. Persisted but unreadable assets retain their association
and diagnostics. This also repairs interruptions between authority deletion and Host cleanup.
The existence check is made under the target lock. Repository uniqueness checks ignore
associations to absent authorities, so reimporting does not depend on first opening the overview.
