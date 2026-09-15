import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { HomeProject } from "../../../../shared/contracts/home-projects.ts";
import { HomeProjects } from "./HomeProjects.tsx";

const projects: readonly HomeProject[] = Array.from({ length: 7 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  name: `Project ${index + 1}`,
  executorRef: "expert:0000000000pragma",
  contextStoreIds: [],
  workspace: { path: `/tmp/project-${index + 1}`, basename: `project-${index + 1}` },
}));

describe("HomeProjects", () => {
  it("keeps the compact home list free of per-project edit actions and centers More", () => {
    const html = renderToStaticMarkup(
      <HomeProjects
        projects={projects}
        executors={[]}
        stores={[]}
        selectedId={undefined}
        onSelect={() => undefined}
        onEdit={() => undefined}
        onMore={() => undefined}
      />,
    );

    expect(html).not.toContain("home-favorites-manage-button");
    expect(html).toContain('class="text-button home-project-more"');
    expect(html).toContain("More (1)");
  });

  it("shows edit actions in the project manager list", () => {
    const html = renderToStaticMarkup(
      <HomeProjects
        projects={projects.slice(0, 2)}
        executors={[]}
        stores={[]}
        selectedId={undefined}
        onSelect={() => undefined}
        onEdit={() => undefined}
        showEditActions
      />,
    );

    expect(html.match(/home-favorites-manage-button/g)).toHaveLength(2);
    expect(html).toContain("Configure Project 1");
  });
});
