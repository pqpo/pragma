# Mission composer queue Design QA

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-e1e28ae0-142b-44e9-9369-5fb20b2836b2.png`
- Source pixels: 1615 × 370.
- Implementation screenshot: unavailable in this session; the in-app Browser control surface was not callable for this Electron application.
- Intended desktop state: an active Mission with one or more persisted queued messages and an empty composer.

## Full-view and focused-region evidence

The source image was opened at original resolution and used to measure the scoped composer treatment: queued content sits directly above a rounded white input, item actions sit at the right edge, and the bottom-right primary action is singular. The production implementation was verified through rendered component markup, CSS source, the Electron production bundle, and state-specific automated tests. A browser-rendered screenshot comparison could not be captured, so visual QA remains blocked rather than being inferred from code.

## Required fidelity surfaces

- Fonts and typography: existing Pragma application fonts and tokens are preserved. Queue labels use 13 px semibold text and the content preview uses 12 px muted text.
- Spacing and layout rhythm: queue items are 48 px rows inside the same 22 px rounded composer shell; the queue and textarea are separated by one subtle divider.
- Colors and visual tokens: the existing border, muted, green-soft, green-dark, focus-ring, and shadow tokens are reused.
- Image quality and asset fidelity: no raster asset is required. All actions use the installed Phosphor icon library.
- Copy and content: queue, steer, and remove/edit labels are localized in English, Simplified Chinese, and Traditional Chinese.

## Interaction and runtime checks

- New messages always submit as `enqueue`.
- Queue items are hidden from the ordinary chat stream and rendered above the input.
- Steer is shown only when the resolved Runtime reports `supportsSteer`, the current execution is interruptible, and the queued item has no attachments.
- Removing a queued item persistently cancels its queued Execution and places its text back into the composer.
- Empty composer during an active execution shows one interrupt button; non-empty composer shows one send button.
- Core focused tests: queued steer, queued removal, and queue clear all passed.
- Desktop full test suite: 131 files and 804 tests passed.
- Monorepo build: 22/22 tasks passed, including self-contained main and preload verification.
- Repository check: passed on the final tree.

## Findings

- [Blocked] A browser-rendered implementation screenshot and direct visual comparison are unavailable because the Electron in-app Browser control surface is not callable in this session.
- No P0/P1 functional or state-consistency findings remain in automated coverage.

final result: blocked

---

# Mission Memory Tab Design QA

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-b5b1e664-b537-4cd4-8617-5168fc64d0cf.png`
- Implementation screenshot: `/Users/linminqiu/.codex/worktrees/7deb/expert-mesh/artifacts/design-qa/mission-memory-activity.png`
- Store screenshot: `/Users/linminqiu/.codex/worktrees/7deb/expert-mesh/artifacts/design-qa/mission-memory-store.png`
- Combined comparison: `/Users/linminqiu/.codex/worktrees/7deb/expert-mesh/artifacts/design-qa/mission-memory-before-after-final.png`
- Viewport: 1440 × 900 CSS px
- Source pixels: 2880 × 1800
- Implementation pixels: 2880 × 1800
- Device scale factor: 2
- Density normalization: none required; both captures are the same pixel dimensions and 2× density.
- State: the same Mission (`我叫什么名字`) with the top-level Memory tab selected. The source shows Store as the nested default; the implementation intentionally shows Memory activity as the default.

## Full-view comparison evidence

The final side-by-side comparison confirms that the redesigned surface preserves the existing Pragma type scale, gray-green palette, borders, radii, header spacing, top-level tabs, Mission rail, and content width. The nested Store/Memory activity tab strip is removed. Memory activity now owns the page hierarchy, while Store is available through a compact secondary action.

## Focused region comparison evidence

The activity region was inspected at native 2× density. Summary cards remain legible without collisions, execution IDs truncate safely, metrics are separated into Evidence capture and ContextStore recall, and the Store action is visually secondary to the activity title. The Store view was separately captured and verified to expose one clear `Back to memory activity` action with no nested tab strip.

## Required fidelity surfaces

- Fonts and typography: existing application font stack and weight hierarchy are preserved. Activity title, card metrics, group labels, and metadata remain consistent with adjacent Mission UI.
- Spacing and layout rhythm: the second navigation bar was removed. The activity view uses a 24 px summary gap followed by compact execution cards; the Store back action sits outside the top-level tabs.
- Colors and visual tokens: existing `--surface`, `--surface-soft`, `--border`, `--muted`, and green semantic colors are reused. Warning color is reserved for non-zero attention counts.
- Image quality and asset fidelity: no new raster imagery is required. Existing product branding remains unchanged, and new controls use the installed Phosphor icon library.
- Copy and content: Evidence counts are explicitly labeled as published Evidence, not generated memories. Recall operations and attention states use accurate stage names.

## Comparison history

1. Initial implementation finding: **P2**, the long `已发布 Evidence（不是记忆条数）` label truncated inside the per-execution metric grid.
2. Fix: replaced the dense-card label with `已发布 Evidence`; retained the semantic clarification in the summary card and page description. Reduced uppercase styling on group headings for readability.
3. Post-fix evidence: `/Users/linminqiu/.codex/worktrees/7deb/expert-mesh/artifacts/design-qa/mission-memory-activity.png`; measured metric labels have no horizontal overflow at 1440 × 900.
4. Follow-up alignment pass removed Memory content horizontal and bottom padding. Activity and Store now share the top-level tab bounds exactly; the redundant `Memory ContextStore` heading was removed.
5. Store cleanup removed the explanatory preview copy and moved refresh into the scope row beside the root-memory formula.

## Interaction and runtime checks

- Default Memory view: activity.
- `Browse memory store`: opens the existing ContextStore browser.
- `Back to memory activity`: returns to the activity overview.
- Loading, empty, and error activity states keep the Store action available.
- Nested memory tab strip count: 0.
- Console errors during the Store round trip: 0.

## Findings

No remaining P0, P1, or P2 findings. No P3 follow-up is required for the requested desktop state.

final result: passed

---

# Mission Work Grid Density and Call Order Design QA

- Source visual truth path: `/tmp/codex-remote-attachments/019ffa47-9af9-7761-a21c-0185b818156a/7a9ddd45-9a81-48fb-8efe-e34cdc6f80ca/1-Photo-1.jpg`
- Implementation screenshots: `/Users/linminqiu/.codex/visualizations/2026/08/13/019ffa47-9af9-7761-a21c-0185b818156a/mission-work-single.png`, `/Users/linminqiu/.codex/visualizations/2026/08/13/019ffa47-9af9-7761-a21c-0185b818156a/mission-work-pair.png`, `/Users/linminqiu/.codex/visualizations/2026/08/13/019ffa47-9af9-7761-a21c-0185b818156a/mission-work-pair-compact.png`, and `/Users/linminqiu/.codex/visualizations/2026/08/13/019ffa47-9af9-7761-a21c-0185b818156a/mission-work-network.png`
- Hover-state screenshot: `/Users/linminqiu/.codex/visualizations/2026/08/13/019ffa47-9af9-7761-a21c-0185b818156a/mission-work-pair-hover.png`
- Combined comparison: `/Users/linminqiu/.codex/visualizations/2026/08/13/019ffa47-9af9-7761-a21c-0185b818156a/mission-work-comparison.png`
- Browser: Codex in-app browser.
- Viewport: 1280 × 768 CSS px at device scale factor 1; compact content container: 604 CSS px.
- Source pixels: 1280 × 960. Implementation pixels: 1280 × 768. The combined comparison keeps the source at native size and centers the implementation vertically without density scaling.
- State: Simplified Chinese; single expert, parent-child pair, compact pair, and nine-record three-level network; running, succeeded, waiting, and queued statuses.

