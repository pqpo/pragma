import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { User } from "@phosphor-icons/react";

import type { ExpertDefinition } from "../../../../shared/contracts/index.ts";
import { mergeLoadedExperts, StudioPage } from "./StudioPage.tsx";
import { toExpertRecord } from "./studio-model.ts";

const persistedExpert: ExpertDefinition = {
  schemaVersion: "pragma.desktop-expert-view/v1",
  ref: "expert:3sfd30h5017wd17d",
  id: "3sfd30h5017wd17d",
  avatarId: "pragma.avatar.expert.default",
  name: "Fresh reviewer",
  description: "Reviews changes.",
  tags: [],
  scope: "Reviews code quality.",
  instructions: "Review changes carefully.",
  additionalInstructions: "",
  origin: "project",
  readOnly: false,
  customized: false,
  executionProfile: { mode: "system-default" },
  capabilities: [],
  toolApprovals: {},
  plugins: [],
  contextStoreMounts: [],
  resourceTools: [],
  revision: 1,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("StudioPage", () => {
  it("returns a cached plugin view to the expert directory", () => {
    const html = renderToStaticMarkup(
      <StudioPage
        memoryEnabled={true}
        initialMemoryState={{ activeView: "plugins" }}
        onUseInSession={() => undefined}
      />,
    );

    expect(html).toContain('class="studio-screen expert-directory"');
    expect(html).not.toContain('class="plugin-directory"');
  });

  it("renders a resizable secondary navigation", () => {
    const html = renderToStaticMarkup(
      <StudioPage memoryEnabled={true} onUseInSession={() => undefined} />,
    );
    const resourceIndex = html.indexOf(">Knowledge bases</span>");
    const capabilitiesIndex = html.indexOf(">Capabilities</span>");

    expect(html).toContain('class="studio-navigation"');
    expect(html).toContain('aria-label="Resize navigation"');
    expect(html).toContain('role="separator"');
    expect(html).not.toContain(">Revision tasks</span><em>");
    expect(html).not.toContain(">Plugins</span>");
    expect(resourceIndex).toBeGreaterThan(-1);
    expect(resourceIndex).toBeGreaterThan(capabilitiesIndex);
    expect(html).not.toContain(">Market</span>");
    expect(html).not.toContain('class="navigation-attention-dot"');
    expect(html).not.toContain('class="studio-distribution-actions"');
  });

  it("shows pending revision dots on both Skills and Knowledge bases", () => {
    const html = renderToStaticMarkup(
      <StudioPage
        memoryEnabled
        attention={{ skills: true, knowledge: true }}
        onUseInSession={() => undefined}
      />,
    );
    expect(html.match(/class="navigation-attention-dot"/g)).toHaveLength(2);
    expect(html).toContain('Knowledge bases<span class="navigation-attention-dot"');
    expect(html).toContain('Skills<span class="navigation-attention-dot"');
  });

  it("keeps the last successfully loaded experts across page remounts", () => {
    const html = renderToStaticMarkup(
      <StudioPage
        memoryEnabled={true}
        initialMemoryState={{
          activeView: "experts",
          experts: [
            {
              id: "2qgbztga4kz2qz51",
              ref: "expert:2qgbztga4kz2qz51",
              name: "Cached Pragma",
              description: "Cached expert",
              scope: "general",
              instructions: "Help",
              additionalInstructions: "",
              avatarId: "pragma.avatar.expert.01",
              tags: [],
              origin: "project",
              readOnly: false,
              customized: false,
              model: null,
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
            },
          ],
        }}
        onUseInSession={() => undefined}
      />,
    );

    expect(html).toContain("Cached Pragma");
    expect(html).not.toContain("No experts available");
  });

  it("keeps the cached definition for an expert whose individual refresh fails", () => {
    const cachedReviewer = {
      ...toExpertRecord(persistedExpert),
      name: "Cached reviewer",
    };
    const cachedWriter = {
      ...toExpertRecord({
        ...persistedExpert,
        ref: "expert:1xddvess309a6gme",
        id: "1xddvess309a6gme",
        name: "Cached writer",
      }),
    };
    const merged = mergeLoadedExperts(
      [{ ref: persistedExpert.ref }, { ref: cachedWriter.ref }] as never,
      [
        { status: "fulfilled", value: persistedExpert },
        { status: "rejected", reason: new Error("temporarily unavailable") },
      ],
      [cachedReviewer, cachedWriter],
    );

    expect(merged.map((expert) => expert.name)).toEqual(["Fresh reviewer", "Cached writer"]);
  });

  it("keeps a summary card visible when an uncached expert definition is unavailable", () => {
    const merged = mergeLoadedExperts(
      [persistedExpert],
      [{ status: "rejected", reason: new Error("temporarily unavailable") }],
      [],
    );

    expect(merged).toEqual([
      expect.objectContaining({
        ref: persistedExpert.ref,
        name: persistedExpert.name,
        definitionUnavailable: true,
      }),
    ]);
  });
});
