import { useState } from "react";
import { MissionImagePreviewDialog } from "../../src/renderer/src/components/MissionAttachments.tsx";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import type {
  MissionWorkConversationSnapshot,
  MissionWorkConversationStreamUpdate,
  MissionWorkRecord,
  PragmaDesktopAPI,
} from "../../src/shared/contracts/index.ts";
import { i18n } from "../../src/renderer/src/i18n/index.ts";
import { useMissionWork } from "../../src/renderer/src/pages/missions/use-mission-work.ts";
import { MissionWorkDrawer } from "../../src/renderer/src/pages/missions/mission-work-drawer.tsx";
import { MissionWorkErrorNotice } from "../../src/renderer/src/pages/missions/mission-work-error-notice.tsx";
import {
  MissionTeamParticipantList,
  missionParticipantWorkRecords,
} from "../../src/renderer/src/pages/missions/mission-participants-work.tsx";
import "../../src/renderer/src/styles/index.css";

const record: MissionWorkRecord = {
  recordId: "child",
  kind: "agent",
  sessionId: "child",
  parentRecordId: "root",
  executorId: "reviewer",
  title: "Reviewer",
  avatarId: "pragma.avatar.expert.08",
  origin: "core",
  status: "running",
  tasks: [],
  summary: "Review the change",
  createdAt: "2026-10-27T00:00:00.000Z",
  updatedAt: "2026-10-27T00:00:00.000Z",
};
const snapshot = (text: string): MissionWorkConversationSnapshot => ({
  missionId: "mission",
  recordId: record.recordId,
  revision: 1,
  nextBeforeCursor: "earlier",
  entries: [
    {
      id: "answer",
      kind: "assistant",
      content: text,
      streaming: false,
      createdAt: record.createdAt,
    },
  ],
});
const formatError = (error: unknown) => String(error);
let failList = true;
let failOpen = true;
let failEarlier = true;
let failRefresh = false;
let openCalls = 0;
let closeCalls = 0;
let workChanged: (() => void) | undefined;
let conversationChanged: ((value: MissionWorkConversationStreamUpdate) => void) | undefined;
let subscriptionId = "";
let sequence = 0;
let finishEarlier: ((value: MissionWorkConversationSnapshot) => void) | undefined;
let deferEarlier = false;
let work: ReturnType<typeof useMissionWork>;
let showImagePreview: () => void;
const api = {
  getMissionWork: async () => {
    if (failList) throw new Error("List failed");
    return { missionId: "mission", revision: 1, records: [record] };
  },
  subscribeMissionWork: (_id, callback) => {
    workChanged = () => callback({ missionId: "mission", revision: 1 });
    return () => {
      workChanged = undefined;
    };
  },
  subscribeMissionWorkConversationUpdates: (callback) => {
    conversationChanged = callback;
    return () => {
      conversationChanged = undefined;
    };
  },
  openMissionWorkConversationStream: async (input) => {
    openCalls += 1;
    subscriptionId = input.subscriptionId;
    sequence = 0;
    if (failOpen) throw new Error("Open failed");
    return { subscriptionId, streamId: "stream", snapshot: snapshot("Visible answer") };
  },
  closeMissionWorkConversationStream: async () => {
    closeCalls += 1;
  },
  getMissionWorkConversation: async (input) => {
    if (input.beforeCursor !== undefined) {
      if (failEarlier) throw new Error("Earlier failed");
      if (deferEarlier)
        return await new Promise<MissionWorkConversationSnapshot>((resolve) => {
          finishEarlier = resolve;
        });
      return {
        ...snapshot("Visible answer"),
        nextBeforeCursor: undefined,
        entries: [
          {
            id: "earlier",
            kind: "user" as const,
            content: "Earlier input",
            createdAt: record.createdAt,
          },
        ],
      };
    }
    if (failRefresh) throw new Error("Refresh failed");
    return snapshot("Refreshed answer");
  },
} satisfies Pick<
  PragmaDesktopAPI,
  | "getMissionWork"
  | "subscribeMissionWork"
  | "subscribeMissionWorkConversationUpdates"
  | "openMissionWorkConversationStream"
  | "closeMissionWorkConversationStream"
  | "getMissionWorkConversation"
