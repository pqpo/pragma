import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import { SettingsPage } from "./SettingsPage.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("SettingsPage", () => {
  it("uses a fixed navigation and content frame without a redundant page title", () => {
    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain('class="settings-navigation"');
    expect(html).toContain('class="settings-content"');
    expect(html).toContain('class="settings-screen-header"');
    expect(html).toContain('class="settings-screen-body"');
    expect(html).toContain("General");
    expect(html).toContain("Language");
    expect(html).toContain("Default workspace");
    expect(html).toContain("Tool permissions");
    expect(html).toContain("Request approval");
    expect(html).toContain("Approve for me");
    expect(html).toContain("Full access");
    expect(html).not.toContain("Task workspace");
    expect(html).not.toContain("<h1>Settings</h1>");
  });

  it("renders General settings in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");

    const html = renderToStaticMarkup(<SettingsPage />);

    expect(html).toContain("常规");
    expect(html).toContain("语言");
    expect(html).toContain("默认工作区");
    expect(html).toContain("工具权限");
    expect(html).toContain("替我审批");
    expect(html).toContain("跟随系统");
    expect(html).toContain("繁體中文");
  });

  it("opens a requested settings section from an application deep link", () => {
    const html = renderToStaticMarkup(<SettingsPage initialView="runtimes" />);

    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Runtime Environments");
    expect(html).toContain("Checking runtime availability");
  });

  it("exposes the built-in memory plane as a first-class settings section", () => {
    const html = renderToStaticMarkup(<SettingsPage initialView="memory" />);

    expect(html).toContain('id="memory-panel"');
    expect(html).toContain("Control the built-in memory plane");
    expect(html).toContain("Capture");
    expect(html).toContain("Recall");
    expect(html).toContain("Learning");
    expect(html).toContain("Memory plane health");
  });
});
