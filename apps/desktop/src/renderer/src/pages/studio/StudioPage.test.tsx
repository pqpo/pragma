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
  it("renders a resizable secondary navigation", () => {
    const html = renderToStaticMarkup(<StudioPage onTryExpert={() => undefined} />);
    const resourceIndex = html.indexOf("<span>Knowledge bases</span>");
    const distributionIndex = html.indexOf('class="studio-distribution-actions"');
    const squareIndex = html.indexOf("<span>Square</span>");
    const importIndex = html.indexOf("<span>Import</span>");
    const exportIndex = html.indexOf("<span>Export</span>");

    expect(html).toContain('class="studio-navigation"');
    expect(html).toContain('aria-label="Resize navigation"');
    expect(html).toContain('role="separator"');
    expect(html).not.toContain("<span>Revision tasks</span><em>");
    expect(html).not.toContain("<span>Plugins</span>");
    expect(resourceIndex).toBeGreaterThan(-1);
    expect(distributionIndex).toBeGreaterThan(resourceIndex);
    expect(squareIndex).toBeGreaterThan(distributionIndex);
    expect(importIndex).toBeGreaterThan(squareIndex);
    expect(exportIndex).toBeGreaterThan(importIndex);
  });

  it("keeps the last successfully loaded experts across page remounts", () => {
    const html = renderToStaticMarkup(
      <StudioPage
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
        onTryExpert={() => undefined}
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
