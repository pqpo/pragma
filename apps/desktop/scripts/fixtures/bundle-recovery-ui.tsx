import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { SquareBundleContents } from "../../src/renderer/src/pages/studio/SquareDirectoryFragment.tsx";
import { PragmaBundleDialog } from "../../src/renderer/src/pages/studio/PragmaBundleDialog.tsx";
import { i18n } from "../../src/renderer/src/i18n/index.ts";
import type {
  DesktopRuntimeAvailability,
  PragmaBundleImportInspection,
  PragmaBundleInstallation,
  PragmaDesktopAPI,
} from "../../src/shared/contracts/index.ts";
import "../../src/renderer/src/styles/index.css";

const id = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";
const ref = "context-store:kqh4nx7rx26mb3e7";
const inspection: PragmaBundleImportInspection = {
  sourcePath: "/tmp/handbook.pragma",
  sourceName: "handbook.pragma",
  root: { ref, kind: "ContextStore", name: "Release handbook" },
  roots: [{ ref, kind: "ContextStore", name: "Release handbook" }],
  bundleFingerprint: "a".repeat(64),
  projectFingerprint: "b".repeat(64),
  projectRevision: 1,
  createdAt: "2026-10-19T00:00:00.000Z",
  archiveBytes: 1024,
  unpackedBytes: 1024,
  fileCount: 1,
  resources: 1,
  dependencies: [],
  conflicts: [],
  assetConflicts: [],
  requirements: [],
  readiness: [],
  sameContentInstallationIds: [],
};
const legacy: PragmaBundleInstallation = {
  schemaVersion: "pragma.bundle-installation/v9",
  bundleVersion: "pragma.bundle/v3",
  id,
  bundleFingerprint: inspection.bundleFingerprint,
  projectId: "studio",
  projectRevision: 0,
  sourceRootRef: ref,
  rootRef: ref,
  rootKind: "ContextStore",
  rootName: "Release handbook",
  resourceRefs: [ref],
  createdResourceRefs: [ref],
  createdCapabilityIds: [],
  createdContextStoreIds: [],
  createdPluginRefs: [],
  conflictResolutions: [],
  assetConflictResolutions: [],
  resourceMappings: [],
  status: "failed",
  pending: [],
  readiness: [],
  error: "Interrupted import",
  createdAt: inspection.createdAt,
  updatedAt: inspection.createdAt,
};
const modern: PragmaBundleInstallation = {
  ...legacy,
  error: "The project changed during installation.",
  errorCode: "installation_target_conflict",
  transaction: {
    requestId,
    requestFingerprint: "c".repeat(64),
    baseRevision: 0,
    publicationId: id,
    input: {},
    identities: [],
    assets: {},
    phase: "assets",
  },
};
let activeInspection = inspection;
let installation: PragmaBundleInstallation | null = legacy;
let blockDiscard = false;
let calls = { start: 0, recheck: 0, discard: 0 };
let submittedRequestId: string | undefined;
let inspectedInstallationId: string | undefined;
let plannedConflicts: PragmaBundleImportInspection | undefined;
let submittedCapabilities = -1;
let submittedRuntimes = -1;
let submittedRuntime: { runtimeId: string; providerId: string; modelId: string } | undefined;
let lastConflictAction: string | undefined;
let recheckError: unknown;
let preservePending = false;
const api: Pick<
  PragmaDesktopAPI,
  | "subscribeRuntimeModelCatalog"
  | "inspectPragmaBundle"
  | "listPragmaBundleInstallations"
  | "recheckPragmaBundleInstallation"
  | "discardPragmaBundleInstallation"
  | "importPragmaBundle"