## Full-view comparison evidence

The nine-record implementation matches the source's one-to-five-to-three delegation composition while making direction and order explicit. Eight non-root cards display stable `#1` through `#8` first-call badges, and all eight parent-child paths end in visible arrowheads outside their target cards. Single and pair modes concentrate the cards near the visual center instead of stretching a sparse grid across the canvas.

## Focused region comparison evidence

- The single expert card measures 320 px wide, uses the large avatar treatment, and shows a two-line task summary with no page overflow.
- The wide pair uses two 280 px cards connected horizontally from parent to child. At a 604 px content-container width the same pair stacks vertically, preserves the arrow direction, and introduces no document overflow.
- Computed styles report `mission-work-flow` for connector paths and `mission-work-status-breathe` only for the running status. The waiting status reports no pseudo-element animation.
- The existing avatar profile tooltip opens after hover and preserves its name, gender, and personality content.
- Browser console inspection found no warnings or errors.

## Required fidelity surfaces

- Fonts and typography: existing Desktop font family, weights, status hierarchy, truncation, and summary line height are preserved; call-order badges remain secondary to expert names.
- Spacing and layout rhythm: sparse modes use bounded 360/720 px surfaces; the full network keeps the existing 56 px delegation lanes and fits all three levels within the viewport.
- Colors and visual tokens: existing surfaces, borders, green text, semantic statuses, and focus tokens remain; connector and arrow colors are darkened only enough to restore direction legibility.
- Image quality and asset fidelity: existing built-in expert avatar assets and profile tooltip are reused without placeholders or generated replacements.
- Copy and content: call-order accessibility copy is localized in English, Simplified Chinese, and Traditional Chinese; the number represents each non-root expert's first invocation.

## Comparison history

1. P2 — The initial compact-pair check depended on a viewport media query, but Desktop has a 1080 px minimum document width and the mission content rail may narrow independently.
2. Fix — Replaced the viewport breakpoint with a named inline-size container query on the Work surface.
3. Post-fix evidence — A 604 px content container stacks both cards vertically, produces a downward arrow path, and has no horizontal or vertical overflow at the 1280 × 768 browser viewport.
4. User feedback — Offsetting sibling connector lanes created multiple parallel horizontal lines and weakened the shared delegation-tree structure.
5. Fix — Removed sibling lane offsets. Connections between the same two depth rows now use one shared midpoint trunk and keep arrowheads on the individual target branches.
6. Regression evidence — Left and right sibling paths both use the same `y=155` horizontal trunk while terminating 10 px before their respective target cards.

## Primary interactions tested

- Avatar hover opens the existing expert profile tooltip.
- Wide and compact pair layouts preserve parent-to-child arrow direction.
- All non-root cards expose call order in their accessible button labels.
- Connector dash flow and running-status breathing are active; reduced-motion CSS disables both animations.

## Findings

No actionable P0, P1, or P2 differences remain for the requested density, call-order, arrow-direction, or running-status changes.

## Follow-up polish

None required.

final result: passed

---

# Expert Team detail redesign QA

- Source visual truth: `/Users/linminqiu/.codex/generated_images/019fd758-727b-7323-abd6-a9a89012d2d5/exec-a9429985-31f5-424d-a68e-46d13e25c525.png`
- Selected direction: image 3 layout with image 2's light-gray application canvas.
- State: Studio → Expert Teams → team detail, with a white detail surface inside the light-gray Studio canvas.

## Fidelity review

- The former overview/capability card stack is replaced with one compact summary strip, a coordinator feature row, and a responsive three-column expert grid.
- The coordinator is first, has a green accent and role badge; the legend distinguishes coordinator and members.
- Expert IDs are omitted. Each resolved expert shows name, description, scope, Runtime, model, and capability counts.
- Team instructions are placed at the end in a native disclosure that supports expand/collapse.
- Existing Phosphor icons and the application's green/gray tokens are reused; no new gradients, decorative imagery, or hand-drawn icons were introduced.

## Interaction and runtime checks

- Expert names and “View expert details” actions open the existing Expert detail screen.
- The contextual back action returns to the originating team detail and restores the team view.
- Component render regression checks: 18 targeted Studio tests passed, including hidden IDs, expert metadata, role marker, and detail links.
- Desktop lint, typecheck, production Electron build, main-bundle verification, and preload verification passed.
- A live screenshot capture was not available from this Electron-only workspace session; the implementation was checked through rendered markup, source comparison, and the production bundle.

final result: passed

---

# Expert Studio design QA

## Comparison targets

- Expert directory reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-8d01cacc-d5c7-4512-bbf0-c7af71744d65.png`
- Expert detail reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-d2e5e09d-bbad-4c81-ad1e-fa01a8340b11.png`
- Expert creation reference: `/Users/linminqiu/.codex/generated_images/019f4eef-cbe3-7673-8c93-03cc10e04658/exec-715f6979-dbe7-4b83-bfd5-a0a29d5c9ea8.png`
- Historical implementation captures were removed after the comparison was completed; the
  findings below retain the durable QA record.
- Reference viewport: 1536 × 1024.
- Browser-rendered implementation viewport: 1280 × 720; the in-app browser capped the requested desktop viewport at this size.

## Findings

- No actionable P0, P1, or P2 differences remain.
- [P3] The 1280 px captures use tighter columns and a scrollable page height than the 1536 px references. No persistent control, content group, or primary action is clipped; this is the expected smaller-viewport adaptation.

## Fidelity review

- **Fonts and typography:** The existing Inter/system type scale, dark display headings, muted support copy, and mono-style IDs are preserved. Form labels and small metadata remain readable without truncation.
- **Spacing and layout:** The left application nav and Studio section nav are retained. The list uses one grouped directory surface with row separators; detail uses a focused header, metadata strip, instruction surface, and capability summary; creation uses a progressive four-step layout.
- **Colors and tokens:** Existing off-white, charcoal, forest-green, lime active rail, and gray-green divider tokens are consistently used. No gradients, decorative illustration, or high-elevation dashboard-card treatment was introduced.
- **Image and icon fidelity:** The targets contain no custom raster imagery. Existing Phosphor icons are used consistently, with no handwritten SVG or CSS-drawn icon substitutes.
- **Copy and API alignment:** The flow exposes reusable expert identity fields (name, id, description, tags, version, and scope), optional instructions, and model selection from configured providers. Workspace remains a run-time choice rather than part of the reusable declaration. Skills, tools, MCP servers, and plugins are preserved by the persisted definition but do not yet have dedicated editors. Per-run output schema, raw secrets, environment values, hooks, and logger internals are deliberately omitted.
- **Accessibility and states:** Native buttons, labels, search input, selects, keyboard-focus styles, semantic navigation, empty search behavior, validation feedback, selected steps, and disabled main-navigation items are present.

## Interaction evidence

- Clicking an expert row opens its detail view.
- **Back to Experts** returns to the directory.
- **Create expert** opens the four-step declaration flow.
- Empty Name, ID, or Description blocks the first step with an accessible alert.
- A completed draft persists a revisioned local expert definition and opens its detail view.
- Browser console contained no error-level messages.

## Comparison history

1. Captured and compared the initial directory, detail, and creation screens.
2. Added first-step validation because Name, ID, and Description are required by `defineExpert`.
3. Re-captured all screens and rechecked the core navigation and creation path.

## Follow-up polish

