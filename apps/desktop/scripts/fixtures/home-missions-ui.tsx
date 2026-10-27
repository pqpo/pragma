import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { App } from "../../src/renderer/src/App.tsx";
import { i18n } from "../../src/renderer/src/i18n/index.ts";
import type { Mission, PragmaDesktopAPI } from "../../src/shared/contracts/index.ts";
import { missionToSummary } from "../../src/renderer/src/pages/missions/mission-page-utils.ts";
import "../../src/renderer/src/styles/index.css";

const workspace = { path: "/workspace/expert-mesh", basename: "expert-mesh" };
const executor = {
  kind: "expert" as const,
  ref: "expert:v2vt1v01vzz6j24q",
  name: "Product Designer",
};
const defaults = { workspace, recentWorkspaces: [], executorRef: executor.ref };
function mission(id: string, title: string): Mission {
  return {
    schemaVersion: "pragma.mission/v12",
    origin: { type: "user" },
    id,
    title,
    goal: title,
    initialMessageId: crypto.randomUUID(),
    workspace,
    project: { id: "studio", revision: 1 },
    contextMounts: [],
    executor,
    lifecycleStatus: "active",
    createdAt: "2026-10-27T08:00:00.000Z",
    updatedAt: "2026-10-27T08:00:00.000Z",
  };
}
const existing = mission(crypto.randomUUID(), "Existing conversation");
const missions = new Map([[existing.id, existing]]);
const runs: string[] = [];
let failNextRun = false;
const methods = {
  listMissions: async () => [...missions.values()].map((value) => missionToSummary(value)),
  getMission: async (id: string) => missions.get(id),
  getMissionListSource: async () => ({ type: "task" }),
  getMissionCreationDefaults: async () => defaults,
  getGlobalMemoryPolicy: async () => ({ policy: { enabled: "disabled" } }),
  listHomeProjects: async () => [],
  listContextStores: async () => [],
  listSkillRevisionJobs: async () => [],
  listContextStoreRevisions: async () => [],
  getBridgeSnapshot: async () => ({ app: { version: "test" } }),
  getHomeMissionExecutorCatalog: async () => ({
    defaults,
    executors: [
      {
        ...executor,
        description: "Review product changes",
        origin: "project",
        readOnly: false,
        customized: false,
        tags: [],
        teamMemberships: [],
        alwaysVisible: true,
        preference: { favoriteScope: "global", hidden: false },
      },
    ],
  }),
  getMissionModelOptions: async () => ({
    runtime: { id: "test" },
    models: [
      {
        provider: { id: "test", name: "Test" },
        id: "test-model",
        displayName: "Test Model",
      },
    ],
    status: "ready",
    defaultSelection: { providerId: "test", modelId: "test-model" },
  }),
  validateWorkspace: async () => ({ ok: true }),
  getMissionChatPage: async ({ id }: { id: string }) => ({
    missionId: id,
    revision: 1,
    entries: [],
    page: { hasMore: false },
  }),
  getMissionConversationState: async (id: string) => ({
    missionId: id,
    revision: 1,
    pendingInteractions: [],
    deliveries: [],
    hiddenEntryIds: [],
  }),
  getMissionContextWindow: async (id: string) => ({ missionId: id, revision: 1 }),
  reportRendererLog: () => undefined,
  createMission: async (input: { input: { value: string } }) => {
    const created = mission(crypto.randomUUID(), input.input.value);
    missions.set(created.id, created);
    return created;
  },
  runMission: async (id: string) => {
    runs.push(id);
    if (failNextRun) {
      failNextRun = false;
      throw new Error("Run failed; retry");
    }
    return missions.get(id);
  },
};
window.pragmaDesktop = new Proxy(methods, {
  get(target, key) {
    if (typeof key === "string" && key.startsWith("subscribe")) return () => () => undefined;
    if (key in target) return target[key as keyof typeof target];
    return () => Promise.reject(new Error(`Unavailable fixture API: ${String(key)}`));
  },
}) as unknown as PragmaDesktopAPI;
window.addEventListener("error", (event) => console.error(event.error?.stack));
const root = createRoot(document.getElementById("root")!);
const frames = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function element<T extends HTMLElement = HTMLElement>(selector: string): T {
  const found = document.querySelector<T>(selector);
  assert(found, `Missing ${selector}`);
  return found;
}
async function waitFor(check: () => boolean) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (check()) return;
    await frames();
  }
  throw new Error("UI did not reach expected state");
}
function click(selector: string) {
  flushSync(() => element(selector).click());
}
async function submit(title: string) {
  await waitFor(() => !!document.querySelector(".home-mission-create textarea"));
  const input = element<HTMLTextAreaElement>(".home-mission-create textarea");
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, title);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
  await waitFor(() => !element<HTMLButtonElement>(".mission-submit-button").disabled);
  click(".mission-submit-button");
  await waitFor(() => document.querySelector(".home-mission-create") === null);
  await frames();
}
export async function runHomeMissionsUiTests() {
  localStorage.clear();
  await i18n.changeLanguage("en");
  flushSync(() => root.render(<App />));
  await frames();
  const rail = element(".mission-rail");
  assert(
    !document.querySelector('nav [aria-label="Missions"]'),
    "Separate Missions navigation remains",
  );
  assert(
    document.querySelector(".mission-main .home-mission-create"),
    "Home composer is not embedded",
  );
  // A stored last-opened task must not take over the initial new conversation.
  await waitFor(() => !!document.querySelector(`[data-mission-id="${existing.id}"]`));
  click(`[data-mission-id="${existing.id}"] .mission-row-open`);
  await waitFor(() => !document.querySelector(".home-mission-create"));
  click(".mission-new-button");
  await submit("First created conversation");
  assert(runs.length === 1, "Created mission was not run exactly once");
  assert(element(".mission-rail") === rail, "Mission list remounted during creation");
  failNextRun = true;
  click(".mission-new-button");
  await submit("Second created conversation");
  assert(runs.length === 2 && runs[0] !== runs[1], "Repeated creation did not run the new mission");
  await waitFor(() => document.body.textContent?.includes("Run failed; retry") === true);
  assert(
    document.querySelector(`[data-mission-id="${runs[1]}"]`),
    "Failed mission disappeared from list",
  );
  click('[aria-label="Run"]');
  await waitFor(() => runs.length === 3);
  assert(runs[2] === runs[1], "Manual retry did not target the failed mission");
  click(".mission-new-button");
  await submit("Third created conversation");
  assert(runs.length === 4, "Creation after a failure did not execute");
  assert(element(".mission-rail") === rail, "List remounted after a failure");
  click(".mission-new-button");
  await frames();
  return { created: 3, runs: runs.length, listPreserved: true };
}
export async function prepareHomeMissionsVisual(language: string) {
  await i18n.changeLanguage(language);
  await frames();
  const main = element(".mission-main").getBoundingClientRect();
  const home = element(".home-mission-create");
  assert(home.getBoundingClientRect().right <= main.right + 1, "Home escaped the detail pane");
  assert(home.scrollWidth <= home.clientWidth + 1, "Home has horizontal overflow");
  assert(
    element(".mission-rail").getBoundingClientRect().right <= main.left + 1,
    "List overlaps composer",
  );
}
