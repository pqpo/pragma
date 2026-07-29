# Desktop Bundle Transfer

Pragma Desktop can export one custom Expert, Expert Team, or Flow from Studio as a
`.pragma.bundle`. The file is an ordinary ZIP archive intended for transfer between computers.

## Export

Open Studio and use **Export** in the sidebar. Select the root object and the modules that should
travel with it:

- **Capabilities** includes portable Skills and service definitions.
- **Plugins** includes user-installed plugin packages when available.
- **Knowledge bases** includes their Markdown content and is off by default.
- **Flow layouts** includes canvas positions and viewport state.

The root's referenced Experts, Teams, Flows, Capability resources, ContextStore resources, and
RuntimeProfile resources are always included as canonical Pragma DSL. Turning a module off omits
its payload, not the DSL dependency, so the destination can guide the user through binding it.

Secrets, local sessions, Missions, usage data, workspace files, provider accounts, and absolute
local paths are excluded.

## Import

Use **Import** in Studio and choose a `.pragma.bundle`. Desktop validates the ZIP, file hashes,
Pragma YAML, and lock before writing local state.

If resources conflict, choose explicitly:

- **Import as a copy** creates new resource identities and rewrites internal references.
- **Update matching resources** keeps the local identities and replaces their definitions.

Desktop automatically reuses exact Runtime/model, capability, knowledge-base, and plugin matches.
Included portable payloads are installed automatically. Everything else appears in **Finish local
setup**.

The imported object remains visible and persisted while setup is incomplete, but it cannot create
or run a Mission. This gate also applies when another Flow reaches the pending object indirectly.
Save all required bindings and secrets to move the installation to `ready`.

If Desktop closes during import, the installation is marked failed at the next startup. Selecting
the same bundle again performs a fresh validated retry. Incomplete copy imports can also be
discarded from the import dialog; update imports are not automatically rolled back because doing so
could overwrite later project work.
