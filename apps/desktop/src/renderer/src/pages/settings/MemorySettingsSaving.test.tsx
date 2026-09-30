import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
  DesktopMemoryExtractorProfile,
  UpdateDesktopMemoryExtractorProfile,
} from "../../../../shared/contracts/index.ts";
import { MemoryAttentionSettingsSection } from "./MemoryAttentionSettingsSection.tsx";
import { MemoryRetrievalSettingsSection } from "./MemoryRetrievalSettingsSection.tsx";
import { MemorySettingsFragment } from "./MemorySettingsFragment.tsx";

// These settings have no DOM dependencies. Drive their hook lifecycle and inspect the IPC boundary.
const hooks = vi.hoisted(() => {
  type Slot = {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[] | undefined;
    callback?: unknown;
    cleanup?: (() => void) | undefined;
  };
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  const effects: Array<() => void> = [];
  const equal = (a?: readonly unknown[], b?: readonly unknown[]) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((value, index) => Object.is(value, b[index]));
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
      cursor = 0;
      dirty = false;
    },
    begin() {
      cursor = 0;
      dirty = false;
    },
    commit() {
      effects.splice(0).forEach((effect) => effect());
    },
    dirty: () => dirty,
    unmount() {
      slots.forEach((slot) => slot.cleanup?.());
    },
    useState<T>(initial?: T | (() => T)) {
      const index = cursor++;
      const slot = (slots[index] ??= {
        value: typeof initial === "function" ? (initial as () => T)() : initial,
      });
      return [
        slot.value as T,
        (value: T | ((previous: T) => T)) => {
          slot.value =
            typeof value === "function" ? (value as (previous: T) => T)(slot.value as T) : value;
          dirty = true;
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      return (slots[cursor++] ??= { current: initial }) as { current: T };
    },
    useCallback<T>(callback: T, deps: readonly unknown[]) {
      const index = cursor++;
      if (!equal(slots[index]?.deps, deps)) slots[index] = { callback, deps };
      return slots[index]!.callback as T;
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      if (equal(slots[index]?.deps, deps)) return;
      const previous = slots[index];
      const slot = (slots[index] = { deps, cleanup: previous?.cleanup });
      effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() ?? undefined;
      });
    },
  };
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useCallback: hooks.useCallback,
  useEffect: hooks.useEffect,
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
});

function renderer(component: () => ReactNode) {
  let tree: ReactNode;
  let mounted = true;
  const render = () => {
    hooks.begin();
    tree = component();
    hooks.commit();
  };
  render();
  return {
    async flush() {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        if (mounted && hooks.dirty()) render();
      }
    },
    props(match: (props: Record<string, unknown>, type: unknown) => boolean) {
      const find = (node: ReactNode): Record<string, unknown> | undefined => {
        if (Array.isArray(node)) {
          for (const child of node) {
            const found = find(child);
            if (found) return found;
          }
        } else if (isValidElement<Record<string, unknown>>(node)) {
          if (match(node.props, node.type)) return node.props;
          return find(node.props.children as ReactNode);
        }
        return undefined;
      };
      const result = find(tree);
      if (!result) throw new Error("Setting control not found");
      return result;
    },
    unmount() {
      mounted = false;
      hooks.unmount();
    },
  };
}

beforeEach(() => {
  hooks.reset();
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function attentionFixture() {
  let finish: (value: { revision: number; configured: boolean; state: "ready" }) => void = () => {};
  let fail: (error: Error) => void = () => {};
  const update = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve, reject) => {
          finish = resolve;
          fail = reject;
        }),
    )
    .mockResolvedValue({ revision: 3, configured: true, state: "ready" });
  vi.stubGlobal("window", {
    pragmaDesktop: {
      getMemoryAttentionStatus: async () => ({ revision: 1, configured: true, state: "ready" }),
      updateMemoryAttentionSettings: update,
    },
  });
  const view = renderer(MemoryAttentionSettingsSection);
  const input = () => view.props((props) => props.id === "memory-attention-key");
  const change = async (value: string) => {
    (input().onChange as (event: { target: { value: string } }) => void)({ target: { value } });
    await view.flush();
  };
  return {
    view,
    update,
    change,
    finish: () => finish({ revision: 2, configured: true, state: "ready" }),
    fail: () => fail(new Error("validation failed")),
  };
}