> = {
  subscribeRuntimeModelCatalog: () => () => undefined,
  inspectPragmaBundle: async (input) => {
    inspectedInstallationId = input.installationId;
    lastConflictAction = input.decisions?.conflicts[0]?.action;
    return {
      ...(input.decisions === undefined
        ? activeInspection
        : (plannedConflicts ?? activeInspection)),
      ...(installation === null ? {} : { alreadyInstalledId: installation.id }),
    };
  },
  listPragmaBundleInstallations: async () => (installation === null ? [] : [installation]),
  recheckPragmaBundleInstallation: async () => {
    calls.recheck++;
    if (recheckError !== undefined) throw recheckError;
    if (preservePending) return installation!;
    if (installation?.transaction !== undefined) throw new Error("installation_target_conflict");
    installation = { ...legacy, status: "ready" };
    return installation;
  },
  discardPragmaBundleInstallation: async () => {
    calls.discard++;
    if (blockDiscard)
      throw {
        code: "internal_error",
        message:
          "This import changed existing project resources. Automatic rollback would overwrite later work.",
        diagnostics: [],
      };
    installation = null;
  },
  importPragmaBundle: async (input) => {
    calls.start++;
    submittedRequestId = input.requestId;
    submittedCapabilities = input.capabilities.length;
    submittedRuntimes = input.runtimes.length;
    submittedRuntime = input.runtimes[0];
    installation = { ...modern, status: "ready" };
    return installation;
  },
};
const root = createRoot(document.getElementById("root")!);
let mount = 0;
const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function button(label: string, scope: ParentNode = document): HTMLButtonElement {
  const found = [...scope.querySelectorAll<HTMLButtonElement>("button")].find(
    (item) => item.textContent?.trim() === label,
  );
  assert(found, `Missing button: ${label}; visible: ${document.body.textContent}`);
  return found;
}
async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 120; index++) {
    if (predicate()) return;
    await frames();
  }
  throw new Error(
    `Bundle UI did not reach the expected state: ${document.body.textContent}; calls: ${JSON.stringify(calls)}`,
  );
}
async function click(target: HTMLButtonElement) {
  assert(!target.disabled, `Disabled button: ${target.textContent}`);
  flushSync(() => target.click());
  await frames();
}
async function open(
  record: PragmaBundleInstallation | null,
  runtimes: readonly DesktopRuntimeAvailability[] = [],
  useOriginalFile = true,
  advance = true,
) {
  installation = record;
  calls = { start: 0, recheck: 0, discard: 0 };
  Object.assign(window, { pragmaDesktop: api });
  flushSync(() =>
    root.render(
      <PragmaBundleDialog
        key={++mount}
        mode="import"
        project={{
          schemaVersion: "pragma.project-snapshot/v3",
          projectId: "studio",
          revision: 1,
          resources: [],
          diagnostics: [],
        }}
        capabilities={[]}
        contextStores={[]}
        runtimes={runtimes}
        {...(useOriginalFile ? { initialSourcePath: inspection.sourcePath } : {})}
        onRefreshRuntimes={async () => runtimes}
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    ),
  );
  if (!useOriginalFile) {
    await waitFor(() => document.querySelector(".pragma-bundle-resume-list button") !== null);
    if (!advance) return;
    await click(document.querySelector<HTMLButtonElement>(".pragma-bundle-resume-list button")!);
  }
  await waitFor(
    () =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (item) => item.textContent?.trim() === i18n.t("studio:bundleContinue") && !item.disabled,
      ) || document.querySelector(".pragma-bundle-result") !== null,
  );
  if (document.querySelector(".pragma-bundle-result") === null) {
    await click(button(i18n.t("studio:bundleContinue")));
  }
}
export async function runBundleRecoveryUiTests() {
  await i18n.changeLanguage("en");
  for (const status of ["installing", "failed"] as const) {
    await open({ ...legacy, status });
    assert(
      document.querySelector(".pragma-bundle-result"),
      "Legacy record must open recovery results",
    );
    assert(calls.start === 0, "Legacy recovery must not start a second import");
    await click(button("Check again"));
    await waitFor(() => document.querySelector(".pragma-bundle-success") !== null);
    assert(calls.recheck === 1 && calls.start === 0, "Legacy record must use recheck");
  }
  await open({
    ...legacy,
    status: "needs_setup",
    pending: [
      {
        id: "old-runtime",
        kind: "runtime",
        resourceRef: "runtime-profile:0000000000000001",
        name: "Built-in Runtime / old-source-model",
        message: "Choose a compatible local Runtime and model.",
      },
    ],
  });
  assert(
    calls.recheck === 1 && calls.start === 0,
    "Existing setup must recheck the expert's current configuration before asking for bindings",
  );
  assert(
    document.querySelector(".pragma-bundle-success"),
    "Already configured experts must not be asked to select imported models again",
  );
  await open(modern);
  await click(button("Discard import"));
  assert(calls.discard === 0, "Discard must require confirmation");
  await click(button("Cancel", document.querySelector('[role="alertdialog"]')!));
  assert(calls.discard === 0, "Cancel must preserve the installation");
  blockDiscard = true;
  await click(button("Discard import"));
  await click(button("Discard import", document.querySelector('[role="alertdialog"]')!));
  await waitFor(() => document.body.textContent?.includes("known project backup") === true);
  assert(
    document.body.textContent?.includes("Automatic rollback would overwrite later work."),
    "Cleanup must show the server reason",
  );
  assert(
    installation !== null && calls.start === 0,
    "Blocked cleanup must preserve the original record",
  );
  blockDiscard = false;
  await click(button("Discard import"));
  await click(button("Discard import", document.querySelector('[role="alertdialog"]')!));
  await waitFor(() => document.querySelector(".pragma-bundle-result") === null);
  await click(button("Continue"));
  await click(button("Import bundle"));
  await waitFor(() => calls.start === 1);
  assert(
    submittedRequestId !== undefined && submittedRequestId !== requestId,
    "Fresh import must have a new UUID",
  );
  await prepareBundleRuntimeVisual("en");
  assert(
    !document.body.textContent?.includes("Built-in Runtime"),
    "Internal RuntimeProfile labels must not appear in the model replacement flow",
  );
  assert(
    !document.querySelector('[aria-label="Runtime"]'),
    "Expert model replacement must not expose a separate Runtime selector",
  );
  assert(
    document.querySelector(".pragma-bundle-binding-step h3")?.textContent?.includes("Writer"),
    "Model replacement must name the expert using it",
  );
  assert(
    !document
      .querySelector(".pragma-bundle-binding-step h3")
      ?.textContent?.includes("Built-in Runtime"),
    "Internal RuntimeProfile names must not be displayed as independent resources",
  );
  assert(document.body.textContent?.includes("source-model"), "Source model must be explained");
  assert(
    button("Review import").disabled,
    "Missing source model must require an explicit replacement",
  );
  await click(button("Set up later"));
  await click(button("Back"));
  await waitFor(() => document.querySelector(".pragma-bundle-binding-step") !== null);
  const modelSelect = document.querySelector<HTMLButtonElement>('[aria-label="Model"]');
  assert(
    modelSelect && !modelSelect.disabled,
    "Local model selection must be enabled without reselecting Runtime",
  );
  await click(modelSelect);
  await click(button("Other Model · Other Account"));
  await click(button("Review import"));
  assert(
    document.querySelector(".pragma-bundle-review"),
    "Replacement model must allow import review",
  );
  // The review must reflect the replacement selected in the previous step.
  assert(
    !document.body.textContent?.includes("Needs setup"),
    "Review must not retain stale missing status",
  );

  await click(button("Import bundle"));
  await waitFor(() => calls.start === 1);
  assert(
    submittedRuntime?.runtimeId === "codex" &&
      submittedRuntime.providerId === "other-account" &&
      submittedRuntime.modelId === "other-model",
    "Selecting a replacement model must save its engine and account automatically",
  );

  await prepareBundleRuntimeVisual("en");
  await click(button("Set up later"));
  await click(button("Import bundle"));
  await waitFor(() => calls.start === 1);
  assert(
    submittedRuntimes === 0,
    "Deferring Runtime must not submit an auto-prefilled partial model binding",
  );

  activeInspection = {
    ...inspection,
    requirements: [
      {
        id: "missing-tool",
        kind: "capability",
        resourceRef: "capability:0000000000000001",
        name: "Search",
        required: true,
        message: "Choose capability",
        compatibleCapabilityIds: [],
        requiredTools: ["search"],
      },
    ],
  };
  await open(null);
  await waitFor(() => document.querySelector(".pragma-bundle-binding-step") !== null);
  assert(
    button("Review import").disabled,
    "An empty capability selector must not pretend to be configured",
  );
  await click(button("Set up later"));
  assert(
    document.body.textContent?.includes(
      i18n.t("studio:bundleReviewDeferredDependencies", { count: 1 }),
    ),
    "Review must count deferred required capabilities",
  );
  await click(button("Import bundle"));
  await waitFor(() => calls.start === 1);
  assert(submittedCapabilities === 0, "Deferred capability must not submit a made-up binding");

  activeInspection = inspection;
  inspectedInstallationId = undefined;
  await open(modern, [], false);
  assert(
    inspectedInstallationId === id,
    "Recovery must inspect the retained installation without requiring the original file",
  );

  await open(modern, [], false, false);
  installation = { ...legacy, status: "ready" };
  await click(document.querySelector<HTMLButtonElement>(".pragma-bundle-resume-list button")!);
  await waitFor(() => document.querySelector(".pragma-bundle-success") !== null);

  await prepareBundleConflictVisual("en", [
    {
      id: "source-runtime",
      kind: "runtime",
      resourceRef: "runtime-profile:0000000000000001",
      name: "Source Runtime",
      required: true,
      message: "Source Runtime unavailable",
    },
  ]);
  plannedConflicts = { ...activeInspection, requirements: [], readiness: [] };
  await click(button("Continue"));
  await waitFor(() => document.querySelector(".pragma-bundle-review") !== null);
  assert(
    lastConflictAction === "keep_local",
    "Preflight must receive the selected conflict decisions",
  );
  plannedConflicts = undefined;

  recheckError = {
    code: "installation_root_missing",
    message: "The imported entry was deleted.",
    diagnostics: [],
  };
  activeInspection = inspection;
  await open({
    ...legacy,
    status: "needs_setup",
    pending: [
      {
        id: "missing",
        kind: "runtime",
        resourceRef: ref,
        name: "Deleted entry",
        message: "Missing",
      },
    ],
  });
  assert(
    document.body.textContent?.includes("entry was deleted"),
    "A missing entry must show a recoverable cause",
  );
  assert(button("Discard import"), "A missing entry must still allow cleanup");
  recheckError = undefined;

  // Rechecking can change the pending graph. Metadata must be inspected again afterwards.
  preservePending = true;
  activeInspection = {
    ...inspection,
    requirements: [
      {
        id: "missing",
        kind: "capability",
        resourceRef: "capability:0000000000000001",
        name: "Search",
        required: true,
        message: "Missing",
        requiredTools: ["search"],
        compatibleCapabilityIds: [],
      },
    ],
  };
  await open({
    ...legacy,
    status: "needs_setup",
    pending: [
      {
        id: "missing",
        kind: "capability",
        resourceRef: "capability:0000000000000001",
        name: "Search",
        message: "Missing",
      },
    ],
  });
  assert(
    inspectedInstallationId === id,
    "Rechecked setup must refresh capability compatibility metadata",
  );
  preservePending = false;

  activeInspection = inspection;
  return {
    passed: 12,
    scenarios: [
      "use the expert current configuration before resuming setup",
      "replace expert model across runtimes without separate runtime binding",
      "legacy installing",
      "legacy failed",
      "confirmed cleanup, blocked cleanup and fresh retry",
      "defer missing capability without inventing bindings",
      "defer Runtime without auto-submitting a partial model binding",
      "resume using retained installation without original download",
      "handle an installation completed after the recovery list loaded",
      "reinspect effective requirements after conflict choices",
      "missing root reports cause and permits cleanup",
      "refresh compatibility metadata after setup recheck",
    ],
  };
}

