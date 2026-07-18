import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Capability } from "../../../../shared/desktop-api.ts";
import {
  CapabilityDetailFragment,
  parseTestInput,
  skillMarkdownBody,
} from "./CapabilityDetailFragment.tsx";

const capability: Capability = {
  manifest: {
    schemaVersion: "pragma.capability/v1",
    id: "00000000-0000-4000-8000-000000000000",
    runtimeKey: "customer_api_00000000",
    name: "Customer API",
    kind: "http_service",
    latestRevision: 2,
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  },
  health: {
    revision: 2,
    status: "ready",
    checkedAt: "2026-07-11T00:00:00.000Z",
  },
  definition: {
    kind: "http_service",
    name: "Customer API",
    description: "Customer records.",
    baseUrl: "https://api.example.test/v1",
    auth: { type: "bearer", credentialRef: "service-auth" },
    timeoutMs: 30_000,
    tools: [
      {
        name: "get_customer",
        description: "Get a customer.",
        method: "GET",
        path: "/customers/{id}",
        parameters: [{ name: "id", location: "path", required: true, type: "string" }],
      },
    ],
  },
};

describe("CapabilityDetailFragment", () => {
  it("shows capability metadata, tool details, and a JSON test panel", () => {
    const html = renderToStaticMarkup(
      <CapabilityDetailFragment
        capability={capability}
        onBack={() => undefined}
        onChanged={() => undefined}
      />,
    );

    expect(html).toContain("Back to Capabilities");
    expect(html).toContain("Revision 2");
    expect(html).toContain("get_customer");
    expect(html).toContain("/customers/{id}");
    expect(html).toContain("JSON input");
    expect(html).toContain("Run test");
    expect(html).not.toContain("service-auth");
    expect(html).toMatch(
      /studio-screen-header.*Back to Capabilities.*studio-screen-body.*Customer API/s,
    );
  });

  it("strips Skill frontmatter only from the rendered Markdown body", () => {
    const source = "---\nname: review\ndescription: Review code.\n---\n\n# Review\n\nRun tests.";

    expect(skillMarkdownBody(source)).toBe("# Review\n\nRun tests.");
  });

  it("requires test input to be a JSON object", () => {
    expect(parseTestInput('{"value":42}')).toEqual({ value: 42 });
    expect(() => parseTestInput("[]")).toThrow("Test input must be a JSON object.");
  });
});
