import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PRAGMA_TEXT_LIMITS } from "@pragma/shared";

import type {
  AutomationSummary,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { workspaceSelectionFromPath } from "../../components/WorkspacePicker.tsx";
import {
  AutomationDirectoryFragment,
  createNewAutomationEditor,
  resolveAutomationExecutorName,
  scheduleTrigger,
  validateAutomationEditor,
} from "./AutomationDirectoryFragment.tsx";
import { AutomationDetailFragment } from "./AutomationDetailFragment.tsx";

const automation: AutomationSummary = {
  ref: "automation:hrxn3mv2e991j2rj",
  resource: {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Automation",
    metadata: {
      id: "hrxn3mv2e991j2rj",
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
        executor: { ref: "expert:3sfd30h5017wd17d" },
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
  it("starts a new Automation without preselecting an executor", () => {
    const editor = createNewAutomationEditor(
      "daily_review",
      {
        workspace: { path: "/work/review", basename: "review" },
        recentWorkspaces: [],
        executorRef: "expert:3sfd30h5017wd17d",
        toolPermissionMode: "request-approval",
      },
      Date.parse("2026-07-24T08:00:00.000Z"),
    );

    expect(editor).toMatchObject({
      id: "daily_review",
      executorRef: "",
      prompt: "",
      flowInput: {},
      workspace: "/work/review",
      toolPermissionMode: "request-approval",
    });
    expect(validateAutomationEditor(editor, undefined)).toMatchObject({
      valid: false,
      executor: "required",
      prompt: undefined,
    });
  });

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
    expect(html).toContain("Loading…");
    expect(html).not.toContain("expert:3sfd30h5017wd17d");
  });

  it("resolves an Automation executor ref to its user-facing name", () => {
    expect(
      resolveAutomationExecutorName("expert:3sfd30h5017wd17d", [
        {
          kind: "expert",
          avatarId: "pragma.avatar.expert.default",
          ref: "expert:3sfd30h5017wd17d",
          name: "Reviewer",
          description: "Reviews work",
          origin: "project",
          readOnly: false,
          customized: false,
        },
      ]),
    ).toBe("Reviewer");
    expect(resolveAutomationExecutorName("team:ma2zkzkd0vss030m", [])).toBeUndefined();
  });

  it("presents a read-only Automation detail before editing", () => {
    const html = renderToStaticMarkup(
      <AutomationDetailFragment
        automation={automation}
        executors={[
          {
            kind: "expert",
            avatarId: "pragma.avatar.expert.default",
            ref: "expert:3sfd30h5017wd17d",
            name: "Reviewer",
            description: "Reviews work",
            origin: "project",
            readOnly: false,
            customized: false,
          },
        ]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onRun={async () => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain("Daily review");
    expect(html).toContain("Automation overview");
    expect(html).toContain("Reviewer");
    expect(html).toContain("Review the work.");
    expect(html).toContain("Run now");
    expect(html).toContain("Edit automation");
    expect(html).toContain('class="automation-detail-column"');
  });

  it("renders an unavailable adapter without crashing or offering the schedule editor", () => {
    const unsupported: AutomationSummary = {
      ...automation,
      resource: {
        ...automation.resource,
        spec: {
          ...automation.resource.spec,
          adapter: "example.automation.webhook@v1",
          config: { endpoint: "connection:webhook" },
        },
      },
      status: "needs_attention",
      nextRunAt: undefined,
      diagnostic: "Adapter is not installed: example.automation.webhook@v1.",
    };

    const html = renderToStaticMarkup(
      <AutomationDetailFragment
        automation={unsupported}
        executors={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onRun={async () => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain("Connection configuration");
    expect(html).toContain("example.automation.webhook@v1");
    expect(html).toContain("connection:webhook");
    expect(html).not.toContain("Edit automation");
  });

  it("validates and normalizes weekly schedule fields before calling Desktop APIs", () => {
    const editor = {
      originalRef: undefined,
      id: "weekly_review",
      version: "1.0.0",
      name: "Weekly review",
      description: "Runs a weekly review",
      enabled: true,
      executorRef: "expert:3sfd30h5017wd17d",
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
      executorRef: "expert:3sfd30h5017wd17d",
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
      avatarId: "pragma.avatar.expert.default",
      ref: "expert:3sfd30h5017wd17d",
      name: "Reviewer",
      version: "1.0.0",
      description: "Reviews work",
      origin: "project" as const,
      readOnly: false,
      customized: false,
    };

    expect(validateAutomationEditor(editor, executor)).toMatchObject({ valid: true });
    expect(validateAutomationEditor({ ...editor, description: "" }, executor)).toMatchObject({
      valid: false,
      description: "required",
    });
    expect(validateAutomationEditor({ ...editor, time: "" }, executor)).toMatchObject({
      valid: false,
      trigger: "invalid",
    });
    expect(
      validateAutomationEditor(
        { ...editor, prompt: "p".repeat(PRAGMA_TEXT_LIMITS.automation.promptAuthoring + 1) },
        executor,
      ),
    ).toMatchObject({ valid: false, prompt: "tooLong" });
  });

  it("validates structured Flow input without requiring a prompt", () => {
    const editor = {
      ...createNewAutomationEditor("flow_review", {
        workspace: { path: "/work/review", basename: "review" },
        recentWorkspaces: [],
        executorRef: "expert:3sfd30h5017wd17d",
        toolPermissionMode: "request-approval" as const,
      }),
      name: "Flow review",
      description: "Runs the review Flow",
      executorRef: "flow:3sfd30h5017wd17d",
      flowInput: { issue_id: "123" },
    };
    const executor = {
      kind: "flow" as const,
      ref: "flow:3sfd30h5017wd17d",
      name: "Issue review",
      description: "Reviews an issue",
      origin: "project" as const,
      readOnly: false,
      customized: false,
      inputSchema: {
        type: "object" as const,
        properties: { issue_id: { type: "string" as const } },
        required: ["issue_id"],
        additionalProperties: false as const,
      },
    };

    expect(validateAutomationEditor(editor, executor)).toMatchObject({
      valid: true,
      prompt: undefined,
      flowInput: undefined,
    });
    expect(
      validateAutomationEditor({ ...editor, flowInput: { issue_id: "" } }, executor),
    ).toMatchObject({ valid: true });
    expect(validateAutomationEditor({ ...editor, flowInput: {} }, executor)).toMatchObject({
      valid: false,
      flowInput: "invalid",
    });
  });
});