- Define the shared, executable Expert Manifest mapping before wiring these Desktop-managed declarations into `defineExpert()`; workspace and secret resolution must remain host responsibilities.
- Add dedicated editors for skills, tools, MCP servers, and plugins. The persisted data is preserved during identity/model edits, but only its summary is currently displayed.
- Replace the placeholder team and tool collections when their persisted domain models are defined.

final result: passed

---

# Desktop Flow 独立逻辑节点 Design QA

- Source visual truth: `/tmp/codex-remote-attachments/019f8ec1-027e-77a1-8620-204da8d4a872/f43dc8f8-cdaf-4eef-9e94-f3b081ab1252/1-Photo-1.jpg`
- Implementation screenshots and the combined comparison were used for local QA only and are
  intentionally not tracked in Git.
- Viewport: 1440 × 900 CSS px at DPR 2, light theme, real Electron renderer with preload bridge
- State: unsaved QA flow containing one Expert step with structured Boolean output `has_issue`, one derived logic node, and generated `true` / `false` branches

## Full-view comparison evidence

The source placed `Transition`, route output, raw cases JSON, and fallback JSON inside the Expert step inspector. The implementation removes those controls from the execution step and projects the same route transition as a separate purple logic node between the Expert step and downstream destinations. Both Boolean branches remain visible on the canvas and terminate independently.

## Focused-region comparison evidence

- Connecting the Expert result port to an unbound logic node automatically selected the only scalar structured output, `has_issue`.
- The inspector shows the reader-facing path `expert_1.result.has_issue · boolean`; the generated DSL saves `route: has_issue`, without the invalid `result.` prefix.
- Boolean output generates fixed `true` and `false` branch rows and matching canvas ports.
- Raw transition DSL is hidden under Advanced settings and is read-only.
- The structured-field select has one visible boundary in its normal state. Keyboard focus adds one clear outer ring without a nested input border.
- No renderer console or page errors were observed during drag, connect, panel toggle, focus, and Advanced-settings interactions.

## Required fidelity surfaces

- Fonts and typography: the existing Desktop system font stack, hierarchy, muted helper copy, and monospace branch values are preserved.
- Spacing and layout rhythm: the inspector follows the existing section/divider rhythm; the logic node aligns with existing Expert and terminal nodes after Auto arrange and Fit canvas.
- Colors and visual tokens: existing green workflow tokens remain unchanged; logic-specific identity uses the established purple accent with matching selected and inspector icon states.
- Image quality and asset fidelity: no raster UI assets were added; the new node uses the existing Phosphor icon set and remains sharp at DPR 2.
- Copy and content: the inspector explains the displayed result path versus the persisted root field, replaces raw JSON authoring with branch rows, and localizes the new controls in all three supported locales.

## Comparison history

1. The first draft showed the expected inspector but the graph was partially outside the narrowed canvas after Auto arrange. Applying the existing Fit canvas action after panel width changes restored the complete flow inside the visible canvas.
2. The initial QA graph contained an extra disconnected Expert node, reducing the fitted node scale. Removing that QA-only node produced the final focused graph evidence.
3. Post-fix evidence confirms the standalone logic node, inferred Boolean field, generated branches, Advanced DSL disclosure, responsive panel toggles, and keyboard-focus state.

## Findings

No actionable P0, P1, or P2 visual, interaction, or accessibility differences remain for the requested logic-node workflow. The QA draft intentionally remained unpublished because the local fixture only exposes an unavailable placeholder Expert; this does not affect the logic-node UI or transition serialization checks.

## Implementation checklist

- [x] Remove route authoring from the execution-step inspector.
- [x] Add a standalone logic node to the palette and canvas.
- [x] Infer scalar structured outputs from the upstream step.
- [x] Generate Boolean branches and visible branch edges.
- [x] Keep generated transition DSL under Advanced settings.
- [x] Verify normal and keyboard-focus control states.
- [x] Verify real Electron rendering and console state.

## Follow-up polish

None required for this change.

final result: passed

---

