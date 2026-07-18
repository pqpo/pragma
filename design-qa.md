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
