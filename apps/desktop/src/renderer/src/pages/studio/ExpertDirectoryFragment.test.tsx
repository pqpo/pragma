import { User } from "@phosphor-icons/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";

import { i18n } from "../../i18n/index.ts";
import { ExpertDetailFragment, ExpertDirectoryFragment } from "./ExpertDirectoryFragment.tsx";
import { ExpertEditorFragment } from "./ExpertEditorFragment.tsx";
import type { ExpertRecord } from "./studio-model.ts";

const expert: ExpertRecord = {
  id: "test_expert",
  name: "Test Expert",
  description: "d".repeat(240),
  tags: ["test"],
  scope: "Handles focused test work.",
  instructions: "i".repeat(500),
  additionalInstructions: "",
  origin: "project",
  readOnly: false,
  customized: false,
  model: { runtimeId: "test", providerId: "test", modelId: "test" },
  capabilities: [],
  toolApprovals: {},
  skills: 0,
  tools: 0,
  mcpServers: 0,
  contextStoreMounts: [],
  resourceTools: [],
  plugins: [],
  usesApproval: false,
  icon: User,
};

afterEach(async () => {
  await i18n.changeLanguage("en");
});

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
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).not.toContain("ID: test_expert");
    expect(html).toContain("Scope");
    expect(html).not.toContain("Availability");
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("Show more");
    expect(html).not.toContain("d".repeat(201));
    expect(html).not.toContain("i".repeat(421));
    expect(html).toMatch(/studio-screen-header.*Back to Experts.*studio-screen-body.*Test Expert/s);
    expect(html).toContain("Delete expert");
    expect(html).not.toContain("Create new version");
  });

  it("offers edit and reset, but not deletion, for a built-in expert", () => {
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          origin: "built-in",
          readOnly: true,
          customized: true,
          model: null,
        }}
        contextStores={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onConfigureContext={() => undefined}
        onTryInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).not.toContain("Delete expert");
    expect(html).toContain("Customize");
    expect(html).not.toContain("Use as template");
    expect(html).toContain("Reset to default");
    expect(html).toContain("Configure knowledge");
    expect(html).toContain("Try in session");
  });

  it("renders localized metadata for the uncustomized built-in Pragma expert", async () => {
    await i18n.changeLanguage("zh-Hans");
    const html = renderToStaticMarkup(
      <ExpertDetailFragment
        expert={{
          ...expert,
          ref: "expert:0000000000pragma",
          id: "0000000000pragma",
          name: "Pragma",
          description: "Canonical description",
          scope: "Canonical scope",
          origin: "built-in",
          readOnly: true,
          customized: false,
          model: null,
        }}
        contextStores={[]}
        onBack={() => undefined}
        onEdit={() => undefined}
        onConfigureContext={() => undefined}
        onTryInSession={() => undefined}
        onDelete={async () => undefined}
        onReset={async () => undefined}
      />,
    );

    expect(html).toContain("内置通用 Agent，可直接处理日常工作并协调专业专家。");
    expect(html).toContain("使用当前 Runtime、授权工作区和可用能力完成你的工作。");
    expect(html).not.toContain("Canonical description");
    expect(html).not.toContain("Canonical scope");
  });
});

describe("ExpertDirectoryFragment", () => {
  it("uses a single search control without the inactive expert dropdown", () => {
    const html = renderToStaticMarkup(
      <ExpertDirectoryFragment
        experts={[expert]}
        onCreate={() => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('type="search"');
    expect(html).toContain('placeholder="Search experts"');
    expect(html).not.toContain("All experts");
    expect(html).not.toContain("directory-filter");
  });
});

describe("ExpertEditorFragment", () => {
  const draft = { ...expert, tagInput: "", pluginSecretMutations: {} };

  it("does not expose semantic identity fields during an ordinary edit", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="edit"
        initialValue={draft}
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html).not.toContain("<label>Version");
    expect(html).not.toContain("test_expert");
    expect(html).toContain("Back to expert details");
    expect(html).toMatch(/<button[^>]*aria-current="step"[^>]*>/);
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*aria-current="step"/);
  });

  it("keeps creation steps sequential", () => {
    const html = renderToStaticMarkup(
      <ExpertEditorFragment
        mode="create"
        initialValue={draft}
        runtimes={[]}
        contextStores={[]}
        capabilities={[]}
        plugins={[]}
        resources={[]}
        onCancel={() => undefined}
        onCreated={async () => undefined}
      />,
    );

    expect(html.match(/<button[^>]*disabled=""/g)).toHaveLength(4);
  });
});