# Design QA: plugin declarations module

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-eb8eedca-421d-4bb3-bbae-0d36befc0a9e.png`
- Browser-rendered implementation: `/tmp/pragma-plugin-declarations-implemented.png`
- Side-by-side comparison evidence: `/tmp/pragma-plugin-declarations-comparison.png`
- Responsive evidence: `/tmp/pragma-plugin-declarations-narrow.png`
- Primary viewport and state: 1280 × 720, Simplified Chinese, Repository Manager plugin detail scrolled to Plugin declarations.
- Responsive viewport and state: 1100 × 720, the same plugin and declaration data.

## Full-view comparison evidence

The supplied source showed permissions and capabilities as two unrelated cards. The implementation places both under one Plugin declarations surface, preserves their distinct semantics, and uses the same group-header, count, item-card, and metadata-tag structure. The source and implementation were opened together in one side-by-side comparison input.

## Focused region comparison evidence

The complete declaration module is readable in the 1280 × 720 capture, including every permission value, capability name, capability type, and description. A separate crop was not required. The 1100 × 720 pass was inspected independently to verify the one-column responsive layout.

## Findings

No actionable P0, P1, or P2 findings remain in the requested scope.

## Required fidelity surfaces

- Fonts and typography: the existing Inter/SF system stack, mono permission values, heading hierarchy, and muted support copy are preserved. Capability names and types are now visually separated and no longer concatenate.
- Spacing and layout rhythm: one bordered module contains a shared heading and two balanced declaration groups. At widths below 1180 px the groups stack with a divider and no horizontal overflow.
- Colors and visual tokens: the module reuses the existing surface, soft-surface, border, green-soft, muted, and foreground tokens.
- Image quality and asset fidelity: no raster imagery is required. Shield and lightning icons come from the existing Phosphor icon library; no custom SVG, CSS drawing, or placeholder asset was introduced.
- Copy and content: all manifest permission values, capability names, capability types, and descriptions remain unchanged. New heading and support copy are available in English, Simplified Chinese, and Traditional Chinese.

## Interaction and runtime evidence

- The declaration content rendered from the real `PluginDetailFragment` with representative Repository Manager manifest data.
- The module contains no interactive controls; existing back and save actions remained present in the surrounding detail page.
- The 1280 px two-column layout and 1100 px one-column layout both rendered without document overflow.
- Browser console contained no warning- or error-level messages.
- Desktop component tests, renderer typecheck, and lint passed.

## Comparison history

1. The source showed separate permission and capability cards plus inconsistent bullet-list formatting.
2. Consolidated both into one Plugin declarations module with shared group headers, item counts, structured permission tags, and typed capability rows.
3. Captured the real component at 1280 × 720 and 1100 × 720; no clipping, overflow, or unreadable long content remained.

## Follow-up polish

None required for this scoped module consolidation.

final result: passed

---

# Main sidebar compression design QA

## Comparison targets

- Source visual truth: `/tmp/expert-mesh-design-qa-main-merge-fix/create-expert-fixed-1080.jpg`
- Browser-rendered implementation: `/tmp/expert-mesh-design-qa-sidebar/create-expert-sidebar-240-1080.jpg`
- Viewport and state: 1080 × 720, Studio → Experts → Create expert → Identity.

## Findings

- The 290 px primary navigation rail consumed excessive horizontal space and compressed the Create expert workspace.
- The expanded rail is now 240 px. No actionable P0, P1, or P2 differences remain for this scoped adjustment.

## Fidelity review

- **Spacing and layout:** The primary rail is 50 px narrower while its existing 20 px horizontal content padding, item rhythm, and navigation hierarchy are retained.
- **Collapsed state:** The existing 88 px collapsed width remains unchanged. Its internal horizontal padding is 8 px and the brand-row gap is 4 px so the logo mark and toggle fit without overflow.
- **Typography, colors, icons, and copy:** These remain unchanged; the update is limited to rail proportions and collapsed-state containment.

## Interaction and runtime evidence

- The sidebar collapsed and expanded successfully through its visible toggle.
- Expanded measurements at 1080 px and 1280 px matched the 240 px rail and showed equal document `scrollWidth` and `clientWidth`.
- Collapsed measurements showed an 88 px rail with equal sidebar `scrollWidth` and `clientWidth`; the brand row also had equal scroll and client widths.
- The Create expert Name field remained focusable and the browser console contained no error-level messages.

## Comparison history

1. The baseline capture showed the 290 px primary rail taking disproportionate space from the working area.
2. Reduced the expanded grid track to 240 px and re-captured the same Create expert state at 1080 × 720.
3. Exercised the 88 px collapsed state, found a 2 px internal overflow, and corrected its padding and brand-row gap.
4. Rechecked both expanded and collapsed states with no document or sidebar overflow.

## Follow-up polish

- None required for this scoped visual fix.

final result: passed

---

# Flow editor design QA

- Source visual truth: `/tmp/dify-workflow.png` (Dify workflow builder reference)
- Implementation screenshot: `/tmp/pragma-flow-final.png`
- Viewport: 1280 × 720, light theme, Desktop renderer
- State: a five-step Flow with a route, failure fallback, and bounded repeat transition; palette and inspector collapsed to prioritize the canvas
- Full-view comparison evidence: the source and implementation were opened together in one comparison input after the final capture. Both use a persistent workflow toolbar, dotted infinite canvas, typed nodes, visible connectors, collapsible authoring controls, and a minimap. Pragma intentionally retains its existing warm neutral/green visual tokens instead of copying Dify's blue palette.
- Focused region comparison: not required for the final gate because the full-view captures keep the toolbar, nodes, edges, minimap, and collapsed panel affordances readable. Inspector fields and validation states were separately exercised in the same browser session.

## Findings

No actionable P0, P1, or P2 findings remain.

- Fonts and typography: the implementation preserves Pragma's existing system and mono typography, with clear hierarchy between the Flow title, toolbar controls, node types, node names, and inspector labels.
- Spacing and layout rhythm: the editor now takes over the Studio content region, panels collapse to 52 px rails, the graph is centered at a readable minimum zoom, and persistent controls remain visible at the tested viewport.
- Colors and visual tokens: neutral canvas, green semantic accents, subtle borders, and error colors follow the existing Desktop token system while retaining the interaction structure of the reference.
- Image and asset fidelity: no raster product art is required. All visible interface icons come from the existing Phosphor icon library or React Flow itself; no placeholder drawings, emoji, or handcrafted SVG assets were introduced.
- Copy and content: authoring labels are concise and domain-specific (`Validate & publish`, `Auto arrange`, `Human input`, `Runtime routes`, `On limit destination`). Validation errors are translated into actionable language.

## Comparison history

1. Initial capture found a P1 canvas-width issue: the Studio section navigation, open palette, and open inspector left too little graph space. Fixed by letting the editor occupy the complete Studio content region, hiding the redundant Studio section rail while editing, and defaulting both authoring panels to accessible collapsed rails. Post-fix evidence: `/tmp/pragma-flow-final.png`.
2. Initial capture found a P2 node-readability issue on longer graphs. Fixed by applying a 0.55 minimum zoom for the initial canvas focus while keeping the explicit Fit control available for whole-graph framing. Post-fix evidence: `/tmp/pragma-flow-final.png`.
3. Validation review found a P2 raw-schema-message issue. Fixed by mapping common metadata failures to human-readable messages and labeling the toolbar badge as `Check` or an explicit issue count.
4. Interaction review found a P2 accessibility issue when collapsed panel text was visually hidden. Fixed with state-specific accessible labels for the node palette and inspector toggles.

## Primary interactions tested

- Open a new Flow editor.
- Add Expert, Human input, and Action nodes.
- Rename a node and verify graph references update.
- Switch a transition to route mode and expose editable cases/fallback.
- Auto-arrange the graph.
- Drag a node on the canvas and confirm undo becomes available.
- Trigger a metadata validation error, open the validation panel, and verify the actionable message.
- Open and collapse the palette/inspector surfaces.

## Console and quality checks

- Browser console: no app errors or warnings observed during the Flow interactions.

---

# Flow Run Dry 用例布局 Design QA

- Source visual truth:
  `/tmp/codex-remote-attachments/019face7-ac60-7d22-ba5e-3f19f6f2daf6/b58cd531-4223-485d-a092-844c0d465175/1-Photo-1.jpg`
- Electron-rendered implementation: `/tmp/pragma-rundry-ui-after.png`
- Side-by-side comparison evidence: `/tmp/pragma-rundry-ui-comparison.png`
- Viewport and state: 1440 × 1100 BrowserWindow at DPR 2, Simplified Chinese, Flow Run Dry
  detail with one selected case

## Findings

No actionable P0, P1, or P2 findings remain in the requested layout scope.

- The evaluation identity, coverage summary, case list, and case editor now have independent,
  aligned card boundaries.
- The page sections use an 18 px vertical rhythm; coverage cards and the case list/editor columns
  use 16 px gaps.
- The case editor and case list begin on the same row and no longer share a clipped outer border.
- The first render pass revealed a zero-height heading grid track that allowed the identity card to
  overlap the page title. Setting the scrolling body to max-content auto rows keeps the title at
  its natural 94 px height and preserves scrolling for the complete editor.

## Fidelity and interaction evidence

- Existing typography, color tokens, radii, input styles, button hierarchy, and Phosphor icons are
  preserved.
- Name and target fields form a balanced two-column row; case ID/name and expected status/path use
  the same reusable grid.
- The selected case retains its active treatment and remains visually contained within the case
  list surface.
- At the primary viewport, the measured top positions progress without overlap: heading 103 px,
  identity 215 px, coverage 490 px, and workspace 596 px.
- The existing single scroll container remains responsible for the long case editor; no nested
  horizontal scroll was introduced at the supported desktop viewport.

## Comparison history

1. The source showed collapsed spacing, inconsistent module boundaries, and a case list/editor seam
   that did not align.
2. Split the identity and workspace regions into explicit cards, added consistent inter-module
   spacing, and restored two-column form grids that were previously referencing nonexistent CSS
   classes.
3. Captured the real Electron renderer, fixed the resulting heading-track compression, and
   re-captured the same evaluation state.
4. Opened the source and final implementation together in one comparison input and confirmed the
   requested alignment and spacing defects no longer remain.

## Follow-up polish

None required for this scoped UI correction.

final result: passed

- Desktop lint, TypeScript checks, tests, and production build passed.
- Source and implementation were compared from captured visual evidence, not from code alone.

## Follow-up polish

- P3: consider adding named layout presets for especially wide graphs once real-world Flow sizes are available.

final result: passed

---

# Create expert right-pane layout design QA

## Comparison targets

- Source visual truth: `/tmp/codex-remote-attachments/019f68ab-37ad-7562-a6f2-232dbe3d02c8/7199cfd0-b651-4094-93dc-5cc3965180b4/1-Photo-1.jpg`
- Browser-rendered implementation: `/tmp/expert-mesh-design-qa/create-expert-after.jpg`
- Compact-layout evidence: `/tmp/expert-mesh-design-qa/create-expert-after-1080.jpg`
- Primary viewport and state: 1280 × 720, Studio → Experts → Create expert → Identity.
- Compact viewport and state: 1080 × 720, the same empty Identity form.

## Findings

- The source showed a P1 structural mismatch: the right-hand surface behaved like a narrow inset card, leaving external horizontal space while its preview icon could shrink with the flex row.
- No actionable P0, P1, or P2 differences remain after the layout fix.

## Fidelity review

- **Fonts and typography:** Existing type family, weights, hierarchy, wrapping, and small field-copy treatment are unchanged.
- **Spacing and layout:** The right-side form surface now occupies its full grid column. The former 48 px outer grid gap is represented as internal content padding, so any surface background spans the complete right region. Form content keeps a 680 px readable maximum without constraining the surface itself.
- **Colors and tokens:** Existing off-white page and control tokens are unchanged; no new card color, border, radius, or elevation was introduced.
- **Image and icon fidelity:** No raster assets are involved. The existing Phosphor preview icon remains inside a measured 54 × 54 surface and now has `flex-shrink: 0`.
- **Copy and content:** All expert labels, placeholders, counters, and support copy are unchanged.

## Interaction and runtime evidence

- Clicking **Create expert** opened the Identity step in the running renderer.
- The Name field retained autofocus and the form remained fully interactive.
- At 1080 px, document `scrollWidth` equaled `clientWidth` (1080 px); no horizontal overflow was present.
- At both checked sizes, the preview icon measured exactly 54 × 54 px with flex shrink disabled.
- Browser console contained no error-level messages.

## Full-view and focused comparison evidence

- The supplied photo and the 1080 × 720 implementation capture were opened together in the same comparison pass. The source is a photographed, differently cropped window, so typography and color were not judged with pixel-level precision.
- A separate focused crop was unnecessary: the complete right pane, its external gutters, preview row, and icon were readable in the 1080 × 720 capture.

## Comparison history

1. The source showed an inset right-hand card and a preview icon vulnerable to width compression.
2. Removed the external layout gap, made the form surface full-width, converted the spacing to internal padding, separated the 680 px content measure from the full-width surface, and fixed the icon flex basis at 54 px.
3. Re-captured the running renderer at 1280 × 720 and 1080 × 720. The surface fills its grid column, the icon remains 54 × 54 px, and the compact viewport has no horizontal overflow.

## Follow-up polish

- None required for this scoped fix.

final result: passed

---

# Overview long-content optimization design QA

## Comparison targets

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-188c9ee2-36c2-4706-a899-0d84aae65f96.png`
- Browser-rendered implementation: `/tmp/pragma-overview-long-content-optimized.png`
- Side-by-side comparison evidence: `/tmp/pragma-overview-long-content-comparison.png`
- Compact-layout evidence: `/tmp/pragma-overview-long-content-compact.png`
- Primary viewport and state: 1440 × 900, Studio Overview, one expert with a 176-character unbroken description.
- Responsive viewport and state: 1100 × 900, the same Studio Overview data.