export async function prepareBundleRecoveryVisual(language: string) {
  activeInspection = inspection;
  await i18n.changeLanguage(language);
  await open(modern);
  await click(button(i18n.t("studio:bundleDiscardImport")));
}

export async function prepareBundleRuntimeVisual(language: string) {
  await i18n.changeLanguage(language);
  activeInspection = {
    ...inspection,
    runtimeModels: {
      "runtime-profile:0000000000000001": {
        modelId: "source-model",
        consumers: [{ name: "Writer", usage: "expert" }],
      },
    },
    conflicts: [
      {
        ref: "runtime-profile:0000000000000001",
        resourceKind: "RuntimeProfile",
        importedName: "Built-in Runtime / source-model",
        matches: [
          {
            kind: "identity",
            localRef: "runtime-profile:0000000000000001",
            localName: "Existing Runtime",
          },
        ],
        updateAllowed: true,
      },
    ],
    readiness: [
      {
        id: "runtime-required",
        kind: "runtime",
        resourceRef: "runtime-profile:0000000000000001",
        name: "Built-in Runtime / source-model",
        status: "missing",
        code: "runtime_missing",
        action: "choose_runtime",
        message: "Choose runtime",
      },
    ],
    requirements: [
      {
        id: "runtime-required",
        kind: "runtime",
        resourceRef: "runtime-profile:0000000000000001",
        name: "Built-in Runtime / source-model",
        required: true,
        message: "Choose a compatible local Runtime and model.",
        runtimeRequest: { runtimeId: "pi", providerId: "source-account", modelId: "source-model" },
      },
    ],
  };
  await open(null, [
    {
      id: "pi",
      isDefault: true,
      kind: "local",
      displayName: "Built-in Runtime",
      status: "available",
      models: [
        {
          id: "local-model",
          displayName: "Local Model",
          provider: { kind: "registered", id: "local-account", displayName: "Local Account" },
        },
      ],
    },
    {
      id: "codex",
      isDefault: false,
      kind: "local",
      displayName: "Codex",
      status: "available",
      models: [
        {
          id: "other-model",
          displayName: "Other Model",
          provider: { kind: "registered", id: "other-account", displayName: "Other Account" },
        },
      ],
    },
  ]);
  await waitFor(() => document.querySelector(".pragma-bundle-binding-step") !== null);
}

