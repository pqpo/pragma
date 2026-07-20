# Home Mission Composer Design QA

- Source visual truth: `/tmp/codex-remote-attachments/019f7d75-4f4a-7cb1-98eb-f65af5988432/67a59236-a701-44f9-82f8-036d2bd3b341/1-Photo-1.jpg`
- Implementation screenshots: `design-qa/home-default-workspace.png`,
  `design-qa/home-workspace-menu-focus.png`, and `design-qa/home-keyboard-focus.png`
- Combined comparison: `design-qa/home-reference-comparison.png`
- Viewport: 1440 × 900 at DPR 2; the annotated reference is 1280 × 660
- State: Home with the built-in Pragma Agent, built-in default workspace, and an intentionally disabled
  submit action because the goal is empty

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- The implementation preserves the product shell while matching the reference's centered heading,
  single bordered composer, workspace row, large borderless prompt area, compact option footer, and
  arrow submit action.
- Workspace selection is explicitly optional. The default path is visible without dominating the
  row, and the expanded menu distinguishes the persistent default from a one-Mission override.
- Expert selection defaults to the built-in Pragma Agent. Expert and ExpertTeam states expose only model
  and thinking-depth overrides; Runtime is not presented on Home. Flow states omit both controls.
- Existing typography, Phosphor icons, graphite/sage tokens, radii, and surface shadows are reused.
  No raster or generated product assets were introduced.

**Full-view comparison evidence**

- The source and actual Electron implementation were opened together in
  `home-reference-comparison.png`.
- The implementation keeps the Desktop navigation rail, then centers the reference composition in
  the remaining content viewport. Composer proportions, row order, whitespace, and action placement
  follow the supplied reference.
- The implementation adds the resolved default workspace path and product-real permission choices;
  these are functional content additions, not alternative visual structure.

**Focused region comparison evidence**

- `home-workspace-menu-focus.png` verifies the workspace menu, selected default state, and the
  one-Mission folder override description without clipping.
- `home-keyboard-focus.png` verifies a single visible focus boundary around the composite input. An
  initial nested focus shadow on the workspace trigger was removed during this QA pass.

**Interactions and diagnostics**

- Verified keyboard traversal from the application rail into the workspace trigger and prompt,
  prompt focus styling, workspace menu open/close, selected-default indication, and disabled submit
  state.
- Desktop tests cover Home executor/model state and the Mission creation contracts. Runtime IDs are
  rejected by the strict model-override schema and cannot be submitted by Home.
- The local Electron run reported that the existing model-provider configuration uses an older
  format. Home handled this by disabling model overrides and showing the executor-default fallback;
  the stored user configuration was not changed for QA.

**Comparison history**

- Pass 1: found a nested keyboard focus shadow on the workspace trigger.
- Pass 2: removed the inner shadow, added the correctly scoped outer `:focus-within` state, and
  verified normal, expanded-menu, and keyboard-focus screenshots.

**Follow-up Polish**

- P3: recapture the ordinary state after the local model-provider configuration is reconfigured if
  a populated model dropdown screenshot is desired. The invalid-config fallback is already covered.

final result: passed

---

# Missions v1 Design QA

- Source visual truth: `/Users/linminqiu/.codex/generated_images/019f5139-fbcc-75e0-8165-8c56a2bb5552/exec-aa9b2bf8-e19b-4550-b6a0-67e44aa856d7.png`
- Implementation screenshot: `design-qa/mission-create-1440x900.png`
- Viewport: 1440 × 900
- State: Missions / New mission, empty mission list, no configured experts in browser preview

**Findings**

- No actionable P0, P1, or P2 visual differences remain.
- The selected visual uses populated team data and an enabled `Start mission` action. The v1 implementation intentionally shows an empty list, single-Expert selector, disabled `Create mission` action, and no team description because execution and Expert Teams are outside the approved scope.
- Fonts and typography: the implementation uses the existing Inter/SF Pro fallback stack and preserves the source hierarchy, weights, line height, truncation, and antialiasing.
- Spacing and layout rhythm: the two navigation rails, main heading, selector row, composer, dividers, and whitespace follow the selected composition without clipping or horizontal page overflow at the captured viewport.
- Colors and visual tokens: existing Pragma background, surface, border, graphite, sage, and lime tokens match the source direction; disabled state contrast remains legible.
- Image quality and asset fidelity: the screen contains no raster content. All interface icons use the existing Phosphor icon library; the Pragma wordmark and letter mark remain the existing code-native product branding.
- Copy and content: v1 wording accurately communicates creation without implying that Directive execution is available.