describe("Memory settings persistence", () => {
  it.each([false, true])(
    "shows model and Jev settings only when embedding is enabled=%s",
    async (enabled) => {
      vi.stubGlobal("window", {
        pragmaDesktop: {
          getMemoryRetrievalStatus: async () => ({
            settings: { schemaVersion: "pragma.memory-retrieval/v1", revision: 0, enabled },
            state: enabled ? "needs_attention" : "disabled",
            indexedMemories: 0,
            totalMemories: 0,
            segments: 0,
            failed: 0,
          }),
          listModelProviders: async () => [],
        },
      });
      const view = renderer(MemoryRetrievalSettingsSection);
      try {
        await view.flush();
        expect(view.props((props) => props.ariaLabel === "memory.retrieval.enable").checked).toBe(
          enabled,
        );
        if (enabled) {
          expect(view.props((props) => props.ariaLabel === "memory.retrieval.model")).toBeDefined();
          expect(view.props((_props, type) => type === MemoryAttentionSettingsSection)).toEqual({});
        } else {
          expect(() => view.props((props) => props.ariaLabel === "memory.retrieval.model")).toThrow(
            "Setting control not found",
          );
          expect(() =>
            view.props((_props, type) => type === MemoryAttentionSettingsSection),
          ).toThrow("Setting control not found");
        }
      } finally {
        view.unmount();
      }
    },
  );

  it("saves the final key after navigation even while validation is in flight", async () => {
    const f = attentionFixture();
    await f.view.flush();
    await f.change("test-key-A");
    await vi.advanceTimersByTimeAsync(700);
    await f.view.flush();
    await f.change("test-key-B");
    f.view.unmount();
    expect(f.update).toHaveBeenCalledTimes(1);
    f.finish();
    await f.view.flush();
    expect(f.update).toHaveBeenNthCalledWith(2, { expectedRevision: 2, apiKey: "test-key-B" });
    expect(f.update).toHaveBeenCalledTimes(2);
  });

  it("removes a key when the final draft is cleared during an in-flight save", async () => {
    const f = attentionFixture();
    await f.view.flush();
    await f.change("test-key-A");
    await vi.advanceTimersByTimeAsync(700);
    await f.view.flush();
    await f.change("");
    f.view.unmount();
    f.finish();
    await f.view.flush();
    expect(f.update).toHaveBeenNthCalledWith(2, { expectedRevision: 2, apiKey: null });
  });

  it("does not persist the redacted placeholder when leaving unchanged settings", async () => {
    const f = attentionFixture();
    await f.view.flush();
    f.view.unmount();
    expect(f.update).not.toHaveBeenCalled();
  });

  it("saves the corrected key even if the earlier validation fails after navigation", async () => {
    const f = attentionFixture();
    await f.view.flush();
    await f.change("invalid-key");
    await vi.advanceTimersByTimeAsync(700);
    await f.view.flush();
    await f.change("corrected-key");
    f.view.unmount();
    f.fail();
    await f.view.flush();
    expect(f.update).toHaveBeenNthCalledWith(2, { expectedRevision: 1, apiKey: "corrected-key" });
  });

  it("persists the retained model when switching back to pinned mode", async () => {
    let profile: DesktopMemoryExtractorProfile = {
      schemaVersion: "pragma.memory-extractor-profile/v1",
      revision: 1,
      mode: "pinned",
      runtimeId: "codex",
      providerId: "openai",
      modelId: "test-model",
      updatedAt: "2026-09-28T00:00:00.000Z",
    };
    const update = vi.fn(async (input: UpdateDesktopMemoryExtractorProfile) => {
      profile = {
        schemaVersion: profile.schemaVersion,
        updatedAt: profile.updatedAt,
        revision: profile.revision + 1,
        ...input.profile,
      };
      return profile;
    });
    vi.stubGlobal("window", {
      pragmaDesktop: {
        getGlobalMemoryPolicy: async () => ({ policy: { enabled: "enabled" } }),
        getMemoryExtractorProfile: async () => profile,
        getMemoryExtractionSettings: async () => ({ allowToolAssisted: {} }),
        getRuntimeAvailability: async () => [
          {
            id: "codex",
            isDefault: true,
            status: "available",
            models: [{ id: "test-model", provider: { id: "openai" } }],
          },
        ],
        updateMemoryExtractorProfile: update,
      },
    });
    const view = renderer(() => MemorySettingsFragment());
    await view.flush();
    const mode = () => view.props((props) => props.label === "memory.extractorMode");
    (mode().onChange as (mode: string) => void)("inherit-default");
    await view.flush();
    (mode().onChange as (mode: string) => void)("pinned");
    await view.flush();
    expect(update).toHaveBeenNthCalledWith(2, {
      expectedRevision: 2,
      profile: {
        mode: "pinned",
        runtimeId: "codex",
        providerId: "openai",
        modelId: "test-model",
      },
    });
    expect(profile.mode).toBe("pinned");
  });
});
