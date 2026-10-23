import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { i18n } from "../i18n/index.ts";
import { WorkspacePicker } from "./WorkspacePicker.tsx";

const defaultWorkspace = { path: "/pragma/workspace", basename: "workspace" };
const props = {
  defaultWorkspace,
  recentWorkspaces: [],
  defaultSelected: false,
  onChoose: () => {},
  onSelect: () => {},
  onUseDefault: () => {},
};

afterEach(async () => {
  await i18n.changeLanguage("en");
});

it.each([
  ["en", "Default workspace", "Use default workspace"],
  ["zh-Hans", "默认工作区", "使用默认工作区"],
  ["zh-Hant", "預設工作區", "使用預設工作區"],
])("names a restored default selection by its path in %s", async (locale, label, action) => {
  await i18n.changeLanguage(locale);
  const html = renderToStaticMarkup(
    <WorkspacePicker {...props} selection={{ ...defaultWorkspace }} />,
  );
  expect(html).toContain(`<strong>${label}</strong>`);
  expect(html).not.toContain(action);
  expect(html).toContain(defaultWorkspace.path);
});

it("keeps an ordinary workspace's name even when its basename is workspace", () => {
  const html = renderToStaticMarkup(
    <WorkspacePicker {...props} selection={{ path: "/other/workspace", basename: "workspace" }} />,
  );
  expect(html).toContain("<strong>workspace</strong>");
  expect(html).not.toContain("Default workspace");
});

it("names an implicit default selection without the action wording", () => {
  const html = renderToStaticMarkup(<WorkspacePicker {...props} defaultSelected />);
  expect(html).toContain("<strong>Default workspace</strong>");
  expect(html).not.toContain("Use default workspace");
});

it("preserves the unselected state for project creation", () => {
  const html = renderToStaticMarkup(<WorkspacePicker {...props} unselected />);
  expect(html).toContain("<strong>Mission workspace</strong>");
  expect(html).not.toContain("Default workspace");
});
