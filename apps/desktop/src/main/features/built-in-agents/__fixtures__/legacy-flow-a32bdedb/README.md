# Historical Flow handoff fixture

`draft.json` and `prepared-change.json` were written by the unmodified Desktop project adapter
from main commit `a32bdedb`, obtained with `git show`. The writer was executed with a temporary
real Project repository, empty Runtime/capability catalogs, createFlowDraft, updateFlowDraft and
prepareFlowDraft. It created the complete Human Flow in these files; no current object was
relabeled by changing a version or removing owner fields.

The exact writer path/hash and generated IDs are in provenance.json. The shared Flow draft DTO
and pragma/v5 contracts are unchanged since that commit. Current packages supplied the same
contracts while executing that historical writer; the product adapter/writer itself was historical.
The temporary writer and temporary Project were removed after generation.

The old records have no command owner metadata. Recovery tests copy these bytes unchanged,
verify rejection before explicit approval, preserve both files during handoff, resume editing and
commit with independent approval. Future/corrupt data checks modify only per-test copies.