export async function prepareBundleConflictVisual(
  language: string,
  requirements: PragmaBundleImportInspection["requirements"] = [],
) {
  await i18n.changeLanguage(language);
  activeInspection = {
    ...inspection,
    requirements,
    conflicts: [
      {
        ref: "capability:0000000000000001",
        resourceKind: "Capability",
        importedName: "摩天轮",
        matches: [{ kind: "name", localRef: "capability:0000000000000002", localName: "摩天轮" }],
        updateAllowed: true,
      },
      {
        ref: "capability:0000000000000003",
        resourceKind: "Capability",
        importedName: "code",
        matches: [
          { kind: "identity", localRef: "capability:0000000000000003", localName: "本地代码工具" },
          { kind: "name", localRef: "capability:0000000000000004", localName: "code" },
        ],
        updateAllowed: false,
      },
      {
        ref,
        resourceKind: "ContextStore",
        importedName: "产品知识库",
        matches: [{ kind: "name", localRef: ref, localName: "产品知识库" }],
        updateAllowed: true,
      },
    ],
  };
  await open(null);
  await waitFor(() => document.querySelector(".pragma-bundle-conflict-choice") !== null);
  const groups = [...document.querySelectorAll<HTMLElement>(".pragma-bundle-conflict-choice")];
  for (const group of groups) {
    const buttons = [...group.querySelectorAll("button")];
    assert(buttons.length === 3, "Each conflict must have three actions");
    assert(
      buttons.every((item) => item.querySelector("svg") !== null),
      "Each action must have an icon",
    );
    const top = buttons[0]!.getBoundingClientRect().top;
    assert(
      buttons.every((item) => Math.abs(item.getBoundingClientRect().top - top) < 1),
      "Conflict actions must stay on one row",
    );
    assert(group.scrollWidth <= group.clientWidth, "Conflict actions must fit without overflow");
  }
  const first = groups[0]!.querySelectorAll("button");
  await click(first[1]!);
  assert(first[1]!.getAttribute("aria-pressed") === "true", "Keep local must update selection");
  const blocked = groups[1]!.querySelectorAll("button");
  assert(
    blocked[1]!.disabled && blocked[2]!.disabled,
    "Ambiguous local matches must remain disabled",
  );
  first[1]!.focus();
  await frames();
  const description = document.getElementById(first[1]!.getAttribute("aria-describedby")!);
  assert(
    description?.getAttribute("role") === "tooltip" &&
      getComputedStyle(description).visibility === "visible",
    "Conflict action explanation must be visible on keyboard focus",
  );
  assert(
    description.textContent === i18n.t("studio:bundleKeepLocalHint"),
    "Keep-local tooltip must explain reuse and imported references",
  );
  const disabledTrigger = blocked[2]!.parentElement!;
  disabledTrigger.focus();
  await frames();
  const blockedDescription = document.getElementById(
    disabledTrigger.getAttribute("aria-describedby")!,
  );
  assert(
    blockedDescription &&
      getComputedStyle(blockedDescription).visibility === "visible" &&
      blockedDescription.textContent?.includes(i18n.t("studio:bundleUpdateBlocked")),
    "Disabled actions must explain why they cannot be used",
  );
  first[1]!.focus();
}

