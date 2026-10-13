# System Expert customization migration fixtures

`system-experts-v8.json` and `system-experts-v8-custom-bindings.json` were written by
`createDesktopSystemExpertRegistry.update()` from historical commit
`b4b3cc1ca537046e5324138efcbacbaf47a3fa3d`. The historical Desktop and Built-in Agents
sources were extracted with `git archive`; TypeScript import resolution used that
commit's Built-in Agents entry points, including its generated default call bindings.
The fixture generation used an isolated temporary configuration directory.

The first fixture customizes Pragma's name, avatar, instructions, model, Capability
selection and Context mount while retaining the historical default resource tools.
The second changes a call binding's description through the same historical writer,
representing genuinely customized bindings that must survive the upgrade unchanged.
Neither fixture was made by changing the version number of a current object.

`system-experts-v9.json` is the expected complete result of opening the first fixture
with the v9 registry. Tests compare the upgraded data and the untouched v8 backup,
and replay prepared, backed-up and target-written journal states.
