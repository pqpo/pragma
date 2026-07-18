import { User } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ExpertDetailFragment } from "./ExpertDirectoryFragment.tsx";
import type { ExpertRecord } from "./studio-model.ts";

const expert: ExpertRecord = {
  id: "test_expert",
  name: "Test Expert",
  description: "d".repeat(240),
  tags: ["test"],
  version: "0.1.0",
  scope: "Handles focused test work.",
  instructions: "i".repeat(500),
  model: null,
  capabilities: [],
  skills: 0,
  tools: 0,
  mcpServers: 0,
  contextStoreMounts: [],
  resourceTools: [],
  plugins: [],
  usesApproval: false,
  icon: User,
};

describe("ExpertDetailFragment", () => {
  it("uses compact metadata and bounded content previews", () => {
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={expert}
        contextStores={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onConfigureContext={() => undefined}
        onTryInSession={() => undefined}
      />,
    );

    expect(html).toContain("ID: test_expert");
    expect(html).toContain("Scope");
    expect(html).not.toContain("Availability");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show more");
    expect(html).not.toContain("d".repeat(201));
    expect(html).not.toContain("i".repeat(421));
    expect(html).toMatch(/studio-screen-header.*Back to Experts.*studio-screen-body.*Test Expert/s);
  });
});