export async function prepareBundleResumeVisual(language: string) {
  activeInspection = inspection;
  await i18n.changeLanguage(language);
  await open(modern, [], false, false);
  const history = document.querySelector(".pragma-bundle-resume-list")!;
  const file = document.querySelector(".pragma-bundle-dropzone")!;
  assert(
    history.getBoundingClientRect().bottom <= file.getBoundingClientRect().top,
    "Unfinished imports must appear above the file chooser",
  );
  assert(
    history.scrollWidth <= history.clientWidth &&
      history.getBoundingClientRect().left >= 0 &&
      history.getBoundingClientRect().right <= window.innerWidth + 1,
    "Recovery history must fit the dialog viewport",
  );
}

export async function prepareMarketModelsVisual(language: string, team: boolean) {
  await i18n.changeLanguage(language);
  const modelRef = "runtime-profile:0000000000000001";
  const writer = team ? "代码评审专家" : "菜鸟 APP 查件业务专家";
  const item: PragmaBundleImportInspection = {
    ...inspection,
    root: {
      ref: team ? "team:p8cbn3cg2avyksn4" : "expert:1xddvess309a6gme",
      kind: team ? "ExpertTeam" : "Expert",
      name: team ? "研发协作专家团" : writer,
    },
    roots: [],
    resources: team ? 53 : 3,
    resourceDetails: [
      ...(team
        ? [{ ref: "team:p8cbn3cg2avyksn4", kind: "ExpertTeam" as const, name: "研发协作专家团" }]
        : []),
      ...Array.from({ length: team ? 50 : 1 }, (_, index) => ({
        ref: `expert:${String(index + 1).padStart(16, "0")}`,
        kind: "Expert" as const,
        name: team ? `${writer} ${index + 1}` : writer,
      })),
      { ref: modelRef, kind: "RuntimeProfile", name: "qwen3.7-plus" },
      { ref: "capability:0000000000000001", kind: "Capability", name: "Documentation search" },
    ],
    dependencies: [
      { kind: "runtime", ref: modelRef, name: "Built-in Runtime / qwen3.7-plus", included: false },
      {
        kind: "capability",
        ref: "capability:0000000000000001",
        name: "Documentation search",
        included: true,
      },
    ],
    runtimeModels: {
      [modelRef]: {
        modelId: "qwen3.7-plus",
        consumers: team
          ? Array.from({ length: 50 }, (_, index) => ({
              name: "研发协作专家团",
              usage: "team-delegation" as const,
              targetName: `${writer} ${index + 1}`,
            }))
          : [{ name: writer, usage: "expert" }],
      },
    },
  };
  flushSync(() =>
    root.render(
      <main
        className="square-detail-main"
        style={{ padding: 32, width: Math.min(960, window.innerWidth), boxSizing: "border-box" }}
      >
        <section>
          <h2>{item.root.name}</h2>
          <SquareBundleContents inspection={item} />
        </section>
      </main>,
    ),
  );
  await frames();
  assert(
    !document.body.textContent?.includes("Built-in Runtime"),
    "Market details must not expose catalog runtime resources as independent dependencies",
  );
  assert(
    document.body.textContent?.includes("qwen3.7-plus"),
    "Market details must preserve the requested source model",
  );
  const resourceCard = document.querySelector<HTMLButtonElement>(".square-content-card");
  assert(resourceCard, "Resource card must be available");
  await click(resourceCard);
  const resourcesDialog = document.querySelector<HTMLElement>(".square-content-dialog");
  assert(resourcesDialog, "Resource details must open");
  const entries = resourcesDialog.querySelectorAll(".square-content-detail-list li");
  assert(entries.length === item.resources, "The resource count must match the complete inventory");
  assert(
    resourcesDialog.textContent?.includes("Documentation search"),
    "Included capabilities must be listed",
  );
  assert(
    [...entries].every((entry) => entry.querySelector("small")?.textContent),
    "Every resource must show its type",
  );
  if (team) {
    assert(resourcesDialog.textContent?.includes(`${writer} 50`), "All 50 experts must be listed");
    const body = resourcesDialog.querySelector<HTMLElement>(".ui-dialog-body");
    assert(
      body && body.scrollHeight > body.clientHeight,
      "The resource inventory must scroll within the dialog",
    );
    body.scrollTop = body.scrollHeight;
  }
  const close = resourcesDialog.querySelector<HTMLButtonElement>("button");
  assert(close, "Resource details must offer a close button");
  await click(close);
  const card = document.querySelectorAll<HTMLButtonElement>(".square-content-card")[2];
  assert(card, "Model overview card must be available");
  assert(!card.textContent?.includes(writer), "The model card must not expand consumers");
  card.focus();
  await click(card);
  const dialog = document.querySelector<HTMLElement>(".square-content-dialog");
  assert(dialog, "Model details must open");
  assert(dialog.textContent?.includes(writer), "The text dialog must name the model consumer");
  if (team) {
    assert(dialog.textContent?.includes(`${writer} 50`), "All 50 consumers must remain accessible");
    const body = dialog.querySelector<HTMLElement>(".ui-dialog-body");
    assert(
      body && body.scrollHeight > body.clientHeight,
      "Long details must scroll inside the dialog",
    );
    body.scrollTop = body.scrollHeight;
  }
  const bounds = dialog.getBoundingClientRect();
  assert(bounds.top >= 0 && bounds.bottom <= window.innerHeight, "Details must fit the viewport");
  assert(dialog.scrollWidth <= dialog.clientWidth, "Long text must wrap within the dialog");
  dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await frames();
  assert(!document.querySelector(".square-content-dialog"), "Escape must close the details");
  assert(document.activeElement === card, "Closing details must restore focus to its card");
}