## Findings

- The source exposed a P1 content-containment failure: the long expert description crossed the Experts boundary and overlaid the other three resource sections.
- The initial four-column layout also forced headings and support copy into narrow, uneven measures at a normal desktop window.
- No actionable P0, P1, or P2 differences remain after the optimization.

## Fidelity review

- **Fonts and typography:** Existing type families, weights, hierarchy, and link styling are preserved. Names use a one-line clamp and descriptions use a two-line clamp; both retain the complete DOM text and native hover title.
- **Spacing and layout:** The four resources now form a two-by-two desktop grid, giving each section a readable measure. At 1100 px the grid becomes one column. Both checked viewports have equal document client and scroll widths, so there is no horizontal overflow.
- **Colors and tokens:** Existing off-white, charcoal, muted green-gray, divider, focus, and hover tokens are unchanged.
- **Image and icon fidelity:** No raster imagery is involved. Existing Phosphor resource icons are retained without custom SVG or CSS-drawn replacements.
- **Copy and content:** Product copy and real resource data remain unchanged. Long uninterrupted strings wrap inside their own text box before being visually clamped, rather than crossing section boundaries.

## Interaction evidence

- Overview resource rows remain keyboard-accessible buttons.
- Clicking the long-content expert preview opens the Experts directory as designed.
- The full name and description remain available in the accessible button name and native title attributes.
- Browser console contained no warning- or error-level messages.

## Focused region comparison

- The side-by-side evidence focuses on the full resource grid because the failure crossed multiple section boundaries. The revised Experts row remains inside its 401 px column at 1440 px, with its 269 px copy region clamped to two lines and no row or document overflow.

## Comparison history

1. The supplied screenshot showed a P1 overflow where an unbroken expert description rendered across adjacent sections.
2. Replaced the four-column layout with a two-by-two desktop grid, added explicit text containment and line clamps, and preserved full content through title attributes and accessible text.
3. Re-captured at 1440 × 900 with a deliberately long uninterrupted description; document width remained 1440 px with no overflow.
4. Re-captured at 1100 × 900; the layout adapted to one column and document width remained 1100 px with no overflow.

## Follow-up polish

- None required for this scoped optimization.

final result: passed

---

# Context stores overview design QA