>;

function App(props: { team: boolean }) {
  const [previewOpen, setPreviewOpen] = useState(false);
  showImagePreview = () => setPreviewOpen(true);
  work = useMissionWork({
    missionId: "mission",
    executionId: "execution",
    active: true,
    api,
    formatError,
  });
  const records = missionParticipantWorkRecords(
    work.records,
    props.team
      ? [
          {
            ref: "expert:reviewer",
            name: "Reviewer",
            description: "Reviews changes",
            avatarId: "pragma.avatar.expert.08",
          },
        ]
      : undefined,
  );
  return (
    <main>
      <button id="outside">Outside</button>
      <MissionWorkErrorNotice
        title={i18n.t("workHistoryUnavailable", { ns: "missions" })}
        error={work.error}
        loading={work.loading}
        onRetry={work.retry}
      />
      <MissionTeamParticipantList
        records={records}
        allRecords={work.records}
        onOpenWork={() => undefined}
        onSelect={work.selectRecord}
      />
      {work.selectedRecord === undefined ? null : (
        <MissionWorkDrawer
          key={work.selectedRecord.recordId}
          missionId="mission"
          record={work.selectedRecord}
          inputSenderName="Host"
          loading={work.conversationLoading}
          entries={work.conversation?.entries ?? []}
          error={work.conversationError}
          earlierError={work.earlierError}
          onRetry={work.retryConversation}
          onLoadEarlier={
            work.conversation?.nextBeforeCursor === undefined ? undefined : work.loadEarlier
          }
          onClose={() => work.selectRecord(null)}
        />
      )}
      {previewOpen ? (
        <MissionImagePreviewDialog
          name="Test image"
          src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10'/%3E"
          onClose={() => setPreviewOpen(false)}
        />
      ) : null}
    </main>
  );
}

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
async function click(selector: string) {
  const target = element(selector);
  target.focus();
  flushSync(() => target.click());
  await frames();
}
function key(value: string, shiftKey = false) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    shiftKey,
    bubbles: true,
    cancelable: true,
  });
  flushSync(() => document.activeElement?.dispatchEvent(event));
  return event;
}
function invalidate() {
  conversationChanged?.({
    subscriptionId,
    streamId: "stream",
    missionId: "mission",
    recordId: record.recordId,
    sequence: ++sequence,
    kind: "invalidate",
  });
}

