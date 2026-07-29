import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MissionModelOverrideControls } from "../../components/MissionModelOverrideControls.tsx";
import {
  filterMissionExecutors,
  isHomeExecutorFavorite,
  missionModelOverrideAvailable,
  rankHomeMissionExecutors,
  selectHomeMissionExecutors,
  uniqueWorkspaces,
  workspacePathsEqual,
} from "./HomePage.tsx";
import { SchemaInputForm, createSchemaInputValue, isSchemaInputValid } from "./SchemaInputForm.tsx";

describe("MissionModelOverrideControls", () => {
  it("shows generic defaults before discovery without exposing the Runtime", () => {
    const html = renderToStaticMarkup(
      <MissionModelOverrideControls
        models={[
          {
            id: "deepseek",
            displayName: "DeepSeek Model",
            provider: {
              kind: "registered",
              id: "provider",
              displayName: "DeepSeek",
            },
            thinking: {
              supportedLevels: [{ value: "high", label: "High" }],
            },
          },
        ]}
        value={{
          providerId: "provider",
          modelId: "deepseek",
          thinkingLevel: "high",
        }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("DeepSeek · DeepSeek Model");
    expect(html).toContain('<option value="high" selected="">High</option>');
    expect(html).toContain("Default model");
    expect(html).toContain("Default thinking depth");
    expect(html).not.toContain("runtimeId");
  });

  it("replaces generic defaults with the asynchronously resolved values", () => {
    const html = renderToStaticMarkup(
      <MissionModelOverrideControls
        models={[
          {
            id: "gpt",
            displayName: "GPT",
            provider: { kind: "registered", id: "openai", displayName: "OpenAI" },
            thinking: {
              supportedLevels: [{ value: "medium", label: "Medium" }],
              defaultLevel: "medium",
            },
          },
        ]}
        defaultValue={{ providerId: "openai", modelId: "gpt", thinkingLevel: "medium" }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain('<option value="" selected="">Default (OpenAI · GPT)</option>');
    expect(html).toContain('<option value="" selected="">Default (Medium)</option>');
  });
});

describe("mission executor search", () => {
  const executors = Array.from({ length: 100 }, (_, index) => {
    const id = index.toString(32).padStart(16, "0");
    return {
      ref: `expert:${id}` as const,
      name: `Expert ${index}`,
      description: index % 2 === 0 ? "Release work" : "Other work",
      kind: "expert" as const,
      origin: "project" as const,
      readOnly: false,
      customized: false,
      tags: index % 2 === 0 ? ["release"] : [],
      teamMemberships: [],
      preference: {
        favoriteScope: "none" as const,
        hidden: false,
      },
      alwaysVisible: false,
    };
  });

  it("keeps the full catalog available and searches names, descriptions, and tags", () => {
    expect(filterMissionExecutors(executors, "")).toHaveLength(100);
    const matches = filterMissionExecutors(executors, "Expert 99");
    expect(matches).toHaveLength(1);
    expect(matches[0]?.name).toBe("Expert 99");
    expect(filterMissionExecutors(executors, "release")).toHaveLength(50);
  });

  it("ranks global and workspace favorites before recent and team-managed experts", () => {
    const ranked = rankHomeMissionExecutors(
      [
        {
          ...executors[0]!,
          name: "Team member",
          teamMemberships: [{ ref: "team:0000000000000001", name: "Team" }],
        },
        {
          ...executors[1]!,
          name: "Recent",
          preference: {
            favoriteScope: "none",
            hidden: false,
            lastUsedAt: "2026-07-29T09:00:00.000Z",
          },
        },
        {
          ...executors[2]!,
          name: "Workspace favorite",
          preference: {
            favoriteScope: "workspace",
            hidden: false,
            favoriteWorkspace: { path: "/work/project", basename: "project" },
            lastWorkspace: { path: "/work/other", basename: "other" },
          },
        },
        {
          ...executors[3]!,
          name: "Global favorite",
          preference: { favoriteScope: "global", hidden: false },
        },
      ],
      "/work/project",
    );
    expect(ranked.map((executor) => executor.name)).toEqual([
      "Global favorite",
      "Workspace favorite",
      "Recent",
      "Team member",
    ]);
  });

  it("pins workspace favorites only in their assigned workspace", () => {
    const workspaceFavorite = {
      ...executors[0]!,
      preference: {
        favoriteScope: "workspace" as const,
        hidden: false,
        favoriteWorkspace: { path: "/work/favorite", basename: "favorite" },
      },
    };
    const globalFavorite = {
      ...executors[1]!,
      preference: { favoriteScope: "global" as const, hidden: false },
    };

    expect(isHomeExecutorFavorite(workspaceFavorite, "/work/favorite")).toBe(true);
    expect(isHomeExecutorFavorite(workspaceFavorite, "/work/favorite/")).toBe(true);
    expect(isHomeExecutorFavorite(workspaceFavorite, "/work/other")).toBe(false);
    expect(isHomeExecutorFavorite(globalFavorite, "/work/other")).toBe(true);
  });

  it("compares equivalent workspace paths across picker and persisted representations", () => {
    expect(workspacePathsEqual("/work/project/", "/work/project")).toBe(true);
    expect(workspacePathsEqual("C:\\work\\project\\", "c:/work/project")).toBe(true);
    expect(workspacePathsEqual("/work/project", "/work/other")).toBe(false);
    expect(workspacePathsEqual(undefined, "/work/project")).toBe(false);
  });

  it("deduplicates current and recent workspace choices by normalized path", () => {
    expect(
      uniqueWorkspaces([
        { path: "/work/current", basename: "current" },
        { path: "/work/current/", basename: "duplicate" },
        { path: "/work/recent", basename: "recent" },
      ]),
    ).toEqual([
      { path: "/work/current", basename: "current" },
      { path: "/work/recent", basename: "recent" },
    ]);
  });

  it("keeps search and type/tag filters in selection while excluding hidden executors", () => {
    const visibleFlow = {
      ...executors[0]!,
      ref: "flow:0000000000000001" as const,
      name: "Release flow",
      kind: "flow" as const,
    };
    const hiddenFlow = {
      ...executors[2]!,
      ref: "flow:0000000000000002" as const,
      name: "Hidden release flow",
      kind: "flow" as const,
      preference: { favoriteScope: "none" as const, hidden: true },
    };

    expect(
      selectHomeMissionExecutors(
        [executors[1]!, visibleFlow, hiddenFlow],
        "release",
        "flow",
        "release",
        undefined,
      ).map((executor) => executor.name),
    ).toEqual(["Release flow"]);
  });
});

describe("persisted Mission model overrides", () => {
  const models = [
    {
      id: "gpt",
      displayName: "GPT",
      provider: { kind: "registered" as const, id: "openai", displayName: "OpenAI" },
      thinking: {
        supportedLevels: [
          { value: "medium", label: "Medium" },
          { value: "high", label: "High" },
        ],
      },
    },
  ];

  it("restores only selections still offered by the current model catalog", () => {
    expect(
      missionModelOverrideAvailable(models, {
        providerId: "openai",
        modelId: "gpt",
        thinkingLevel: "high",
      }),
    ).toBe(true);
    expect(
      missionModelOverrideAvailable(models, {
        providerId: "openai",
        modelId: "gpt",
        thinkingLevel: "xhigh",
      }),
    ).toBe(false);
    expect(
      missionModelOverrideAvailable(models, {
        providerId: "other",
        modelId: "gpt",
      }),
    ).toBe(false);
  });
});

describe("Flow mission input form", () => {
  const schema = {
    type: "object" as const,
    properties: {
      issueId: { type: "string" as const, description: "CCAS issue identifier" },
      retries: { type: "integer" as const },
      options: {
        type: "object" as const,
        properties: { verify: { type: "boolean" as const } },
        required: ["verify"],
        additionalProperties: false as const,
      },
      tags: { type: "array" as const, items: { type: "string" as const } },
    },
    required: ["issueId", "options"],
    additionalProperties: false as const,
  };

  it("initializes required fields and validates exact structured input", () => {
    const value = createSchemaInputValue(schema);

    expect(value).toEqual({ issueId: "", options: { verify: false } });
    expect(isSchemaInputValid(schema, value)).toBe(true);
    expect(isSchemaInputValid(schema, { ...value, extra: true })).toBe(false);
  });

  it("renders nested fields while leaving optional fields disabled", () => {
    const html = renderToStaticMarkup(
      <SchemaInputForm
        schema={schema}
        value={createSchemaInputValue(schema)}
        onChange={() => {}}
      />,
    );

    expect(html).toContain("CCAS issue identifier");
    expect(html).toContain("issueId");
    expect(html).toContain("verify");
    expect(html).toContain("Include");
    expect(html).not.toContain("Optional JSON");
  });
});
