# Core asset Git synchronization

Desktop uses one configured Git remote and branch to replicate the current published state of
Experts, ExpertTeams, Flows, Knowledge Bases, Skills, referenced non-Skill Capability definitions,
RuntimeProfile binding descriptions, and Flow layouts. The root `pragma-core-assets.json` file
uses protocol `pragma.core-asset-sync/v1`. Each item has a stable kind and resource ID, a canonical
content fingerprint, and a validated payload. Other repository paths are left untouched. The old
knowledge and Skill environment sync protocols are retired; no repository or state migration runs.

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
