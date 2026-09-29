# Core asset Git synchronization

Desktop replicates published Experts, ExpertTeams, Flows, RuntimeProfiles, managed ContextStore
bindings, Knowledge Bases and all user-managed Capabilities, including unreferenced definitions
and Skills. System-managed Capabilities are excluded. Individual asset Git associations remain
local. Only `pragma-sync/` belongs to this protocol; other repository paths are preserved.

## Repository format

The marker `pragma-sync/sync.yaml` declares `pragma.asset-sync-repository/v1`. It contains no asset
inventory, timestamps or content hashes. Definitions use Interpreter YAML formatting and current
resource schemas; stable IDs determine paths, so renaming an asset does not rename its files.

```text
pragma-sync/
  sync.yaml
  README.md
  experts/<id>.pragma.yaml
  teams/<id>.pragma.yaml
  flows/<id>.pragma.yaml
  flow-layouts/<flow-id>.yaml
  runtime-profiles/<id>.pragma.yaml
  context-stores/<binding-id>.pragma.yaml
  capabilities/<binding-id>.pragma.yaml
  capability-definitions/<capability-id>.yaml
  knowledge-bases/<store-id>/metadata.yaml
  knowledge-bases/<store-id>/files/<original-path>.md
  skills/<capability-id>/metadata.yaml
  skills/<capability-id>/files/SKILL.md
  skills/<capability-id>/files/<original-path>
```

README is a generated Chinese name/type/path index and is ignored on import. Knowledge metadata
retains names, descriptions, empty directories and per-file metadata. The actual file tree controls
file additions and removals; new files receive normal priority and manual activation. Skill files
retain original bytes, including binary content; executable flags come from the Git index. Users
can edit YAML and native files without maintaining a hash list. Import recalculates domain hashes
and canonical semantic fingerprints. YAML formatting, generated README, credentials and local
revision numbers do not affect fingerprints. Definitions and bindings are normalized through the
central Desktop binding policy.

The managed tree is limited to 150 MiB, 5,000 logical assets and Bundle's 20,000-file budget, with
existing Knowledge and Skill domain limits also enforced. Symlinks, path escapes, `.git`, portable
path collisions, unsupported marker versions and invalid data fail before publication. Once a
repository is initialized, a missing marker is an error, including for an empty asset collection.

## Transfer and recovery

Desktop's internal batch transfer service collects assets, prepares the complete incoming resource
graph and applies imports. Bundle and sync share native Knowledge/Skill reading and publication
helpers. Bundle retains localization, copies and installation catalog semantics; sync preserves IDs,
does not create unreferenced DSL bindings and does not write Bundle installation records.
Capability changes use the configured mutation coordinator, validate Expert tool selections and
retain existing credentials. Transfer preserves the imported definition: if MCP verification
observes a different tool snapshot, the revision is stored as `needs_attention` with
`imported_definition_changed` and is not activated. Review and retry in Studio adopts the observed
definition through the ordinary coordinator. Skills use candidate publication; unready revisions are not activated.
RuntimeProfile export includes only harness and model selection accepted by the authoritative
profile configuration schema. Missing runtimes, models, plugins or authentication produce
`needs_attention` with the existing readiness diagnostics and configuration actions. SecretStore,
provider keys, execution state, historical revisions and plugin packages are excluded.

Configuration and private state live in `~/.pragma/state/asset-sync/settings.json` and `state.json`,
using `pragma.asset-sync-settings/v1` and `pragma.asset-sync-state/v1`. A file lock serializes sync.
`restore-journal.json` stores target payloads, expected semantic versions, domain revision numbers and incoming baselines
under `pragma.asset-sync-journal/v1`. On retry, restore completes before reading a new remote head;
already identical publications are skipped. Knowledge metadata is canonicalized using domain
schemas; implicit parent directories are included before hashing. Expert plugin configuration and
secret binding references are retained, while secret values remain local. Import planning also applies the authoritative DSL unknown-field
preservation policy before journaling. Bidirectional sync republishes preserved fields, so an
interrupted compatible update has a replayable target matching the actual domain publication. A user change during interruption stops replay with
`asset_sync.restore_conflict`. Layout updates and deletions use expected semantic versions under
the layout file lock; deferred Knowledge/Capability deletion rechecks the journal's expected content
before domain revision checks. Revision checks also protect credential-only edits from concurrent deletion. Successful incoming baselines are saved before outgoing push, so a
push failure does not republish imported revisions. Startup recovery errors are reported through
the sync diagnostic without preventing the window from opening.

