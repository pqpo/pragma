import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DesktopRuntimeAvailability } from "../../../../shared/desktop-api.ts";
import { RuntimeEnvironmentDetail } from "./RuntimeEnvironmentDetail.tsx";
import { RuntimeCard } from "./RuntimeEnvironmentsFragment.tsx";

const runtime: DesktopRuntimeAvailability = {
  id: "pragma.runtime.codex",
  revision: 2,
  origin: "built-in",
  adapter: { id: "pragma.runtime.codex", version: "1.0.0" },
  isDefault: true,
  kind: "Codex CLI",
  displayName: "Codex",
  status: "available",
  executablePath: "/usr/local/bin/codex",
  version: "0.42.0",
  models: [
    {
      id: "gpt-5.6-codex",
      displayName: "GPT-5.6 Codex",
      provider: { kind: "runtime-managed", id: "openai", displayName: "OpenAI" },
      default: true,
      thinking: {
        supportedLevels: [
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
        defaultLevel: "medium",
      },
    },
  ],
};

describe("Runtime Environment settings", () => {
  it("keeps model names out of the Runtime directory card", () => {
    const html = renderToStaticMarkup(<RuntimeCard runtime={runtime} onOpen={() => undefined} />);

    expect(html).toContain("1 model");
    expect(html).toContain("View details");
    expect(html).not.toContain("GPT-5.6 Codex");
    expect(html).not.toContain("gpt-5.6-codex");
  });

  it("shows Runtime identity and its complete model catalog on the detail page", () => {
    const html = renderToStaticMarkup(
      <RuntimeEnvironmentDetail
        runtime={runtime}
        refreshing={false}
        error={null}
        onBack={() => undefined}
        onRefresh={() => undefined}
      />,
    );

    expect(html).toContain("Back to Runtime Environments");
    expect(html).toContain("pragma.runtime.codex");
    expect(html).toContain("/usr/local/bin/codex");
    expect(html).toContain("GPT-5.6 Codex");
    expect(html).toContain("gpt-5.6-codex");
    expect(html).toContain("Medium, High");
  });
});