## Comparison targets

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-6c8dcd4e-3c52-4143-b48c-d6bc04d1dab8.png`
- Browser-rendered implementation: `/tmp/pragma-overview-context-stores.png`
- Side-by-side comparison evidence: `/tmp/pragma-overview-comparison.png`
- Compact-layout evidence: `/tmp/pragma-overview-context-stores-compact.png`
- Primary viewport and state: 2048 × 872, Studio Overview, empty persisted collections.
- Responsive viewport and state: 1100 × 800, Studio Overview, empty persisted collections.

## Findings

- No actionable P0, P1, or P2 differences remain for the requested Context stores addition.
- The source capture begins at the Studio navigation, while the browser capture includes the existing global application sidebar. This is an expected crop difference and does not affect the Overview implementation.

## Fidelity review

- **Fonts and typography:** The new heading and description reuse the same existing type scale, weights, line height, and muted text color as Experts, Expert teams, and Capabilities.
- **Spacing and layout:** The desktop Overview uses four equal columns with the existing separators, heading rhythm, asset rows, and View all alignment. At 1100 px it becomes a two-column grid with no horizontal overflow.
- **Colors and tokens:** The Context stores section uses the existing background, border, foreground, muted, green-link, and focus tokens without introducing new visual treatments.
- **Image and icon fidelity:** The reference contains no raster assets in this region. The existing Phosphor Database icon is reused for Context stores; no custom SVG or CSS-drawn substitute was added.
- **Copy and content:** The section uses the existing product label and description and renders up to two real Context store names and descriptions, with type labels as the empty-description fallback.

## Interaction evidence

- The Context stores section and fourth View all control render in the Overview DOM.
- Clicking Context stores View all opens the existing Context stores directory.
- The Studio navigation reports the Context store count from the loaded store collection.
- Browser console contained no warning- or error-level messages.

## Focused region comparison

- The full Overview header region is readable at 2048 × 872, so a separate zoomed crop was not needed. The fourth section repeats the source's column border, heading, supporting copy, and action pattern.

## Comparison history

1. Captured the four-column implementation at the same 2048 × 872 viewport as the source and compared both images together.
2. Verified the requested fourth resource section preserves the existing visual system; no P0/P1/P2 fix was required.
3. Captured the 1100 × 800 layout and confirmed the intended two-column adaptation has no horizontal overflow.

## Follow-up polish

- None required for this scoped addition.

final result: passed

---

# Create expert post-merge card regression design QA

## Comparison targets

- Source visual truth: `/tmp/expert-mesh-design-qa/create-expert-after-1080.jpg`
- Browser-rendered implementation: `/tmp/expert-mesh-design-qa-main-merge-fix/create-expert-fixed-1080.jpg`
- Viewport and state: 1080 × 720, Studio → Experts → Create expert → Identity.

## Findings

- The merged theme initially reapplied a white background, 14 px radius, and shadow to both `.creator-form` and `.creator-preview`, recreating the P1 nested-card regression.
- No actionable P0, P1, or P2 differences remain after removing those two surfaces from the shared card-theme selector.

## Fidelity review

- **Fonts and typography:** Existing merged typography, weights, line heights, wrapping, and field hierarchy remain unchanged.
- **Spacing and layout:** The form and preview are transparent, square, shadowless layout regions again. The full-width right-side grid, 680 px readable content track, responsive internal padding, and zero external creator-layout gap remain intact.
- **Colors and tokens:** The merged theme remains active for navigation, inputs, icons, capability cards, and other intended surfaces. Only the two accidental large white card backgrounds were removed.
- **Image and icon fidelity:** No raster assets are involved. The existing preview icon remains exactly 54 × 54 px with flex shrink disabled.
- **Copy and content:** All labels, placeholders, hints, counters, and step copy are unchanged.

## Interaction and runtime evidence

- Clicking **Create expert** opened the Identity step and Name retained autofocus.
- The 1080 px viewport had equal document `scrollWidth` and `clientWidth`; no horizontal overflow was present.
- Computed styles confirmed transparent backgrounds, 0 px radii, and no shadows on both `.creator-form` and `.creator-preview`.
- Browser console contained no error-level messages.

## Full-view and focused comparison evidence

- The pre-merge target and post-fix implementation were opened together in the same comparison pass at 1080 × 720.
- A separate focused crop was unnecessary because the entire affected right pane, preview row, icon, and external gutters are legible in both captures.

## Comparison history

1. The post-merge capture showed a white outer form card containing a second white preview card.
2. Removed `.creator-form` and `.creator-preview` from the shared large-card selector without changing the merged theme elsewhere.
3. Re-captured the running renderer at 1080 × 720; both accidental surfaces are now transparent and shadowless, while icon sizing and responsive containment remain correct.

## Follow-up polish

- None required for this scoped regression fix.

final result: passed

---

# Desktop Settings Layout Design QA

- Source visual truth: `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-layout-reference.png`
- Implementation screenshots:
  - `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-models-2048x616.png`
  - `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-models-scrolled-2048x616.png`
  - `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-models-1440x900.png`
- Full-view comparison: `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-layout-comparison.png`
- Viewports: reference comparison at 2048 × 616; product default window verification at 1440 × 900
- States: Models empty state, Models provider editor scrolled, Runtime directory

**Findings**

- No actionable P0, P1, or P2 differences remain for the requested layout behavior.
- The redundant page-level `Settings` heading is absent.
- The settings page uses a fixed two-column frame aligned with Studio: the secondary navigation is outside the scrolling region and the active content owns the remaining height.
- Each Settings screen uses a fixed header row and an independently scrolling body row.
- Scroll evidence at 2048 × 616: the body moved from `scrollTop: 0` to `scrollTop: 50.5`; the navigation stayed at `top: 56`, and the content header stayed at `top: 50 / bottom: 152`.

**Required Fidelity Surfaces**

- Fonts and typography: existing Pragma font stack, weights, sizes, and heading hierarchy are preserved. Content titles use the same 32px product heading treatment as Studio.
- Spacing and layout rhythm: page columns, top offset, content inset, fixed header height, and responsive 1180px breakpoint follow the Studio frame. The content body alone owns vertical overflow.
- Colors and visual tokens: existing background, surface, green, border, focus, shadow, and radius tokens are unchanged.
- Image quality and asset fidelity: no raster assets were introduced or replaced. Existing Phosphor icons remain the source for visible UI icons.
- Copy and content: Settings navigation labels, content headings, descriptions, actions, and empty-state copy are unchanged.

**Interaction And Runtime Checks**

- Tested switching between Models & Providers and Runtime Environments.
- Tested opening the provider editor and scrolling its content body.
- Browser console errors checked: none.
- The red API alert visible in the browser-only screenshots is an expected preview limitation because the Electron preload bridge is unavailable outside the Desktop shell; it is not present in the packaged/runtime Desktop environment.

**Focused Region Comparison Evidence**

- Header and scroll behavior: `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-models-scrolled-2048x616.png`
- The focused check confirms that the provider form moves beneath the stationary content title and settings navigation.

**Comparison History**

- Initial comparison found no P0/P1/P2 mismatch against the annotated layout requirements, so no visual correction loop was required.

**Follow-up Polish**

- None required for this layout change.

final result: passed

---

# Desktop Settings Protocol Select Design QA

- Source visual truth: `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-protocol-native-reference.png`
- Implementation screenshot: `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-protocol-focus-1440x900.png`
- Full-view comparison: `/Users/linminqiu/Workspace/expert-mesh/apps/desktop/design-qa/settings-protocol-comparison.png`
- Viewport and state: 1440 × 900, Settings → Models & Providers → Add provider, API protocol focused with OpenAI Responses selected.

**Findings**

- The supplied screenshot identified a P2 visual inconsistency: API protocol exposed the browser's unstyled select border, typography, and system arrow.
- No actionable P0, P1, or P2 differences remain after the control styling update.

**Required Fidelity Surfaces**

- Fonts and typography: the selected value now inherits the same 14px Pragma form typography as adjacent fields.
- Spacing and layout rhythm: the control is 42px high with the same 10px radius, horizontal padding, and field rhythm as the provider name, base URL, and API key controls.
- Colors and visual tokens: default, hover, and focus states use the existing surface-soft, green, focus-ring, and muted foreground tokens.
- Image quality and asset fidelity: the system arrow is replaced by the existing Phosphor `CaretDown` icon; no custom SVG, CSS drawing, or raster asset is used.
- Copy and content: protocol values and selection behavior are unchanged.

**Interaction Evidence**

- Selected OpenAI Responses through the semantic combobox and verified the selected state.
- Verified keyboard focus remains on the native select while the rounded wrapper renders the visible focus ring.
- Computed styles confirm `appearance: none`, no inner border or outline, a 10px shell radius, and a 3px tokenized focus ring.
- Browser console errors checked: none.

**Comparison History**

1. Initial screenshot showed the P2 unstyled native control.
2. Added a styled select shell, removed native appearance, and added a Phosphor caret.
3. The first focus pass exposed the global square `select:focus-visible` outline; suppressed the inner outline so only the rounded wrapper focus ring remains.
4. Re-captured and compared the final focused state.

**Follow-up Polish**

- None required for this scoped control update.

final result: passed

---

# Design QA: page title-to-content spacing

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-11a53df5-d2a0-4845-9efe-d3ec8e94f241.png`
- Implementation screenshot: `/Users/linminqiu/Workspace/expert-mesh/.codex/tmp/design-qa/settings-spacing-after.png`
- Combined comparison: `/Users/linminqiu/Workspace/expert-mesh/.codex/tmp/design-qa/settings-spacing-comparison.png`
- Viewport: 1642 × 522
- State: Simplified Chinese, Settings > General, system language selected

## Full-view comparison evidence

The annotated source is an issue reference rather than a final mock: its red box marks the excessive vertical space between the page heading and the first setting. The implementation preserves the existing Pragma typography, palette, navigation, control styling, copy, and interaction while reducing only that title-to-content interval.

