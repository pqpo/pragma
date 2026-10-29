# Core asset Git synchronization

Desktop replicates published Experts, ExpertTeams, Flows, Automations, RuntimeProfiles, managed ContextStore
bindings, Knowledge Bases and all user-managed Capabilities, including unreferenced definitions
and Skills. System-managed Capabilities are excluded. Individual asset Git associations remain
local. Only `pragma-sync/` belongs to this protocol; other repository paths are preserved.

## Repository format

The marker `pragma-sync/sync.yaml` declares `pragma.asset-sync-repository/v2`. It contains no asset
inventory, timestamps or content hashes. Definitions use Interpreter YAML formatting and current
resource schemas; stable IDs determine paths, so renaming an asset does not rename its files.

Repository `schemaVersion` and embedded DSL `apiVersion` are independent compatibility boundaries.
On repository read, each DSL file passes through Interpreter's registered adjacent migration chain
before current-schema validation, path/identity checks, fingerprints and reconciliation. Resources
from different supported DSL generations can coexist. The decoder does not mutate source files;
ordinary outgoing publication writes the current DSL while Git retains the original commits.
Future versions, missing migration paths, malformed historical fields and identity/path mismatches
are rejected before publication. Repository v1-to-v2 Skill metadata migration does not upgrade DSL.

The regression for the missed v5-to-v6 sync upgrade uses the unmodified compiler v9 Expert writer
fixture, plus a compiler v5 DSL v3 fixture for chained migration. Repository decoder tests cover
both repository marker generations and mixed DSL versions; real-Git integration covers first import,
interruption after Project publication, journal replay and idempotent retries. Both test files belong
to the existing required business gate. Future DSL upgrades must keep these ingress tests passing;
testing the Interpreter migration alone does not establish sync compatibility.