**Full-view comparison evidence**

- The source visual and browser-rendered implementation were opened together in the same comparison input.
- Main content starts on the same absolute rail boundary and preserves the source's form-first hierarchy.
- The implementation intentionally omits team-only information rather than leaving placeholder team controls visible.

**Focused region comparison evidence**

- A separate crop was not required: the full 1440 × 900 capture renders all labels, icons, selectors, dividers, and composer controls at readable size, and there are no imagery or dense data regions requiring magnification.

**Interactions and diagnostics**

- Tested Missions navigation, New mission reset, search input and disabled create validation.
- Browser console checked with no errors or warnings.
- Unit tests separately cover single-Expert versus Expert Team conditional detail layout.

**Comparison history**

- Pass 1: no P0/P1/P2 mismatch found; no visual fix iteration was required.

**Follow-up Polish**

- P3: capture a populated Electron-only Mission detail state after the future Execution continuation work enables real execution data.

final result: passed

---

# Studio Scroll Frame Design QA

- Source visual truth: `/var/folders/7y/x39kntq56gvcfdymbtjb36280000gn/T/codex-clipboard-78471d85-e8a6-4913-939d-f26a94c0a427.png`
- Implementation screenshot: `design-qa/studio-scroll-1440x900.png`
- Viewport: 1440 × 900; minimum-size verification at 1080 × 700
- State: Studio / Create expert, content viewport scrolled to `scrollTop=226`

**Findings**

- No actionable P0, P1, or P2 differences remain for the requested scrolling framework.
- The source uses a populated Plugin detail screen to mark the intended boundary. The browser-rendered verification uses Create expert because Electron preload data is unavailable in a plain browser preview; the comparison therefore evaluates the shared shell, fixed navigation/title geometry, and independent content viewport rather than fixture copy.
- Fonts and typography: the existing Inter/SF Pro stack, hierarchy, weights, wrapping, and antialiasing are unchanged.
- Spacing and layout rhythm: the application shell and Studio page remain 900px tall with hidden outer overflow; the fixed title occupies `top=50..152`, and the body owns the remaining `686px` scroll viewport. Scrolling moved only the body from `scrollTop=0` to `226`; the application sidebar, Studio navigation, and title stayed at their original coordinates.
- Colors and visual tokens: the existing Pragma graphite, sage, surface, border, focus, and shadow tokens are unchanged.
- Image quality and assets: no new raster assets were required. Existing Phosphor interface icons and the code-native Pragma branding remain intact.
- Copy and content: existing page labels, descriptions, actions, form fields, and resource content are unchanged.

**Full-view comparison evidence**

- The source and implementation were opened together in the same comparison input.
- Both retain the fixed application rail and Studio section rail while assigning the remaining main-column area to page-specific content.
- The implemented frame makes the page title persistent and constrains scrolling below it; detail pages use the source boundary by keeping only the `Back to …` row fixed and placing the entity title inside the scrolling body.

**Focused region comparison evidence**

- A separate crop was unnecessary: both full views show the complete navigation rails, title boundary, body origin, and lower content clipping at readable scale.

**Interactions and diagnostics**

- Tested Experts directory, Create expert scrolling, Capabilities directory, Plugins directory, and Context stores directory in the browser preview.
- Verified the shared directory/detail/editor frame structurally for Experts, Expert teams, Flows, Capabilities, Plugins, and Context stores; Flow Editor retains its own fixed toolbar and internal panel scrolling.
- At 1080 × 700, document dimensions stayed exactly 1080 × 700 with no page-level horizontal or vertical overflow; the content body remained independently scrollable.
- Browser console checked with no errors or warnings.

**Comparison history**

- Pass 1: no P0/P1/P2 issue found. Scroll metrics and the scrolled screenshot confirmed that only the content viewport moves.

**Follow-up Polish**

- None required for this change.

final result: passed
