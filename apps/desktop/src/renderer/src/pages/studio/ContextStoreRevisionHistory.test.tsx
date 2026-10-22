import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";

import type {
  ContextStoreDraft,
  ContextStoreRevisionJob,
} from "../../../../shared/contracts/index.ts";
import { i18n } from "../../i18n/index.ts";
import {
  ContextStoreRevisionDiffFragment,
  ContextStoreRevisionFragment,
} from "./ContextStoreRevisionFragment.tsx";
import { ContextStoreDirectoryFragment } from "./ContextStoreFragment.tsx";
import { CapabilityDirectoryFragment } from "./CapabilityDirectoryFragment.tsx";
import { StudioPage } from "./StudioPage.tsx";

// Exercise the same hook/event boundary as the repository's settings interaction tests.
const hooks = vi.hoisted(() => {
  const slots: Array<{
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[] | undefined;
  }> = [];
  const effects: Array<() => void> = [];
  let cursor = 0;
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
      cursor = 0;
    },
    begin() {
      cursor = 0;
    },
    commit() {
      effects.splice(0).forEach((effect) => effect());
    },
    useState<T>(initial?: T) {
      const slot = (slots[cursor++] ??= { value: initial });
      return [
        slot.value as T,
        (next: T | ((previous: T) => T)) => {
          slot.value =
            typeof next === "function" ? (next as (previous: T) => T)(slot.value as T) : next;
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      return (slots[cursor++] ??= { current: initial }) as { current: T };
    },
    useEffect(effect: () => void, deps?: readonly unknown[] | undefined) {
      const index = cursor++;
      if (
        deps !== undefined &&
        slots[index]?.deps?.length === deps.length &&
        deps.every((dep, i) => Object.is(dep, slots[index]?.deps?.[i]))
      )
        return;
      slots[index] = { deps };
      effects.push(effect);
    },
  };
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
  useEffect: hooks.useEffect,
  useLayoutEffect: hooks.useEffect,
}));
vi.mock("react-i18next", async () => {
  const { i18n } = await import("../../i18n/index.ts");
  return { useTranslation: (namespace: string) => ({ t: i18n.getFixedT(null, namespace), i18n }) };
});

function elements(tree: ReactNode) {
  const result: Array<ReturnType<typeof element>> = [];
  function element(node: ReactNode) {
    return isValidElement<Record<string, unknown>>(node) ? node : undefined;
  }
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    const item = element(node);
    if (item === undefined) return;
    result.push(item);
    visit(item.props.children as ReactNode);
    visit(item.props.header as ReactNode);
  };
  visit(tree);
  return result.filter((item) => item !== undefined);
}

afterEach(async () => {
  hooks.reset();
  vi.unstubAllGlobals();
  await i18n.changeLanguage("en");
});

it.each(["context-stores", "skills"] as const)(
  "counts unfinished %s revisions on cold start without opening revision history",
  async (activeView) => {
    const knowledgeJobs = [
      { state: "pending_review" },
      { state: "needs_attention" },
      ...Array.from({ length: 6 }, () => ({ state: "merged" })),
      { state: "rejected" },
    ];
    const skillJobs = [
      { job: { state: "pending_review" } },
      { job: { state: "needs_attention" } },
      ...Array.from({ length: 6 }, () => ({ job: { state: "completed" } })),
      { job: { state: "rejected" } },
      { job: { state: "superseded" } },
    ];
    vi.stubGlobal("window", {
      pragmaDesktop: {
        listExperts: async () => [],
        getPragmaProject: async () => null,
        listAutomations: async () => [],
        listContextStores: async () => [],
        listPragmaContextStoreBindings: async () => [],
        listContextStoreRevisions: async () => knowledgeJobs,
        listSkillRevisionJobs: async () => skillJobs,
        listCapabilities: async () => [],
        getRuntimeAvailability: async () => [],
      },
    });
    const render = () => {
      hooks.begin();
      const tree = StudioPage({
        memoryEnabled: true,
        initialMemoryState: { activeView },
        onUseInSession: () => undefined,
      });
      hooks.commit();
      return tree;
    };
    render();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    const directoryType =
      activeView === "context-stores" ? ContextStoreDirectoryFragment : CapabilityDirectoryFragment;
    const directory = elements(render()).find((node) => node.type === directoryType);
    expect(directory).toBeDefined();
    expect(directory!.props.revisionTaskCount).toBe(2);
  },
);

