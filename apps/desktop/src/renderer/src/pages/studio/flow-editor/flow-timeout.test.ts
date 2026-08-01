import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  FlowTimeoutField,
  flowTimeoutMilliseconds,
  flowTimeoutUnit,
  flowTimeoutValue,
} from "./flow-timeout.tsx";

describe("flow-timeout", () => {
  it("edits Flow timeouts in human-scale units while preserving milliseconds in the DSL", () => {
    expect(flowTimeoutUnit(undefined)).toBe("hours");
    expect(flowTimeoutUnit(90_000)).toBe("seconds");
    expect(flowTimeoutUnit(120_000)).toBe("minutes");
    expect(flowTimeoutUnit(7_200_000)).toBe("hours");
    expect(flowTimeoutUnit(172_800_000)).toBe("days");

    expect(flowTimeoutValue(7_200_000, "hours")).toBe(2);
    expect(flowTimeoutMilliseconds(30, "seconds")).toBe(30_000);
    expect(flowTimeoutMilliseconds(15, "minutes")).toBe(900_000);
    expect(flowTimeoutMilliseconds(2, "hours")).toBe(7_200_000);
    expect(flowTimeoutMilliseconds(3, "days")).toBe(259_200_000);
    expect(flowTimeoutMilliseconds(0, "seconds")).toBeUndefined();

    const unlimitedHtml = renderToStaticMarkup(
      createElement(FlowTimeoutField, {
        timeoutMs: undefined,
        onChange: () => undefined,
      }),
    );
    expect(unlimitedHtml).toContain("Never expires");
    expect(unlimitedHtml).toContain('type="checkbox" checked=""');
    expect(unlimitedHtml).not.toContain("Timeout (ms)");

    const finiteHtml = renderToStaticMarkup(
      createElement(FlowTimeoutField, {
        timeoutMs: 7_200_000,
        onChange: () => undefined,
      }),
    );
    expect(finiteHtml).toContain('value="2"');
    expect(finiteHtml).toContain('aria-label="Timeout unit"');
    expect(finiteHtml).toContain('aria-selected="true"');
    expect(finiteHtml).toContain("Hours");
    expect(finiteHtml).not.toContain("<select");
  });
});
