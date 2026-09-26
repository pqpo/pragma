# Individual knowledge and Skill Git synchronization

Studio can associate one managed knowledge base or user Skill with one Git repository and branch.
The asset occupies ordinary repository files: Markdown files for knowledge, and the complete Skill
tree rooted at `SKILL.md`. New local directory imports omit `.git` at every directory level for
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
published Experts, ExpertTeams, Flows, Knowledge Bases, Skills, and referenced Capability
definitions in one Git repository. Individual asset associations remain local to the device;
the core asset repository does not clone another asset repository on restore.
