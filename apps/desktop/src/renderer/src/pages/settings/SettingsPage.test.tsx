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
    expect(html).toContain('aria-label="Resize navigation"');
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
    expect(html).toContain("Skill Revision Agent");
    expect(html).toContain("Skill Evaluation Agent");
    expect(html).toContain("Inherit system default");
    expect(html).not.toContain("Default Runtime");
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
    expect(html).toContain("技能修订 Agent");
    expect(html).toContain("技能评测 Agent");
    expect(html).toContain("继承系统默认");
    expect(html).toContain("跟随系统");
    expect(html).toContain("繁體中文");
    expect(html).not.toContain("默认 Runtime");
  });

  it("opens a requested settings section from an application deep link", () => {
    const html = renderToStaticMarkup(<SettingsPage initialView="runtimes" />);

    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("Runtime Environments");
    expect(html).toContain("Built-in Runtime");
    expect(html).toContain("Antigravity CLI");
  });

  it("keeps Agent Judge model and queue concurrency in a dedicated evaluation section", () => {
    const html = renderToStaticMarkup(<SettingsPage initialView="evaluations" />);

    expect(html).toContain('id="evaluations-panel"');
    expect(html).toContain("Judge model");
    expect(html).toContain("Global concurrency");
    expect(html).toContain("How a concurrency slot is counted");
  });

  it("exposes the built-in memory plane as a first-class settings section", () => {
    const html = renderToStaticMarkup(<SettingsPage initialView="memory" />);

    expect(html).toContain('id="memory-panel"');
    expect(html).toContain("Control the built-in memory plane");
    expect(html).toContain("Memory feature");
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).not.toContain("Capture");
    expect(html).not.toContain("Recall");
    expect(html).not.toContain("Learning");
    expect(html).not.toContain("Allow tool-assisted extraction: Episodic Memory");
    expect(html).not.toContain("Allow tool-assisted extraction: Fact Memory");
    expect(html).not.toContain("Memory plane health");
    expect(html).not.toContain("Storage governance");
    expect(html).toContain('<div class="setting-row general-language-setting">');
    expect(html).not.toContain('<label class="setting-row general-language-setting">');
  });
});
