import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS,
  type UpdateRuntimeProcessEnvironmentPolicy,
} from "@pragma/shared";

import { GeneralProcessEnvironmentSettings } from "./GeneralProcessEnvironmentSettings.tsx";

// Queue state updates until after dispatch, when React has cleared currentTarget.
const hooks = vi.hoisted(() => {
  const states: unknown[] = [];
  const pending: Array<() => void> = [];
  let cursor = 0;
  let effect: (() => void) | undefined;
  return {
    reset() {
      states.length = 0;
      pending.length = 0;
      cursor = 0;
      effect = undefined;
    },
    begin() {
      cursor = 0;
    },
    commit() {
      effect?.();
      effect = undefined;
    },
    flush() {
      pending.splice(0).forEach((update) => update());
    },
    useEffect(callback: () => void) {
      effect = callback;
    },
    useState<T>(initial: T) {
      const index = cursor++;
      if (states.length <= index) states[index] = initial;
      return [
        states[index] as T,
        (next: T | ((current: T) => T)) => {
          pending.push(() => {
            states[index] =
              typeof next === "function" ? (next as (current: T) => T)(states[index] as T) : next;
          });
        },
      ] as const;
    },
  };
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useEffect: hooks.useEffect,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function controls() {
  hooks.begin();
  const result: Array<Record<string, unknown>> = [];
  const visit = (node: ReactNode) => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (isValidElement<Record<string, unknown>>(node)) {
      if (["input", "textarea", "button"].includes(String(node.type))) result.push(node.props);
      visit(node.props.children as ReactNode);
    }
  };
  visit(GeneralProcessEnvironmentSettings());
  return result;
}

beforeEach(() => hooks.reset());
afterEach(() => vi.unstubAllGlobals());

describe("Runtime process environment settings", () => {
  it("keeps queued toggle and list edits valid after dispatch and saves the final policy", async () => {
    const update = vi.fn(async (input: UpdateRuntimeProcessEnvironmentPolicy) => ({
      ...DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS,
      revision: 1,
      policy: input.policy,
    }));
    vi.stubGlobal("window", {
      pragmaDesktop: {
        getRuntimeProcessEnvironmentSettings: async () =>
          DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS,
        updateRuntimeProcessEnvironmentPolicy: update,
      },
    });
    controls();
    hooks.commit();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    hooks.flush();

    const change = (index: number, target: { checked?: boolean; value?: string }) => {
      const event = { currentTarget: target as typeof target | null };
      const onChange = controls()[index]!.onChange as (input: typeof event) => void;
      onChange(event);
      event.currentTarget = null;
      hooks.flush();
    };

    for (const checked of [true, false, true]) {
      change(0, { checked });
      expect(controls()[0]!.checked).toBe(checked);
    }
    change(1, { value: " MY_TOKEN \r\n\nCUSTOM_PATH\n" });
    change(2, { value: "SECRET_KEY\n" });
    expect(controls()[1]!.value).toBe("MY_TOKEN\nCUSTOM_PATH");
    expect(controls()[2]!.value).toBe("SECRET_KEY");
    const save = controls()[3]!;
    expect(save.disabled).toBe(false);
    await (save.onClick as () => Promise<void>)();
    expect(update).toHaveBeenCalledExactlyOnceWith({
      expectedRevision: 0,
      policy: {
        mode: "inherit-all",
        allowlist: ["MY_TOKEN", "CUSTOM_PATH"],
        blocklist: ["SECRET_KEY"],
      },
    });
  });
});
