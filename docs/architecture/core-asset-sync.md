# Core asset Git synchronization

Desktop uses one configured Git remote and branch to replicate the current published state of
Experts, ExpertTeams, Flows, Knowledge Bases, Skills, referenced non-Skill Capability definitions,
RuntimeProfile binding descriptions, and Flow layouts. The root `pragma-core-assets.json` file
uses protocol `pragma.core-asset-sync/v1`. Each item has a stable kind and resource ID, a canonical
content fingerprint, and a validated payload. Other repository paths are left untouched. The old
knowledge and Skill environment sync protocols are retired; no repository or state migration runs.
This is a breaking cutover: devices with only an old sync configuration show a persistent
notice to configure Core Asset Sync. The old Git repositories and settings are never read as
new sync sources, and synchronization does not resume until a new Git remote is configured.

Runtime profiles describe the original harness and model but do not install either on a new
device. Missing local selections appear as `needs_attention`; the affected Expert, Team, or Flow
cannot run until the user selects a compatible local Runtime and model in Studio. Capability
credentials and model provider credentials remain local. User plugins are not backed up.

The service reconciles each item against its last synchronized fingerprint. Concurrent edits to
one item require a local or Git choice in Settings. Local deletion does not remove Git data by
default; the deletion option affects future local deletions only. Startup, focus, and network
recovery pull from Git; published local changes schedule a push when automatic upload is enabled.
Manual Sync is bidirectional. The service uses non-interactive system Git credentials, never
forces a push, and writes local state atomically under a file lock. Its commits use a dedicated
Pragma author, so a device does not need a user-wide Git author configured. Local state retains
remote item summaries to keep deleted assets visible for manual restore. If a previously synced
repository loses its manifest, synchronization fails without deleting local assets. On
interruption the service compares fresh local and remote fingerprints and retries any incomplete
application.

Individual Knowledge Base and Skill Git associations are a separate Studio feature intended for
sharing one asset's ordinary files with other agents.

The Settings overview distinguishes synchronization records from user-visible logical assets.
Every record carries a logical asset key, kind, and readable name. Multiple records that implement
one asset, such as a Flow and its layout or a Capability binding and definition, contribute one
asset to the overview. Context bindings and Knowledge content remain separate asset categories.
The UI groups these logical assets by kind, summarizes synchronized, attention, and failed counts,
and keeps record-level conflict and restore actions inside collapsed attention details. States
remain on the v1 wire format. Overview reads authoritative remote payload only when a remote-only
binding needs identity metadata; this read never reconciles assets, mutates local stores, or updates
sync state. Offline fallback resolves canonical Desktop-managed binding IDs through the centralized
binding policy and never guesses identity from mutable display names.