```text
pragma-sync/
  sync.yaml
  README.md
  experts/<id>.pragma.yaml
  teams/<id>.pragma.yaml
  flows/<id>.pragma.yaml
  automations/<id>.pragma.yaml
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
retain original bytes, including binary content; executable flags come from the Git index. Sync
uses SKILL.md frontmatter as the description authority. metadata.yaml retains a derived description
for indexing and discovery. Cached descriptions are normalized before fingerprinting, first publication,
and incremental updates. A metadata-only annotation does not change the Skill or create a revision.
The adjacent v1-to-v2 repository migration reads legacy independent descriptions without rewriting
original Git commits; later writes emit v2 caches. Name consistency remains required. Users
can edit YAML and native files without maintaining a hash list. Import recalculates domain hashes
and canonical semantic fingerprints. YAML formatting, generated README, credentials and local
revision numbers do not affect fingerprints. Definitions and bindings are normalized through the
central Desktop binding policy.

The managed tree is limited to 150 MiB, 5,000 logical assets and Bundle's 20,000-file budget, with
existing Knowledge and Skill domain limits also enforced. Symlinks, path escapes, `.git`, portable
path collisions, unsupported marker versions and invalid data fail before publication. Once a
repository is initialized, a missing marker is an error, including for an empty asset collection.

## Transfer and recovery

Desktop's internal batch transfer service in `features/asset-transfer/` collects assets, prepares the complete incoming resource
graph and applies imports. Bundle and sync share native Knowledge/Skill reading and publication
helpers and dependency readiness inspection. Neither shared transfer nor sync depends on the Bundle feature. Bundle retains localization, copies and installation catalog semantics; sync preserves IDs,
does not synthesize DSL bindings for unreferenced payloads and does not write Bundle installation records.
Capability changes use the configured mutation coordinator, validate Expert tool selections and
retain existing credentials. Transfer preserves the imported definition: if MCP verification
observes a different tool snapshot, the revision is stored as `needs_attention` with
`imported_definition_changed` and is not activated. Review and retry in Studio adopts the observed
definition through the ordinary coordinator. Skills use candidate publication; unready revisions are not activated.
RuntimeProfile export includes only harness and model selection accepted by the authoritative
profile configuration schema. Missing runtimes, models, plugins or authentication produce
`needs_attention` with the existing readiness diagnostics and configuration actions. SecretStore,
provider keys, execution state, historical revisions and plugin packages are excluded.
Automation definitions retain their schedules, enabled flags and executor references. Device-local
Automation bindings (workspace, model overrides and mounted Context Stores), queues, runs and
Mission/session state are excluded. A new device must configure its local binding before execution.
Incoming Automation publication refreshes running local schedules. Changes to execution identity
rotate the local binding generation through the existing replayable session reset operation, so
an old Mission cannot receive input intended for a different executor. An optional `operationId`
in the v4 restore journal identifies these host side effects; older journals acquire it atomically
before applying those effects. Replay retains the same identity and does not rotate twice.
Adding Automation is additive: existing repository, checkpoint and journal payloads retain their
meaning and remain readable without rewriting their versions.

Configuration and private state live in `~/.pragma/state/asset-sync/settings.json` and `state.json`,
using `pragma.asset-sync-settings/v2` and `pragma.asset-sync-state/v3`. A file lock serializes sync.
`restore-journal.json` stores target payloads, expected semantic versions, domain revision numbers and incoming baselines
under `pragma.asset-sync-journal/v4`. An adjacent v2-to-v3 journal migration normalizes stored Skill payloads and rewrites their expected
fingerprints and incoming baselines together, preserving domain revision expectations. Owner-local
atomic migration backs up old v2 bytes and replays under the existing lock; stale migration journals
cannot overwrite newer owner documents. The journal v3-to-v4 migration upgrades embedded DSL
through Interpreter and rewrites matching expectations, baselines and summary hashes together,
preserving revision expectations. State v2-to-v3 retains opaque historical checkpoint hashes;
reconciliation and overview normalize them only when an actual resource proves an equivalent
current fingerprint. Historical candidates use Interpreter's declared upgradeable DSL generations.
Each candidate must match a stored hash, pass the authoritative forward migration and reproduce the current content hash before its
historical hash can be recognized. Both local and remote candidates participate, so one-sided
edits and deletions retain their original meaning. Unproven baselines and genuine competing
changes remain conflicts. Neither upgrade clears baselines nor scans other owners. Settings remain v2.
On retry, restore completes before reading a new remote head;
already identical publications are skipped. Knowledge metadata is canonicalized using domain
schemas; implicit parent directories are included before hashing. Expert plugin configuration and
secret binding references are retained, while secret values remain local. Import planning also applies the authoritative DSL unknown-field
preservation policy before journaling. Bidirectional sync republishes preserved fields, so an
interrupted compatible update has a replayable target matching the actual domain publication. A user change during interruption stops replay and moves the operation into persisted logical
asset conflicts. Only completed stages advance their baselines; unresolved targets are replanned
against Git. Keep-local, keep-Git and explicit restore remain available, while unrelated assets can
synchronize. Removing configuration or changing source cancels unfinished stages under the same
lock without removing already published local data. Reconfiguration reconciles the retained assets
normally. A source mismatch after an interrupted configuration change also cancels the old operation
instead of applying targets from the wrong repository. Layout updates and deletions use expected semantic versions under
the layout file lock and run after successful Project publication. Flow deletion delegates layout
cleanup to the Project's existing removal journal, preserving the layout when publication conflicts
and completing cleanup after an interrupted committed deletion. Deferred Knowledge/Capability deletion rechecks the journal's expected content
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

Missing Context mappings are internal reconciliation work and are not exposed as user decisions.
Sync imports a missing Git mapping when its Knowledge authority exists locally. It uses ordinary
expected-content checks and the durable import journal; identities and configuration are retained,
no Expert is mounted, and no Knowledge revision is published. If its authority was deleted, mapping
and authority deletions follow the baseline rule together rather than resurrecting Knowledge.

Local deletion requires confirmed authority absence: a Knowledge/Capability directory that still
exists but cannot be listed is unavailable, never a deletion. Its Git copy and baseline are retained;
imports depending on it are deferred while independent assets proceed. Before publishing outgoing
deletions, sync recollects local assets and replans if a selected resource has reappeared.
Current-version overview snapshots use atomic reads without waiting for active network/import work;
actual protocol upgrades still acquire the aggregate lock before consumption. Active overview reads
do not load large import-journal payloads. Context metadata normalization retains unknown fields
through the authoritative forward-compatible resource schema.

Only conflicting content or deletion/reference competition needs a decision. Overview distinguishes
pending synchronization from conflicts and errors. Runtime, model, plugin and credential readiness
is an independent diagnostic: an unusable asset can still be successfully synchronized.
The v2 overview IPC envelope is versioned and validated by preload; all Desktop layers ship together.

Dependency deferral uses the selected resource version, not both versions' reference graphs.
An explicit keep-local choice checks the local version's references, including unresolved dependencies,
without inheriting edges from the old Git version.
The planned Git graph is checked before publication. A deletion competing with a retained Git
reference is a logical conflict that reports the referencing asset name; independent assets still
synchronize. Whole graphs removed locally can be deleted in one publication. Host-provided external
references are not exported and do not participate in this graph.

Incoming graph planning also checks the resulting local graph before import preparation, on
full, pull and automatic synchronization. A locally retained conflicting Expert blocks deletion of
its referenced RuntimeProfile as a persistent conflict, while unrelated changes continue. Keeping
the local Expert keeps its unchanged dependencies that were deleted remotely; competing dependency
edits remain decisions. Domain transfer reference validation still runs after planning.

Unreadable authorities keep their last-known identity in the optional `unavailableItems` checkpoint
cache until repaired or truly removed. This cache is separate from `remoteItems`, so a remotely
deleted resource remains diagnosable across refresh/restart without being counted as present in Git.

DSL imports compare each resource with its expected portable content before applying changes.
Binding metadata is normalized against the pre-import local authority, and the Project publication
keeps its base snapshot so concurrent edits during commit are protected by the existing change-set
checks. A changed target or a newly added reference to a pending deletion reports a typed conflict
with the affected synchronization keys. Recovery saves those conflicts before retiring its journal,
preserves completed stages, and replans pending stages from Git. Schema errors and transient failures
retain their replayable journal rather than being silently discarded.
Project revision conflicts use the store's conflicting resource references to defer only affected
resources; errors without precise attribution defer the Project batch. Missing unchanged Knowledge
or Capability authorities are attributed to pending incoming resources that reference them directly
or transitively, allowing recovery to persist actionable conflicts and retire the interrupted journal.

Capability and Knowledge deletion checks both Project DSL references and System Expert
references. All bindings to the local authority are removed before its files are deleted.
Knowledge deletion retains its Mission-unmount and revision-draft checks; interruption after
binding removal leaves a valid unbound Knowledge store that can be deleted again. Capability
deletion replays binding cleanup through its existing mutation journal.

Collection reconciles historical bindings only when their local authority directory is absent
and no retained resource references them. An asset omitted from a listing because its persisted
configuration is invalid remains unavailable and diagnosable. An external dependency blocks
only its own binding cleanup. Flow deletion through remove, change-set apply, or full publication
prepares a `pragma.desktop-flow-layout-removal/v1` journal under the Project's
`layouts/.removals/`, addressed by Flow identity and target Project revision. After publication,
and on the next Project-head access, cleanup holds the Project publication lock and rechecks
the current head under the layout lock. Concurrent orphan reconciliation refreshes the head on
revision conflicts or already-removed resources and rechecks each remaining binding's identity
and dependencies before cleanup, preserving bindings rebound by another publication.
A committed deletion removes the layout; a competing publication that retained the Flow cancels
the intent. Unpublished Flow draft layouts and immutable historical Project revisions are retained.
Future removal-journal versions are rejected without deleting a layout. Project access recovers
only that owner's pending layout removals; application startup does not scan other Projects.

Known local deletions propagate to Git automatically during bidirectional sync. A missing local
resource without a successful baseline is a remote addition and is imported. Remote-only edits or
deletions propagate to an unchanged local copy. Competing edits and deletion-versus-modification
remain conflicts. autoPush controls background upload; pull-only refresh leaves local changes queued
without individual decisions. Git history retains prior versions. The explicit targeted Git-delete
API still commits only the selected logical asset and rejects remaining references.

Settings, state and the embedded restore journal have static adjacent v1-to-v2 migrations. First
owner access holds the sync lock, validates all documents, backs up exact source files, writes one
stable migration journal and atomically replaces targets. Pending migration journals replay before
business reads; future versions, malformed data or missing chains fail closed without downgrading
newer documents. Historical ignored flags are removed while successful baselines survive: old queued
deletions reconcile normally, and absent resources with no baseline are never guessed to be deleted.
An interrupted v1 import is upgraded with its expectations intact and recovered before new planning.
No startup-wide maintenance or unrelated owner scanning is introduced. See [ADR 070](../adr/070-automatic-core-asset-reconciliation.md).

Only changed managed files are written; confirmed removals remove their managed paths.
Push uses the system Git `user.name` and `user.email`, credential helper or SSH agent, with actionable
identity errors. No dedicated Pragma author is injected. Remote head competition causes a fresh
read and reconciliation, for at most three attempts, without force push.

If the Git deletion committed before the local checkpoint was saved, retry treats a cached logical
asset absent on both sides as a completed deletion. It clears the group's baseline and conflicts without another commit or uploading unrelated local edits. Local reappearance still
blocks deletion, and an unknown key is rejected. Cached identities retain the same grouping even
when all of a group's remote records have already disappeared.

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
binding needs identity metadata; this remote read never imports assets or updates sync state. Local collection may remove
confirmed unreferenced bindings to deleted authorities as described above. Offline fallback resolves canonical Desktop-managed binding IDs through the centralized
binding policy and never guesses identity from mutable display names.
