import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { App } from "./App.tsx";
import { i18n } from "./i18n/index.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("App", () => {
  it("renders the mission creation Home by default", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Start a mission");
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
    expect(html).toContain("Settings");
  });

  it("keeps every application navigation destination enabled", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain("Missions");
    expect(html).toContain("Studio");
    expect(html).not.toContain("Inbox");
    expect(html).not.toContain("Alex Chen");
    expect(html).not.toContain('class="navigation-item" type="button" disabled');
  });

  it("keeps the accessible sidebar collapse control in a compact footer", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('aria-label="Collapse navigation"');
    expect(html).toContain('class="sidebar-footer"');
    expect(html.indexOf('class="sidebar-footer"')).toBeGreaterThan(
      html.indexOf('aria-label="Main navigation"'),
    );
  });

  it("provides a frameless window drag region above the application shell", () => {
    const html = renderToStaticMarkup(<App />);

    expect(html).toContain('class="window-drag-region"');
  });
});
