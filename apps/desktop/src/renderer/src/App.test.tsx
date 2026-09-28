import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import {
  App,
  AssetGitIssueNotice,
  CoreSyncCutoverNotice,
  shouldShowCoreSyncCutoverNotice,
  updateAssetGitIssues,
} from "./App.tsx";
import { i18n } from "./i18n/index.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("App", () => {
  it("renders the mission creation Home by default", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('aria-label="Start mission"');
    expect(html).toContain("What can I help you with?");
    expect(html).toContain('aria-label="Mission options"');
    expect(html).toContain('aria-label="Tool permissions"');
    expect(html).not.toContain("PRAGMA STEWARD");
    expect(html).toContain("Studio");
  });

  it("renders the mission creation Home in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");

    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("开始任务");
    expect(html).toContain("可以让我帮你做什么呢？");
    expect(html).toContain('aria-label="任务选项"');
    expect(html).toContain('aria-label="工具权限"');
  });

  it("offers every available application destination", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Home");
    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html).toContain("Evaluations");
    expect(html).toContain("Usage");
    expect(html).toContain("Settings");
  });

  it("keeps application navigation in the required product order", () => {
    const html = renderToStaticMarkup(<App />);
    const labels = ["Home", "Missions", "Studio", "Evaluations", "Usage", "Settings"];
    const positions = labels.map((label) => html.indexOf(`aria-label="${label}"`));

    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((left, right) => left - right));
  });

  it("keeps every application navigation destination enabled", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html).toContain("Evaluations");
    expect(html).toContain("Usage");
    expect(html).not.toContain("Inbox");
    expect(html).not.toContain("Alex Chen");
    expect(html).not.toContain('class="navigation-item" type="button" disabled');
  });

  it("keeps the accessible sidebar collapse control in a compact footer", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('aria-label="Collapse navigation"');
    expect(html).toContain('aria-label="Resize navigation"');
    expect(html).toContain('role="separator"');
    expect(html).toContain('class="sidebar-footer"');
    expect(html.indexOf('class="sidebar-footer"')).toBeGreaterThan(
      html.indexOf('aria-label="Main navigation"'),
    );
  });

  it("provides a frameless window drag region above the application shell", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('class="window-drag-region"');
  });

  it("uses the Pragma image for the sidebar avatar", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('class="brand-mark"');
    expect(html).toContain('src="/src/renderer/src/assets/pragma-icon.png"');
    expect(html).not.toContain(">P</span>");
  });

  it("renders a styled and dismissible legacy sync notice", async () => {
    await i18n.changeLanguage("zh-Hans");

    const html = renderToStaticMarkup(
      <CoreSyncCutoverNotice onConfigure={() => undefined} onDismiss={() => undefined} />,
    );

    expect(html).toContain('class="primary-button"');
    expect(html).toContain(">配置</button>");
    expect(html).toContain('class="icon-button core-sync-cutover-dismiss"');
    expect(html).toContain('aria-label="关闭同步提示"');
    expect(html).not.toContain("配置核心资产同步");
  });

  it("temporarily hides the legacy sync notice without changing its source status", () => {
    expect(shouldShowCoreSyncCutoverNotice(true, false)).toBe(true);
    expect(shouldShowCoreSyncCutoverNotice(true, true)).toBe(false);
    expect(shouldShowCoreSyncCutoverNotice(false, false)).toBe(false);
  });

  it("keeps unresolved Asset Git failures visible until their target recovers", () => {
    const target = { kind: "knowledge" as const, id: "00000000-0000-4000-8000-000000000001" };
    const conflict = { target, status: "conflict" as const, conflictPaths: ["guide.md"] };
    const failed = { target, status: "error" as const, error: "fetch failed" };

    expect(updateAssetGitIssues([], conflict)).toEqual([conflict]);
    expect(updateAssetGitIssues([conflict], failed)).toEqual([failed]);
    expect(updateAssetGitIssues([failed], { target, status: "synced" })).toEqual([]);
  });

  it("renders an actionable and dismissible Asset Git issue notice", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(
      <AssetGitIssueNotice
        status={{
          target: { kind: "knowledge", id: "00000000-0000-4000-8000-000000000001" },
          status: "conflict",
          conflictPaths: ["guide.md"],
        }}
        additionalCount={2}
        onOpen={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(html).toContain('class="asset-git-issue-notice"');
    expect(html).toContain("知识库 Git 同步发现冲突，需要处理。");
    expect(html).toContain("另有 2 个资产需要处理。");
    expect(html).toContain(">打开 Git 设置</button>");
    expect(html).toContain('aria-label="关闭 Git 同步提示"');
  });
});
