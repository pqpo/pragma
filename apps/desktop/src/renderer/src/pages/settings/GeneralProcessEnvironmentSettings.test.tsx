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
      visit(node.props.footer as ReactNode);
    }
  };
  visit(GeneralProcessEnvironmentSettings());
  return result;
}

beforeEach(() => hooks.reset());
afterEach(() => vi.unstubAllGlobals());

describe("Runtime process environment settings", () => {
  it("keeps queued toggle and list edits valid after dispatch and saves the final policy", async () => {
    let revision = 0;
    const update = vi.fn(async (input: UpdateRuntimeProcessEnvironmentPolicy) => ({
      ...DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS,
      revision: ++revision,
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

    const settle = async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      hooks.flush();
    };
    const change = (index: number, target: { checked?: boolean; value?: string }) => {
      const event = { currentTarget: target as typeof target | null };
      const onChange = controls()[index]!.onChange as (input: typeof event) => void;
      onChange(event);
      event.currentTarget = null;
      hooks.flush();
    };

    for (const checked of [true, false, true]) {
      change(0, { checked });
      await settle();
      expect(controls()[0]!.checked).toBe(checked);
    }
    const click = (label: string) => {
      const button = controls().find(
        (control) => control.children === label || control["aria-label"] === label,
      )!;
      (button.onClick as () => void)();
      hooks.flush();
    };
    const type = (value: string) => {
      const index = controls().findIndex(
        (control) => control.id === "process-environment-variable",
      );
      change(index, { value });
    };
    const enter = (composing = false, keyCode = 13) => {
      const input = controls().find((control) => control.id === "process-environment-variable")!;
      (input.onKeyDown as (event: unknown) => void)({
        key: "Enter",
        keyCode,
        nativeEvent: { isComposing: composing },
        preventDefault: vi.fn(),
      });
      hooks.flush();
    };
    expect(controls().some((control) => control.id === "process-environment-variable")).toBe(false);
    click("general.processEnvironmentAllowlist · general.processEnvironmentCount");
    type(" MY_TOKEN ");
    enter(true);
    enter(false, 229);
    expect(controls().find((control) => control.id === "process-environment-variable")!.value).toBe(
      " MY_TOKEN ",
    );
    enter();
    type("MY_TOKEN");
    click("general.processEnvironmentAdd");
    expect(
      controls().find((control) => control.id === "process-environment-variable")!["aria-invalid"],
    ).toBe(true);
    type("INVALID=VALUE");
    enter();
    expect(
      controls().find((control) => control.id === "process-environment-variable")!["aria-invalid"],
    ).toBe(true);
    type("CUSTOM_PATH");
    click("general.processEnvironmentAdd");
    type("TEMP_VAR");
    enter();
    const removeButtons = controls().filter(
      (control) => control["aria-label"] === "general.processEnvironmentRemove",
    );
    (removeButtons.at(-1)!.onClick as () => void)();
    hooks.flush();
    expect(update).toHaveBeenCalledTimes(3);
    click("general.processEnvironmentDone");
    await settle();
    expect(update).toHaveBeenCalledTimes(4);
    click("general.processEnvironmentBlocklist · general.processEnvironmentCount");
    type("SECRET_KEY");
    enter();
    click("general.processEnvironmentDone");
    await settle();
    expect(update).toHaveBeenLastCalledWith({
      expectedRevision: 4,
      policy: {
        mode: "inherit-all",
        allowlist: ["MY_TOKEN", "CUSTOM_PATH"],
        blocklist: ["SECRET_KEY"],
      },
    });
    expect(controls().some((control) => control.id === "process-environment-variable")).toBe(false);
    expect(
      controls().some((control) => control.children === "general.processEnvironmentSave"),
    ).toBe(false);

    click("general.processEnvironmentAllowlist · general.processEnvironmentCount");
    type("RETRY_VAR");
    update.mockRejectedValueOnce(new Error("save_failed"));
    click("general.processEnvironmentDone");
    await settle();
    expect(controls().find((control) => control.id === "process-environment-variable")!.value).toBe(
      "RETRY_VAR",
    );
    click("general.processEnvironmentDone");
    await settle();
    expect(update).toHaveBeenLastCalledWith({
      expectedRevision: 5,
      policy: {
        mode: "inherit-all",
        allowlist: ["MY_TOKEN", "CUSTOM_PATH", "RETRY_VAR"],
        blocklist: ["SECRET_KEY"],
      },
    });
    expect(controls().some((control) => control.id === "process-environment-variable")).toBe(false);
  });
});