The source and implementation were captured at the same pixel viewport and placed in one side-by-side comparison image. The current application layout differs from the older frame shown in the issue reference, so fidelity judgment is scoped to the marked title-to-content relationship rather than legacy navigation dimensions.

## Focused region comparison evidence

The focused heading/body region was inspected at rendered size. Computed title-to-content gaps are:

- Settings > General: 24px
- Settings > Model Providers: 24px
- Settings > Runtime Environments: 24px
- Studio > Experts: 24px
- Missions > Create: 24px

No extra top padding or collapsing first-child margin remains in those paths.

## Required fidelity surfaces

- Fonts and typography: unchanged; existing Inter/SF system stack, sizes, weights, and line heights are preserved.
- Spacing and layout rhythm: the marked oversized interval is replaced by the shared `--screen-title-content-gap: 24px` token across primary screens.
- Colors and visual tokens: unchanged.
- Image quality and asset fidelity: no image assets were added, removed, or substituted.
- Copy and content: unchanged; Simplified Chinese labels and system-language state render correctly.

## Findings

No actionable P0, P1, or P2 findings remain in the requested scope.

## Comparison history

1. Initial inspection found two hidden additions to the shared 24px rhythm: the General row added 22px and the Runtime list added 19px through nested first-child margins.
2. Removed the obsolete row/list top margins and the General list's extra 18px top padding; introduced the shared spacing token and applied it to Settings, Studio, and Mission creation.
3. Post-fix browser evidence measured a 24px rendered gap on every screen listed above. Navigation among all three Settings views worked, the Mission creation controls rendered, and no browser console errors were reported.

## Implementation checklist

- [x] Use one shared title-to-content spacing token.
- [x] Remove duplicate General and Runtime top spacing.
- [x] Apply the same rhythm to Settings, Studio, and Mission creation.
- [x] Verify affected screens at the reference viewport.
- [x] Run lint, typecheck, and tests.

## Follow-up polish

None required for this spacing change.

final result: passed

---

# Desktop 首页执行者选择器 Design QA

- Source visual truth: `/tmp/codex-remote-attachments/019f82c2-92c5-7f70-b5e9-db3fccecb519/2281b75b-f10d-48c0-8614-f20efe270c8f/1-Photo-1.jpg`
- Implementation screenshots: `/tmp/pragma-executor-five-row-final.png`, `/tmp/pragma-executor-final-normal.png`, `/tmp/pragma-executor-final-focus.png`, `/tmp/pragma-executor-five-row-1080x700.png`
- Combined comparison: `/tmp/pragma-executor-comparison-final.png`
- Viewports: 1440 × 900 and 1080 × 700 CSS px, light theme, executor menu open
- State: five-row layout fixture for density/alignment; live app data for normal and keyboard-focus states

## Full-view comparison evidence

The final five-row capture keeps the existing Desktop composition while intentionally applying the requested differences from the source photo: the large “选择执行者” heading is removed, the descriptive hint remains, rows have a stable 68 px height, icons use a stable 36 px container with a 20 px glyph, and all kind/default pills share the same right edge. The menu remains fully visible at the minimum supported 1080 × 700 viewport without document overflow.

## Focused-region comparison evidence

- Five rows measure 68 px each; the options viewport and scroll height are both 370 px, so rows are not compressed.
- Every icon container measures 36 × 36 px and every glyph measures 20 × 20 px.
- Every kind/default pill has the same 11 px right inset.
- Normal search state has one outer border and no shadow. Keyboard focus adds the outer focus ring; the input itself keeps `border: 0`, `outline: 0`, and `box-shadow: none`.
- The hint header is hit-test visible when the five-row menu extends above the mission composer.
- No renderer console errors were observed during the live-state verification.

## Required fidelity surfaces

- Fonts and typography: existing Inter/SF Pro system stack, weights, truncation, and line heights are preserved; only the redundant large header is removed.
- Spacing and layout rhythm: rows, icon slots, right-side metadata, search field, and five-row menu height are now deterministic.
- Colors and visual tokens: existing surface, border, green selection, muted text, and focus tokens are unchanged.
- Image quality and asset fidelity: no raster assets were introduced; existing Phosphor icons remain and are normalized through fixed slots.
- Copy and content: the explanatory hint and available count remain; the unused large-title translations were removed from all three locales.

## Comparison history

1. P1 — footer descendant button styles overrode option buttons with `display: inline-flex`, 34 px minimum height, and compact padding. Fixed by scoping those rules to direct footer buttons, restoring the option grid.
2. P1 — the expanded five-row menu extended above the scrollable mission section, hiding the retained hint. Fixed by allowing the centered Home mission section to overflow visibly; verified at 1440 × 900 and 1080 × 700.
3. P2 — icon containers could shrink below their declared width. Fixed with a matching explicit minimum width.
4. Post-fix evidence — five rows are 68 px high, icons are 36/20 px, tags share an 11 px right inset, the hint is visible, and both input states retain a single visible boundary.

## Findings

No actionable P0, P1, or P2 differences remain for the requested changes.

## Open questions

None.

## Implementation checklist

- [x] Remove the redundant large picker heading.
- [x] Keep the small explanatory hint and count.
- [x] Prevent option-row compression.
- [x] Normalize icon sizing.
- [x] Right-align executor-kind/default pills.
- [x] Verify normal and keyboard-focus input states.
- [x] Verify five-row layout at the minimum supported viewport.

## Follow-up polish

None required.

final result: passed

---

# Design QA: Studio secondary navigation spacing

## Evidence

- Source visual truth: `/tmp/codex-remote-attachments/019fb8d1-11b6-7150-aab0-e5f6dc1c38e3/341026c7-7955-4ad6-84a1-56273429548d/1-Photo-1.jpg`
- Implementation screenshot: `/tmp/pragma-studio-menu-fixed.png`
- Minimum-window screenshot: `/tmp/pragma-studio-menu-fixed-1080.png`
- Focused before/after comparison: `/tmp/pragma-studio-menu-comparison.png`
- State: Simplified Chinese, Studio open, Experts selected, live Desktop bridge data loaded.
- Main viewport: `1440 × 900` CSS px at device pixel ratio `2`; implementation image is `2880 × 1800` px.
- Minimum viewport: `1080 × 700` CSS px at device pixel ratio `1`; implementation image is `1080 × 700` px.
- Source image: `960 × 1280` px phone photograph. It records the broken state rather than a target mock, so the intended difference is the removal of stretched grid tracks. The focused comparison fits both navigation regions into equal `800 × 1200` slots; no pixel-level typography comparison is inferred from the photographed perspective.

## Findings

- No actionable P0, P1, or P2 findings remain.
- The seven Studio navigation rows are now `44px` high with a consistent `6px` gap and begin at the existing `56px` top inset. The remaining rail height stays empty instead of being distributed between rows.
- At `1080 × 700`, the last resource row ends at `400px`, the rail remains within its `700px` viewport, and the page has no horizontal overflow.
- Typography: font family, size, weight, line height, wrapping, and truncation are unchanged by this fix.
- Spacing and layout rhythm: the broken full-height track stretching is removed; existing rail padding, compact row height, and action separation remain intact.
- Colors and tokens: the rail, hover, selection, text, and content canvas colors are unchanged.
- Image quality and assets: existing logo and Phosphor icons are unchanged; no assets were replaced or approximated.
- Copy and content: labels and actions are unchanged. Live counts differ from the photographed report because the implementation uses the current local data.

## Full-view comparison evidence