export async function runMissionWorkUiTests() {
  for (const team of [false, true]) {
    failList = true;
    failOpen = true;
    failEarlier = true;
    failRefresh = false;
    const beforeOpen = openCalls;
    const beforeClose = closeCalls;
    await i18n.changeLanguage("en");
    flushSync(() => root.render(<App key={String(team)} team={team} />));
    await frames();
    assert(element('[role="alert"]').textContent?.includes("List failed"), "List failure hidden");
    failList = false;
    await click(".mission-work-error-notice button");
    assert(!document.querySelector('[role="alert"]'), "List retry did not clear error");
    const avatar = element(".mission-team-participant");
    await click(".mission-team-participant");
    const drawer = element(".mission-work-drawer");
    const close = element<HTMLButtonElement>(".mission-work-drawer > header > button");
    assert(document.activeElement === close, "Opening drawer did not focus close");
    assert(drawer.textContent?.includes("Open failed"), "Open failure hidden");
    assert(
      !drawer.textContent?.includes("Waiting for this agent"),
      "Failure rendered as empty waiting",
    );
    const retry = element(".mission-work-drawer .mission-work-error-notice button");
    assert(
      key("Tab", true).defaultPrevented && document.activeElement === retry,
      "Shift+Tab escaped drawer",
    );
    assert(key("Tab").defaultPrevented && document.activeElement === close, "Tab escaped drawer");
    element("#outside").focus();
    assert(
      document.activeElement === close,
      `Focus moved behind modal: ${document.activeElement?.outerHTML}; close connected ${close.isConnected}`,
    );
    failOpen = false;
    await click(".mission-work-drawer .mission-work-error-notice button");
    assert(
      drawer.textContent?.includes("Visible answer"),
      "Conversation retry did not load answer",
    );
    assert(!drawer.querySelector('[role="alert"]'), "Conversation error not cleared");
    close.focus();
    flushSync(() => showImagePreview());
    await frames();
    assert(
      document.querySelectorAll('[role="dialog"]').length === 2,
      "Image preview did not open above drawer",
    );
    assert(!drawer.contains(document.activeElement), "Drawer stole focus from image preview");
    key("Escape");
    await frames();
    assert(document.querySelectorAll('[role="dialog"]').length === 1, "Escape closed wrong modal");
    assert(document.activeElement === close, "Image preview did not restore drawer focus");
    const opensBeforeListRetry = openCalls;
    failList = true;
    workChanged?.();
    await frames();
    assert(
      element("main > [role=alert]").textContent?.includes("List failed"),
      "Background list failure hidden",
    );
    failList = false;
    flushSync(() => work.retry());
    await frames();
    assert(openCalls === opensBeforeListRetry, "List retry reopened conversation stream");
    await click(".mission-work-drawer .mission-load-earlier");
    assert(drawer.textContent?.includes("Earlier failed"), "Pagination failure hidden");
    assert(
      drawer.textContent?.includes("Visible answer"),
      "Pagination failure erased conversation",
    );
    failEarlier = false;
    await click(".mission-work-drawer .mission-work-error-notice button");
    assert(drawer.textContent?.includes("Earlier input"), "Pagination retry failed");
    failRefresh = true;
    invalidate();
    await frames();
    assert(drawer.textContent?.includes("Refresh failed"), "Stream refresh failure hidden");
    failRefresh = false;
    await click(".mission-work-drawer .mission-work-error-notice button");
    assert(drawer.textContent?.includes("Earlier input"), "Retry erased loaded history");
    conversationChanged?.({
      subscriptionId,
      streamId: "stream",
      missionId: "mission",
      recordId: record.recordId,
      sequence: ++sequence,
      kind: "patch",
      patches: [{ type: "entry.append", entryId: "answer", field: "content", delta: " live" }],
    });
    await frames();
    assert(
      drawer.textContent?.includes("Visible answer live"),
      "Retry did not restore live stream",
    );
    for (const language of ["zh-Hans", "zh-Hant", "en"]) {
      await i18n.changeLanguage(language);
      failRefresh = true;
      invalidate();
      await frames();
      assert(
        drawer.textContent?.includes(i18n.t("workConversationUnavailable", { ns: "missions" })),
        `Missing translated error in ${language}`,
      );
      failRefresh = false;
      await click(".mission-work-drawer .mission-work-error-notice button");
    }
    close.focus();
    key("Escape");
    await frames();
    assert(!document.querySelector(".mission-work-drawer"), "Escape did not close drawer");
    assert(document.activeElement === avatar, "Escape did not restore avatar focus");
    assert(openCalls - beforeOpen === closeCalls - beforeClose, "Conversation subscription leaked");
    await click(".mission-team-participant");
    deferEarlier = true;
    flushSync(() => {
      void work.loadEarlier();
    });
    await frames();
    assert(finishEarlier, "Deferred history request not started");
    flushSync(() => work.selectRecord(null));
    finishEarlier(snapshot("Stale response"));
    deferEarlier = false;
    await frames();
    await click(".mission-team-participant");
    assert(
      !element(".mission-work-drawer").textContent?.includes("Stale response"),
      "Closed request leaked into reopened drawer",
    );
    await click(".mission-work-drawer-scrim");
    assert(!document.querySelector(".mission-work-drawer"), "Scrim did not close drawer");
    // The scrim is not a keyboard target; opening through the avatar still restores it.
    assert(document.body.style.overflow !== "hidden", "Drawer did not restore scrolling");
  }
  flushSync(() => root.render(null));
  await frames();
  assert(
    workChanged === undefined && conversationChanged === undefined,
    "Unmount left subscriptions",
  );
  return { passed: true, modes: ["expert", "team"], locales: ["en", "zh-Hans", "zh-Hant"] };
}

export async function prepareMissionWorkKeyboardTest() {
  failList = false;
  failOpen = false;
  failEarlier = true;
  failRefresh = false;
  await i18n.changeLanguage("en");
  flushSync(() => root.render(<App team={false} />));
  await frames();
  await click(".mission-team-participant");
}
