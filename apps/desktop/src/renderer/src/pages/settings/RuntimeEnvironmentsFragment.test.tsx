import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { DesktopRuntimeAvailability } from "../../../../shared/contracts/index.ts";
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

  it("does not expose implementation identity for the built-in Runtime", () => {
    const builtInRuntime: DesktopRuntimeAvailability = {
      ...runtime,
      id: "pi",
      adapter: { id: "pragma.runtime.pi", version: "v1" },
      kind: "cloud-pi-agent",
      displayName: "PI Runtime",
    };
    const html = [
      renderToStaticMarkup(<RuntimeCard runtime={builtInRuntime} onOpen={() => undefined} />),
      renderToStaticMarkup(
        <RuntimeEnvironmentDetail
          runtime={builtInRuntime}
          refreshing={false}
          error={null}
          onBack={() => undefined}
          onRefresh={() => undefined}
        />,
      ),
    ].join("");

    expect(html).toContain("Built-in Runtime");
    expect(html).not.toContain("PI Runtime");
    expect(html).not.toContain("cloud-pi-agent");
    expect(html).not.toContain("pragma.runtime.pi");
    expect(html).not.toMatch(/>pi</u);
  });
});