This is a deliberate cutover from the unused `pragma-core-assets.json` protocol. Old settings,
state and repository files are not read or automatically deleted. Existing DSL, Bundle and domain
storage compatibility mechanisms are unchanged. See [ADR 060](../adr/060-structured-core-asset-sync.md).

## Reconciliation

Each logical asset is compared with its successful synchronization baseline. A Flow and its layout
share a conflict choice; a Capability shares its bindings and definition or Skill payload. Context
bindings and Knowledge content have separate identities. Concurrent edits require “keep local” or
“keep Git”. Conflicted dependencies are deferred while unrelated assets proceed. There is no
file-level automatic merge in core asset sync.

Local deletion preserves remote data by default and supports explicit restore. Enabling deletion
upload only applies to subsequent local deletions. Git deletion uses domain deletion and reference
checks. Only changed managed files are written; confirmed removals remove their managed paths.
Push uses the system Git `user.name` and `user.email`, credential helper or SSH agent, with actionable
identity errors. No dedicated Pragma author is injected. Remote head competition causes a fresh
read and reconciliation, for at most three attempts, without force push.

The explicit automatic entry point respects `autoPush`: startup, publication callbacks and backup
after individual asset sync can upload only when enabled. Focus and network recovery pull only.
Manual “save and sync” or “sync now” remains bidirectional. A successful individual asset sync and a
failed overall backup are reported separately.

Individual Knowledge Base and Skill Git associations are a separate Studio feature intended for
sharing one asset's ordinary files with other agents.

Manual resolution validation uses each asset's existing domain limits. Knowledge text follows
the ContextStore content schema and its 1,000,000-byte UTF-8 storage budget; Skill text and the
merged package retain the 25 MiB limit. Conflict previews include side-specific sizes, including
binary files, and the byte total of unconflicted files so the editor can disable oversized
submissions immediately. IPC rejects oversized manual requests before invoking synchronization.
The final merged tree is validated before writing a journal or publishing a revision, including
when independent edits are merged automatically. These checks do not impose an aggregate Skill
package limit on Knowledge repositories.

Individual file conflicts can be resolved from the asset's Git settings. The editor presents the
base, local and remote text plus two Git-generated merge candidates. Both candidates already
include non-conflicting changes from both sides; they favor local or remote only at conflict hunks.
The renderer lazily loads CodeMirror 6 and its open-source unified merge view for a single editable
result, collapsed unchanged regions, viewport rendering, search, undo and per-hunk choices. Editor
state and accepted hunks survive file navigation; binary files use whole-file choices.
No language services, umbrella editor setup or remote scripts are loaded. Each conflicting path
requires an explicit local, remote, manual or deletion decision. Binary files require a version or deletion choice. Skill
resolutions retain executable modes and pass the existing Skill validation before publication.
Decisions apply to a snapshot of the binding, local revision and remote head. A changed snapshot
requires fresh decisions; edits remain available in the editor. Resolution uses the ordinary
publication journal and never forces a push. A locally published merge survives an interrupted
push and can be retried through synchronization.

Asset synchronization and the overall backup are reported separately. If asset synchronization
succeeds but the overall backup fails, the asset remains synchronized and the UI offers a readable
backup retry notice. IPC mutations use the common Desktop mutation envelope. Empty user-facing
asset descriptions remain empty in their asset payload; the centralized binding policy retains a
valid nonempty DSL binding description instead of rejecting synchronization.

The Settings overview distinguishes synchronization records from user-visible logical assets.
Every record carries a logical asset key, kind, and readable name. Multiple records that implement
one asset, such as a Flow and its layout or a Capability binding and definition, contribute one
asset to the overview. Context bindings and Knowledge content remain separate asset categories.
The UI groups these logical assets by kind, summarizes synchronized, attention, and failed counts,
and keeps record-level conflict and restore actions inside collapsed attention details. Settings, private state and the restore journal use the new asset-sync namespaces. Overview reads authoritative remote payload only when a remote-only
binding needs identity metadata; this read never reconciles assets, mutates local stores, or updates
sync state. Offline fallback resolves canonical Desktop-managed binding IDs through the centralized
binding policy and never guesses identity from mutable display names.
