import { useState } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { i18n } from "../../src/renderer/src/i18n/index.ts";
import { MissionRailRow } from "../../src/renderer/src/pages/missions/mission-rail.tsx";
import { MissionRenameDialog } from "../../src/renderer/src/pages/missions/mission-rename-dialog.tsx";
import type { MissionSummary } from "../../src/shared/contracts/index.ts";
import "../../src/renderer/src/styles/index.css";

const mission = {
  id: "00000000-0000-4000-8000-000000000001",
  title: "通过 adb 读取日志排查问题，查看首页包裹列表",
  goal: "Original task",
  lifecycleStatus: "active",
  executor: { kind: "expert", name: "通用研发专家团", ref: "expert:0000000000pragma" },
  workspace: { path: "/workspace", basename: "workspace" },
  project: { id: "studio", revision: 1 },
  createdAt: "2026-10-15T08:00:00.000Z",
  updatedAt: "2026-10-15T08:00:00.000Z",
  source: { type: "task" },
} as MissionSummary;
let failSave = false;
let saveCalls = 0;
let opened = 0;
let pendingSave: (() => void) | undefined;
function App() {
  const [title, setTitle] = useState(mission.title);
  const [editing, setEditing] = useState(false);
  return (
    <main style={{ padding: 32 }}>
      <aside style={{ width: 300 }}>
        <MissionRailRow
          mission={{ ...mission, title }}
          completed={false}
          pinned={false}
          unread={false}
          selected={false}
          onRename={() => setEditing(true)}
          onOpen={() => {
            opened += 1;
          }}
          onTogglePin={() => undefined}
          onMarkComplete={() => undefined}
          onDelete={() => undefined}
        />
      </aside>
      <button id="outside" type="button">
        Outside
      </button>
      {editing ? (
        <MissionRenameDialog
          mission={{ ...mission, title }}
          onClose={() => setEditing(false)}
          onSave={async (value) => {
            saveCalls += 1;
            if (failSave) throw new Error("Save failed; try again");
            await new Promise<void>((resolve) => {
              pendingSave = resolve;
            });
            setTitle(value);
          }}
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
function mouse(target: HTMLElement, type: string, relatedTarget: EventTarget | null = null) {
  flushSync(() => target.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget })));
}
function key(target: HTMLElement, value: string, extra: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", {
    key: value,
    bubbles: true,
    cancelable: true,
    ...extra,
  });
  flushSync(() => target.dispatchEvent(event));
  return event;
}
function change(value: string) {
  const input = element<HTMLInputElement>(".mission-rename-input");
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
  flushSync(() => input.dispatchEvent(new Event("input", { bubbles: true })));
}
function saveButton() {
  return element<HTMLButtonElement>(".mission-rename-dialog .primary-button");
}

