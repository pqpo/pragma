import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
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
  const runtimeSelect = document.querySelector<HTMLButtonElement>('[aria-label="Runtime"]');
  assert(
    runtimeSelect?.textContent?.includes("Built-in Runtime"),
    "Existing Runtime must be preselected even when the source model is missing",
  );
  assert(document.body.textContent?.includes("source-model"), "Source model must be explained");
  assert(
    button("Review import").disabled,
    "Missing source model must require an explicit replacement",
  );
  await click(button("Set up later"));
  await click(button("Back"));
  await waitFor(() => document.querySelector(".pragma-bundle-binding-step") !== null);
  await click(document.querySelector<HTMLButtonElement>('[aria-label="Runtime"]')!);
  await click(
    button("Built-in Runtime", document.querySelector('[role="listbox"]:not([hidden])')!),
  );
  assert(
    button("Review import").disabled,
    "Editing a deferred Runtime must require a complete model selection again",
  );
  const modelSelect = document.querySelector<HTMLButtonElement>('[aria-label="Model"]');
  assert(
    modelSelect && !modelSelect.disabled,
    "Local model selection must be enabled without reselecting Runtime",
  );
  await click(modelSelect);
  await click(button("Local Model · Local Account"));
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
      "preselect Runtime and replace missing source model",
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
