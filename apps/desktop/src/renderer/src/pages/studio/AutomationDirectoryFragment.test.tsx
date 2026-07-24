import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { AutomationSummary, PragmaProjectSnapshot } from "../../../../shared/desktop-api.ts";
import { workspaceSelectionFromPath } from "../../components/WorkspacePicker.tsx";
import {
  AutomationDirectoryFragment,
  scheduleTrigger,
  validateAutomationEditor,
} from "./AutomationDirectoryFragment.tsx";

const automation: AutomationSummary = {
  ref: "automation:daily_review@1.0.0",
  resource: {
    apiVersion: "pragma/v2",
    kind: "Automation",
    metadata: {
      id: "daily_review",
      version: "1.0.0",
      name: "Daily review",
      description: "Reviews work every day",
      tags: [],
    },
    spec: {
      adapter: "pragma.automation.schedule@v1",
      binding: "binding:desktop-automation",
      config: {
        trigger: {
          kind: "calendar",
          frequency: "daily",
          time: "09:00",
          timezone: "UTC",
        },
      },
      enabled: true,
      route: {
        executor: { ref: "expert:reviewer@1.0.0" },
        input: { kind: "prompt", value: "Review the work." },
      },
      interaction: { mode: "reuse-session" },
      delivery: { adapter: "pragma.automation.delivery.local@v1" },
    },
  },
  status: "scheduled",
  nextRunAt: "2026-07-24T09:00:00.000Z",
  queueDepth: 0,
};

describe("AutomationDirectoryFragment", () => {
  it("presents Automations and Connections as one extensible Integrations surface", () => {
    const html = renderToStaticMarkup(
      <AutomationDirectoryFragment
        automations={[automation]}
        project={{ revision: 3 } as PragmaProjectSnapshot}
        onChanged={async () => undefined}
      />,
    );

    expect(html).toContain("Integrations");
    expect(html).toContain("Automations");
    expect(html).toContain("Connections");
    expect(html).toContain("Daily review");
    expect(html).toContain("expert:reviewer@1.0.0");
  });

  it("validates and normalizes weekly schedule fields before calling Desktop APIs", () => {
    const editor = {
      originalRef: undefined,
      id: "weekly_review",
      version: "1.0.0",
      name: "Weekly review",
      description: "Runs a weekly review",
      enabled: true,
      executorRef: "expert:reviewer@1.0.0",
      prompt: "Review the work.",
      flowInput: {},
      interaction: "reuse-session" as const,
      workspace: "/work/review",
      toolPermissionMode: "request-approval" as const,
      triggerKind: "calendar" as const,
      onceAt: "2026-07-24T09:00",
      intervalEvery: 1,
      intervalUnit: "hours" as const,
      anchorAt: "2026-07-24T09:00",
      frequency: "weekly" as const,
      time: "09:00",
      weekdays: ["mon", "fri"] as const,
      dayOfMonth: 1,
      cron: "0 9 * * *",
      startsAt: "",
      endsAt: "",
    };

    expect(scheduleTrigger(editor, "Asia/Shanghai")).toMatchObject({
      weekdays: ["mon", "fri"],
      timezone: "Asia/Shanghai",
    });
    expect(() => scheduleTrigger({ ...editor, weekdays: [] }, "UTC")).toThrow(/^weekdays:/);
    expect(() => scheduleTrigger({ ...editor, time: "" }, "UTC")).toThrow(/^time:/);
    expect(() =>
      scheduleTrigger({ ...editor, frequency: "monthly", dayOfMonth: 0 }, "UTC"),
    ).toThrow(/^dayOfMonth:/);
  });

  it("resolves saved Automation paths to the shared workspace picker model", () => {
    const recent = { path: "/work/review", basename: "review" };

    expect(workspaceSelectionFromPath(recent.path, [recent])).toBe(recent);
    expect(workspaceSelectionFromPath("C:\\work\\reports")).toEqual({
      path: "C:\\work\\reports",
      basename: "reports",
    });
    expect(workspaceSelectionFromPath("")).toBeUndefined();
  });

  it("blocks invalid resource fields and invalid schedules before save", () => {
    const editor = {
      originalRef: undefined,
      id: "daily_review",
      version: "1.0.0",
      name: "Daily review",
      description: "Reviews the current work",
      enabled: true,
      executorRef: "expert:reviewer@1.0.0",
      prompt: "Review the work.",
      flowInput: {},
      interaction: "reuse-session" as const,
      workspace: "/work/review",
      toolPermissionMode: "request-approval" as const,
      triggerKind: "calendar" as const,
      onceAt: "2026-07-24T09:00",
      intervalEvery: 1,
      intervalUnit: "hours" as const,
      anchorAt: "2026-07-24T09:00",
      frequency: "daily" as const,
      time: "09:00",
      weekdays: ["mon"] as const,
      dayOfMonth: 1,
      cron: "0 9 * * *",
      startsAt: "",
      endsAt: "",
    };
    const executor = {
      kind: "expert" as const,
      ref: "expert:reviewer@1.0.0",
      name: "Reviewer",
      version: "1.0.0",
      description: "Reviews work",
      origin: "project" as const,
      readOnly: false,
      customized: false,
    };

    expect(validateAutomationEditor(editor, executor)).toMatchObject({ valid: true });
    expect(validateAutomationEditor({ ...editor, id: "bad-id" }, executor)).toMatchObject({
      valid: false,
      id: "idFormat",
    });
    expect(validateAutomationEditor({ ...editor, description: "" }, executor)).toMatchObject({
      valid: false,
      description: "required",
    });
    expect(validateAutomationEditor({ ...editor, time: "" }, executor)).toMatchObject({
      valid: false,
      trigger: "invalid",
    });
  });
});