The full Desktop capture preserves the three-column composition, selected primary navigation, Studio rail color distinction, content header, search, and expert list. The visible regression is absent: navigation items occupy a compact block at the top of the Studio rail.

## Focused region comparison evidence

`/tmp/pragma-studio-menu-comparison.png` places the photographed broken rail and the fixed live rail in one comparison image. The original distributes resource rows across nearly the entire window height; the implementation keeps all rows contiguous and leaves intentional empty space below the menu.

## Comparison history

1. P1 — Studio resource navigation rows were stretched across the full-height rail, producing very large and viewport-dependent gaps.
2. Fix — Set the Studio grid container to `align-content: start`, preserving the full-height rail background while preventing implicit rows from stretching.
3. Post-fix evidence — Live computed layout reports `align-content: start`, seven `44px` rows, six `6px` gaps, and no overflow at both tested viewport sizes.

## Verification

- Primary interaction tested: Home → Studio navigation; Studio and Experts selected states updated correctly.
- Visible error state: none.
- Console exceptions and log errors after reload: `0`.
- Focused component test: passed.
- Desktop renderer typecheck: passed.
- Formatting and diff checks: passed.

## Implementation checklist

- [x] Keep the Studio rail full height and visually distinct from the content canvas.
- [x] Anchor resource navigation rows to the top.
- [x] Preserve compact row height and consistent gap.
- [x] Confirm the minimum supported window does not stretch or overflow.
- [x] Add the invariant to the Desktop UI convention.

## Follow-up polish

- None for this regression.

final result: passed

---

# Memory Extraction Jobs Design QA

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-04e1d31a-48d9-490f-a264-29e30f6c9a05.png`
- Rendered implementation: `/Users/linminqiu/.codex/visualizations/2026/08/05/019fd259-0e20-7e32-822c-5be7dc191aac/memory-extraction-after-final.jpg`
- Full-view comparison: `/Users/linminqiu/.codex/visualizations/2026/08/05/019fd259-0e20-7e32-822c-5be7dc191aac/memory-extraction-comparison-final.jpg`
- Focused card comparison: `/Users/linminqiu/.codex/visualizations/2026/08/05/019fd259-0e20-7e32-822c-5be7dc191aac/memory-extraction-card-comparison-final.jpg`
- State: Simplified Chinese, extraction jobs tab, two waiting jobs, empty attention/running lanes, seven visible completed jobs.
- Browser: Codex in-app browser.
- Viewport: 1353 × 900 CSS px.
- Source pixels: 2880 × 1800 at an inferred 2× density. The 174 px collapsed sidebar was cropped, leaving a 2706 × 1800 source region representing 1353 × 900 CSS px.
- Implementation pixels: 1353 × 900 at 1× density. It was scaled to 2706 × 1800 only for the combined comparison artifact.

## Full-view comparison evidence

The information architecture, copy, four-lane order, task counts, tab state, search field, and section-level refresh action remain consistent with the source. The requested redesign is visible in the board itself: lanes no longer have enclosing card borders, spacing creates the column structure, waiting tasks use one elevated surface, and completed tasks use quiet tinted rows instead of nested outlined cards.

## Focused comparison evidence

The focused task comparison confirms that the task's title and type hierarchy are preserved. The former footer divider and full-width outlined action are removed. The primary action is now a compact filled control aligned to the lower right, with a visible icon and accessible text label.

## Required fidelity surfaces

- Fonts and typography: Existing application typography and weights are preserved. Lane headings and counts are slightly quieter without reducing legibility.
- Spacing and layout rhythm: The board uses 24 px inter-column space, 12 px task gaps, and a single card surface per waiting task. No nested lane/card border stack remains.
- Colors and visual tokens: Existing `--green`, `--green-dark`, surface, muted, focus, radius, and shadow tokens are reused. The primary button's white-on-green treatment has clear visual priority.
- Image quality and asset fidelity: No raster assets are part of this screen. Existing Phosphor icons remain sharp and are not replaced with custom drawings.
- Copy and content: All existing localized copy and task data are unchanged.

## Interaction and accessibility checks

- The first waiting task's “立即提炼” action resolved uniquely and was clickable.
- The “刷新” action resolved uniquely and was clickable.
- Buttons retain visible keyboard focus treatment through the existing focus token.
- Disabled controls retain a distinct state and wait cursor.
- The browser console reported no errors or warnings during the interaction check.
- Screenshot review cannot establish full keyboard order, screen-reader announcement quality, or contrast compliance in every OS rendering mode; those remain suitable for automated or assistive-technology testing.

## Findings

No actionable P0, P1, or P2 issues remain. The visual differences from the source are intentional and directly implement the requested removal of nested borders, footer separators, and outlined task actions.

## Comparison history

- Pass 1: No actionable P0/P1/P2 differences were found after density normalization. No visual rework loop was required.

## Follow-up polish

- P3: If completed-job volume grows substantially beyond the shown state, a compact grouping or progressive disclosure pattern could reduce scan length without bringing card borders back.

final result: passed

---

# Mission Work Grid Design QA

- Source visual truth path: user redesign brief from 2026-08-13, grounded in the pre-change Work tab implementation at `apps/desktop/src/renderer/src/pages/missions/MissionsPage.tsx` (`HEAD`). No separate mockup was supplied.
- Implementation screenshot path: `/tmp/pragma-mission-work-grid-implementation.png`
- Hover-state screenshot path: `/tmp/pragma-mission-work-grid-hover.png`
- Viewport: 1280 × 768 CSS px, device scale factor 1.
- Source pixels: specification-based target; no standalone raster source.
- Implementation pixels: 1280 × 768, captured at 1× density.
- State: five work records across three delegation levels; running, succeeded, queued, and waiting statuses represented.

## Full-view comparison evidence

The rendered Work view uses one compact card per expert, arranged in centered depth-based grid rows. Each card exposes the expert avatar, expert name, and current status. Animated dashed orthogonal arrows connect parent and child records in the correct direction. The overall typography, color, borders, radii, avatar assets, and spacing reuse the Desktop design system.

## Focused region comparison evidence

The hover-state capture verifies that the existing profiled-avatar tooltip opens over the selected avatar after the established delay and displays the existing name, gender, and personality fields. Computed browser styles verified `mission-work-flow` on connector paths, a `6px 7px` dash pattern, and an SVG arrow marker. The browser console contained no warnings or errors.

## Findings

- No actionable P0, P1, or P2 differences from the requested redesign.
- Fonts and typography: existing Desktop font stack and hierarchy are preserved; expert names remain legible and truncate safely.
- Spacing and layout rhythm: three depth rows fit within the inspected desktop viewport with balanced 56px connector lanes.
- Colors and visual tokens: existing surface, border, focus ring, status, and muted-text tokens are reused.
- Image quality and asset fidelity: existing expert avatar assets render at native component sizes; no placeholder or synthetic asset was introduced.
- Copy and content: English, Simplified Chinese, and Traditional Chinese labels describe the expert collaboration network consistently.

## Comparison history

- Initial pass: the third delegation row was partially below the inspected viewport.
- Fix: reduced card height from 154px to 142px, row gap from 72px to 56px, and bottom padding from 32px to 24px.
- Post-fix evidence: `/tmp/pragma-mission-work-grid-implementation.png` shows all three levels without clipping.

## Primary interactions tested

- Avatar hover opens the existing expert profile tooltip.
- Work cards expose accessible expert-name and status labels.
- Connector paths render with arrowheads and active dash-flow animation.
- Reduced-motion CSS disables the connector animation.

final result: passed