export async function runMissionRenameUiTests() {
  await i18n.changeLanguage("zh-Hans");
  flushSync(() => root.render(<App />));
  await frames();
  const nativeSet = window.setTimeout.bind(window);
  const nativeClear = window.clearTimeout.bind(window);
  let sequence = -1;
  let now = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  window.setTimeout = ((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
    if ((delay === 100 || delay === 500) && typeof handler === "function") {
      const id = sequence--;
      timers.set(id, { at: now + delay, run: () => handler(...args) });
      return id;
    }
    return nativeSet(handler, delay, ...args);
  }) as typeof window.setTimeout;
  window.clearTimeout = (id) => {
    if (id !== undefined && timers.delete(id)) return;
    nativeClear(id);
  };
  const advance = (ms: number) => {
    now += ms;
    flushSync(() => {
      for (const [id, timer] of timers) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    });
  };
  try {
    const row = element(".mission-row");
    mouse(row, "mouseover");
    advance(499);
    assert(!document.querySelector(".mission-row-preview"), "Preview opened before 500ms");
    advance(1);
    const card = element(".mission-row-preview");
    assert(getComputedStyle(card).pointerEvents === "auto", "Preview is not interactive");
    mouse(row, "mouseout");
    advance(99);
    assert(document.body.contains(card), "Preview closed before 100ms");
    mouse(card, "mouseover");
    advance(200);
    assert(document.body.contains(card), "Preview closed while hovered");
    flushSync(() => element<HTMLButtonElement>(".mission-row-preview-edit").focus());
    flushSync(() => element<HTMLButtonElement>("#outside").focus());
    advance(200);
    assert(document.body.contains(card), "Blur dismissed a hovered preview");
    mouse(card, "mouseout");
    advance(100);
    assert(!document.querySelector(".mission-row-preview"), "Preview did not close after leaving");

    mouse(row, "mouseover");
    advance(500);
    mouse(row, "mouseout");
    advance(50);
    mouse(row, "mouseover");
    advance(100);
    assert(
      document.querySelector(".mission-row-preview"),
      "Returning to the row did not cancel close",
    );
    const edit = element<HTMLButtonElement>(".mission-row-preview-edit");
    mouse(edit, "mousedown");
    mouse(edit, "mouseup");
    mouse(edit, "click");
    await frames();
    assert(opened === 0, "Rename opened the Mission");
    const input = element<HTMLInputElement>(".mission-rename-input");
    assert(
      document.activeElement === input &&
        input.selectionEnd === mission.title.length &&
        input.selectionStart === 0,
      `Original title was not focused and selected: ${document.activeElement?.outerHTML}; ${input.selectionStart}/${input.selectionEnd}`,
    );
    assert(saveButton().disabled, "Unchanged title can be saved");
    change(" ");
    assert(saveButton().disabled, "Blank title can be saved");
    change("😀".repeat(49));
    assert(saveButton().disabled, "Overlong Unicode title can be saved");
    change("😀".repeat(48));
    assert(!saveButton().disabled, "48 Unicode characters were rejected");
    change("修改后的任务");
    assert(
      !key(input, "Enter", { isComposing: true }).defaultPrevented,
      "IME confirmation default was cancelled",
    );
    assert(
      !key(input, "Enter", { keyCode: 229 }).defaultPrevented,
      "Legacy IME confirmation default was cancelled",
    );
    const composingEscape = key(input, "Escape", { isComposing: true });
    assert(
      !composingEscape.defaultPrevented && document.querySelector('[role="dialog"]'),
      "IME Escape closed the dialog or cancelled candidate dismissal",
    );
    assert(saveCalls === 0, "IME confirmation submitted the form");
    failSave = true;
    key(input, "Enter");
    await frames();
    assert(
      document.querySelector('[role="alert"]')?.textContent?.includes("Save failed"),
      "Save error was not shown",
    );
    assert(input.value === "修改后的任务", "Failed save lost the draft");
    failSave = false;
    flushSync(() => saveButton().focus());
    mouse(saveButton(), "click");
    key(input, "Enter");
    assert(Number(saveCalls) === 2 && saveButton().disabled, "Duplicate submission was accepted");
    assert(document.activeElement === input, "Saving dropped focus outside the dialog");
    const busyTab = key(input, "Tab");
    assert(
      busyTab.defaultPrevented && document.activeElement === input,
      "Busy dialog does not contain keyboard focus",
    );
    key(input, "Escape");
    assert(document.querySelector('[role="dialog"]'), "Busy dialog was dismissed");
    pendingSave?.();
    await frames();
    assert(!document.querySelector('[role="dialog"]'), "Successful save did not close");
    assert(
      element(".mission-row-open").textContent?.includes("修改后的任务"),
      "Title did not refresh",
    );

    // Keyboard entry into the interactive Portal and Escape dismissal.
    mouse(row, "mouseover");
    advance(500);
    flushSync(() => element<HTMLButtonElement>(".mission-row-open").focus());
    const lastAction = element<HTMLButtonElement>(".mission-row-actions button:last-child");
    flushSync(() => lastAction.focus());
    key(lastAction, "Tab");
    assert(
      document.activeElement?.closest(".mission-row-preview"),
      "Tab cannot reach the edit button",
    );
    advance(500);
    assert(document.querySelector(".mission-row-preview"), "Focused Portal closed");
    key(document.activeElement as HTMLElement, "Tab");
    assert(
      document.activeElement === element("#outside"),
      "Tab from preview skipped the next control in page order",
    );
    flushSync(() => lastAction.focus());
    key(lastAction, "Tab");
    assert(
      document.activeElement?.closest(".mission-row-preview"),
      "Cannot re-enter preview using Tab",
    );
    key(document.activeElement as HTMLElement, "Escape");
    assert(!document.querySelector(".mission-row-preview"), "Escape did not dismiss preview");
    mouse(row, "mouseover");
    advance(500);
    mouse(element(".mission-row-preview-edit"), "click");
    await frames();
    key(element(".mission-rename-input"), "Escape");
    await frames();
    assert(!document.querySelector('[role="dialog"]'), "Escape did not cancel dialog");

    // Unmounting a row cancels its pending opening timer; long existing titles remain intact.
    mouse(row, "mouseover");
    advance(100);
    flushSync(() =>
      root.render(
        <MissionRenameDialog
          mission={{ id: mission.id, title: "x".repeat(80) }}
          onSave={async () => undefined}
          onClose={() => undefined}
        />,
      ),
    );
    await frames();
    assert(timers.size === 0, "Unmount left a preview timer running");
    assert(
      element<HTMLInputElement>(".mission-rename-input").value.length === 80,
      "Existing long title was truncated",
    );
    assert(saveButton().disabled, "Existing long title can be resaved over the authoring limit");
    change("Short title");
    assert(!saveButton().disabled, "Existing long title cannot be corrected");
    flushSync(() => root.render(<App />));
    await frames();
    // Leave a focused dialog available for visual inspection.
    mouse(element(".mission-row"), "mouseover");
    advance(500);
    mouse(element(".mission-row-preview-edit"), "click");
    await frames();
    return {
      passed: true,
      checks:
        "hover timers, Portal click and Tab order, Unicode validation, IME defaults and Escape, busy focus trap, retry, duplicate save, refresh",
    };
  } finally {
    window.setTimeout = nativeSet;
    window.clearTimeout = nativeClear;
  }
}

export async function prepareMissionRenameVisual(language: string) {
  await i18n.changeLanguage(language);
  await frames();
}
