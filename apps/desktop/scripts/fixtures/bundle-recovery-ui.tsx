import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { PragmaBundleDialog } from "../../src/renderer/src/pages/studio/PragmaBundleDialog.tsx";
import { i18n } from "../../src/renderer/src/i18n/index.ts";
import type {
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
let installation: PragmaBundleInstallation | null = legacy;
let blockDiscard = false;
let calls = { start: 0, recheck: 0, discard: 0 };
let submittedRequestId: string | undefined;
const api: Pick<
  PragmaDesktopAPI,
  | "inspectPragmaBundle"
  | "listPragmaBundleInstallations"
  | "recheckPragmaBundleInstallation"
  | "discardPragmaBundleInstallation"
  | "importPragmaBundle"
> = {
  inspectPragmaBundle: async () => ({
    ...inspection,
    ...(installation === null ? {} : { alreadyInstalledId: installation.id }),
  }),
  listPragmaBundleInstallations: async () => (installation === null ? [] : [installation]),
  recheckPragmaBundleInstallation: async () => {
    calls.recheck++;
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
async function open(record: PragmaBundleInstallation) {
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
        runtimes={[]}
        initialSourcePath={inspection.sourcePath}
        onRefreshRuntimes={async () => []}
        onClose={() => undefined}
        onChanged={() => undefined}
      />,
    ),
  );
  await waitFor(() =>
    [...document.querySelectorAll<HTMLButtonElement>("button")].some(
      (item) => item.textContent?.trim() === i18n.t("studio:bundleContinue") && !item.disabled,
    ),
  );
  await click(button(i18n.t("studio:bundleContinue")));
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
  return {
    passed: 3,
    scenarios: [
      "legacy installing",
      "legacy failed",
      "confirmed cleanup, blocked cleanup and fresh retry",
    ],
  };
}

export async function prepareBundleRecoveryVisual(language: string) {
  await i18n.changeLanguage(language);
  await open(modern);
  await click(button(i18n.t("studio:bundleDiscardImport")));
}
