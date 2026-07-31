import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { hasRuntimeBrandLogo, RuntimeLogo } from "./RuntimeLogo.tsx";

describe("RuntimeLogo", () => {
  it.each([
    { id: "pi", kind: "cloud-pi-agent" },
    { id: "codex", kind: "codex-local" },
    { id: "claude-code", kind: "claude-code-local" },
    { id: "qodercli", kind: "qodercli-local" },
  ])("uses an available brand asset for $id", (runtime) => {
    const html = renderToStaticMarkup(<RuntimeLogo runtime={runtime} />);

    expect(hasRuntimeBrandLogo(runtime)).toBe(true);
    expect(html).toContain("<img");
    expect(html).not.toContain("<svg");
  });

  it("uses the terminal fallback for an unknown Runtime", () => {
    const runtime = { id: "custom", kind: "custom" };
    const html = renderToStaticMarkup(<RuntimeLogo runtime={runtime} />);

    expect(hasRuntimeBrandLogo(runtime)).toBe(false);
    expect(html).toContain("<svg");
    expect(html).not.toContain("<img");
  });

  it("recognizes the adapter behind a custom Runtime Environment id", () => {
    const runtime = {
      id: "team-codex",
      kind: "custom",
      adapter: { id: "pragma.runtime.codex", version: "v1" },
    };

    expect(hasRuntimeBrandLogo(runtime)).toBe(true);
    expect(renderToStaticMarkup(<RuntimeLogo runtime={runtime} />)).toContain("<img");
  });
});
