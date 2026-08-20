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
  kind: "codex-local",
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
    {
      id: "gpt-5.5-codex-mini",
      displayName: "GPT-5.5 Codex Mini",
      provider: { kind: "runtime-managed", id: "openai", displayName: "OpenAI" },
    },
  ],
};

describe("Runtime Environment settings", () => {
  it("summarizes the model count in the Runtime directory card without listing models", () => {
    const html = renderToStaticMarkup(<RuntimeCard runtime={runtime} onOpen={() => undefined} />);

    expect(html).toContain('class="runtime-summary-models"');
    expect(html).toContain("2 models");
    expect(html).not.toContain("GPT-5.6 Codex");
    expect(html).not.toContain("GPT-5.5 Codex Mini");
    expect(html).not.toContain("codex-local");
    expect(html).not.toContain("built-in");
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
    expect(html).toContain("Default only");
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

  it("renders probing state in badge area when isProbing is true and badge button when false", () => {
    const probingHtml = renderToStaticMarkup(
      <RuntimeCard runtime={runtime} isProbing={true} onOpen={() => undefined} />,
    );
    expect(probingHtml).toContain('class="status-badge is-probing"');
    expect(probingHtml).toContain('class="status-dot runtime-spin"');

    const readyHtml = renderToStaticMarkup(
      <RuntimeCard runtime={runtime} isProbing={false} onOpen={() => undefined} />,
    );
    expect(readyHtml).toContain('class="status-badge-button is-ready"');
    expect(readyHtml).toContain('class="badge-hover-action"');
  });
});