it("opens rejected Store history and its Diff after review while keeping all continuation actions unavailable", async () => {
  hooks.reset();
  await i18n.changeLanguage("zh-Hans");
  let job: ContextStoreRevisionJob = {
    schemaVersion: "pragma.context-store-revision-job/v4",
    submissionApprovalMode: "required",
    id: "10000000-0000-4000-8000-000000000001",
    revision: 1,
    draftId: "20000000-0000-4000-8000-000000000001",
    state: "pending_review",
    request: {
      schemaVersion: "pragma.context-store-revision-request/v2",
      operation: "revise",
      storeId: "30000000-0000-4000-8000-000000000001",
      prompt: "Review this change",
      source: "user",
    },
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
  };
  let draft: ContextStoreDraft = {
    schemaVersion: "pragma.context-store-draft/v2",
    id: job.draftId,
    revision: 1,
    operation: "revise",
    name: "Review draft",
    storeId: job.request.storeId,
    state: "pending_review",
    baseRevision: 1,
    baseSnapshotHash: "a".repeat(64),
    submittedRevision: 1,
    summary: "Add verification guidance",
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    overlay: {
      files: [
        {
          id: "guide.md",
          content: "Verify results before completion.",
          metadata: { trigger: "manual", priority: "normal" },
        },
      ],
      deletedFiles: [],
      directories: [],
      deletedDirectories: [],
    },
  };
  const reject = vi.fn(async () => {
    job = {
      ...job,
      revision: 2,
      state: "rejected",
      error: { code: "revision_user_rejected", message: "Ended by user" },
    };
    draft = { ...draft, revision: 2, state: "needs_attention", submittedRevision: undefined };
    return job;
  });
  vi.stubGlobal("window", {
    setTimeout: vi.fn(),
    clearTimeout: vi.fn(),
    pragmaDesktop: {
      listContextStoreRevisions: async () => [job],
      listContextStoreDrafts: async () => [draft],
      listContextStoreRevisionRecords: async () => [],
      rejectContextStoreRevision: reject,
      getContextStoreDraftChangeSet: async () => ({
        schemaVersion: "pragma.context-store-change-set/v2",
        operation: "revise",
        storeId: draft.storeId,
        baseRevision: draft.baseRevision,
        baseSnapshotHash: draft.baseSnapshotHash,
        summary: draft.summary,
        operations: draft.overlay.files.map((file) => ({ operation: "upsert", ...file })),
      }),
    },
  });
  const onCountChanged = vi.fn();
  const render = () => {
    hooks.begin();
    const tree = ContextStoreRevisionFragment({
      stores: [],
      onCountChanged,
      onBack: () => undefined,
    });
    hooks.commit();
    return tree;
  };
  const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
  };
  render();
  await flush();
  expect(onCountChanged).toHaveBeenLastCalledWith(1);
  const open = () => {
    const button = elements(render()).find(
      (node) => node.props.className === "revision-task-open",
    )!;
    expect(button.props.disabled).toBe(false);
    (button.props.onClick as () => void)();
    const detail = render();
    expect(detail.type).toBe(ContextStoreRevisionDiffFragment);
    return detail.props as Parameters<typeof ContextStoreRevisionDiffFragment>[0];
  };
  const review = open();
  review.onReject();
  await flush();
  expect(reject).toHaveBeenCalledOnce();
  expect(onCountChanged).toHaveBeenLastCalledWith(0);
  const rejected = render().props as Parameters<typeof ContextStoreRevisionDiffFragment>[0];
  rejected.onBack();
  const history = elements(render());
  expect(
    history.some(
      (node) =>
        node.props.className === "form-error" &&
        node.props.title === i18n.t("revisionUserRejected", { ns: "studio" }),
    ),
  ).toBe(true);
  const detail = open();
  expect(detail.job.state).toBe("rejected");
  expect(detail.draft.overlay.files[0]?.content).toBe("Verify results before completion.");
  hooks.reset();
  hooks.begin();
  ContextStoreRevisionDiffFragment(detail);
  hooks.commit();
  await flush();
  hooks.begin();
  let detailTree = ContextStoreRevisionDiffFragment(detail);
  const fileButton = elements(detailTree).find(
    (node) =>
      node.type === "button" &&
      renderToStaticMarkup(<>{node.props.children as ReactNode}</>).includes("guide.md"),
  )!;
  (fileButton.props.onClick as () => void)();
  hooks.begin();
  detailTree = ContextStoreRevisionDiffFragment(detail);
  const html = renderToStaticMarkup(detailTree);
  expect(html).toContain("Verify results before completion.");
  expect(html).toContain(i18n.t("revisionUserRejected", { ns: "studio" }));
  expect(html).toContain("revision-diff-line is-addition");
  for (const label of ["同意", "驳回", "拒绝", "重试", "打开 Mission 继续", "保存草稿文件"])
    expect(html).not.toContain(`>${label}</button>`);
  expect(html).not.toContain("revision-draft-editor");
});
