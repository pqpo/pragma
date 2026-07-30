import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../i18n/index.ts";
import { DesktopErrorBoundary, DesktopFatalError } from "./DesktopFatalError.tsx";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

describe("DesktopFatalError", () => {
  it("renders an actionable bridge failure instead of a blank screen", () => {
    const html = renderToStaticMarkup(
      <DesktopFatalError code="DESKTOP_BRIDGE_UNAVAILABLE" onReload={() => undefined} />,
    );

    expect(html).toContain('role="alert"');
    expect(html).toContain("The Desktop bridge could not be loaded");
    expect(html).toContain("Diagnostic code: DESKTOP_BRIDGE_UNAVAILABLE");
    expect(html).toContain("Reload Pragma");
  });

  it("renders startup failures in Simplified Chinese", async () => {
    await i18n.changeLanguage("zh-Hans");

    const html = renderToStaticMarkup(
      <DesktopFatalError code="RENDERER_STARTUP_FAILURE" onReload={() => undefined} />,
    );

    expect(html).toContain("Pragma 未能完成启动");
    expect(html).toContain("诊断代码：RENDERER_STARTUP_FAILURE");
  });

  it("explains that mismatched Desktop components must be reloaded", () => {
    const html = renderToStaticMarkup(
      <DesktopFatalError code="DESKTOP_COMPONENT_VERSION_MISMATCH" onReload={() => undefined} />,
    );

    expect(html).toContain("Pragma components are out of sync");
    expect(html).toContain("Diagnostic code: DESKTOP_COMPONENT_VERSION_MISMATCH");
  });
});

describe("DesktopErrorBoundary", () => {
  it("switches to its fatal fallback after a renderer exception", () => {
    expect(DesktopErrorBoundary.getDerivedStateFromError()).toEqual({ failed: true });
  });
});
