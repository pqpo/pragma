import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  MissionModelOverrideControls,
  resolveMissionModelMenuPlacement,
} from "../../components/MissionModelOverrideControls.tsx";
import {
  MissionAttachmentList,
  MissionImagePreviewDialog,
} from "../../components/MissionAttachments.tsx";
import { ToolPermissionSelect } from "../../components/ToolPermissionSelect.tsx";
import {
  HomeExecutorConfigurationTip,
  filterMissionExecutors,
  homeExecutorConfigurationUnavailable,
  belongsToUiOverlayOwner,
  isHomeExecutorFavorite,
  missionModelOverrideAvailable,
  orderFavoriteHomeExecutors,
  previewFavoriteDragOrder,
  preferredWorkspaceForExecutorSelection,
  rankFavoriteHomeExecutors,
  rankHomeMissionExecutors,
  selectHomeMissionExecutors,
  uniqueWorkspaces,
  workspacePathsEqual,
} from "./HomePage.tsx";
import { SchemaInputForm, createSchemaInputValue, isSchemaInputValid } from "./SchemaInputForm.tsx";

describe("homeExecutorConfigurationUnavailable", () => {
  it("blocks expert and team submissions while model/runtime state is unavailable", () => {
    expect(
      homeExecutorConfigurationUnavailable({
        executorKind: "expert",
        models: [],
        modelsLoading: true,
        modelError: null,
        modelResetRequired: false,
        persistenceReady: false,
      }),
    ).toBe(true);
    expect(
      homeExecutorConfigurationUnavailable({
        executorKind: "team",
        models: [],
        modelsLoading: false,
        modelError: "Runtime unavailable",
        modelResetRequired: false,
        persistenceReady: true,
      }),
    ).toBe(true);
  });

  it("does not block Flow submissions on model availability", () => {
    expect(
      homeExecutorConfigurationUnavailable({
        executorKind: "flow",
        models: [],
        modelsLoading: true,
        modelError: "Not applicable",
        modelResetRequired: true,
        persistenceReady: false,
      }),
    ).toBe(false);
  });
});

describe("HomeExecutorConfigurationTip", () => {
  it("renders model settings and Studio shortcuts without link underlines", () => {
    const html = renderToStaticMarkup(
      <HomeExecutorConfigurationTip
        message="No AI provider is configured, so the conversation cannot start."
        configureModelsLabel="Set up models"
        configureExpertLabel="Configure expert"
        onConfigureModels={() => undefined}
        onConfigureExpert={() => undefined}
      />,
    );

    expect(html).toContain('class="home-inline-tip home-inline-error-tip"');
    expect(html).toContain('role="alert"');
    expect(html).toContain("No AI provider is configured");
    expect(html).toContain("Set up models");
    expect(html).toContain("Configure expert");
    expect(html.match(/home-inline-error-link/g)).toHaveLength(2);
  });
});

describe("MissionAttachmentList", () => {
  it("renders one model warning below multiple clickable image thumbnails", () => {
    const html = renderToStaticMarkup(
      <MissionAttachmentList
        attachments={[
          {
            id: "00000000-0000-4000-8000-000000000001",
            kind: "image",
            name: "screen.png",
            path: "/tmp/screen.png",
            mimeType: "image/png",
          },
          {
            id: "00000000-0000-4000-8000-000000000002",
            kind: "image",
            name: "diagram.png",
            path: "/tmp/diagram.png",
            mimeType: "image/png",
          },
        ]}
        previews={{
          "00000000-0000-4000-8000-000000000001": "data:image/webp;base64,aW1hZ2U=",
          "00000000-0000-4000-8000-000000000002": "data:image/webp;base64,aW1hZ2U=",
        }}
        imageUnsupported
        onRemove={() => undefined}
      />,
    );

    expect(html).toContain('aria-label="View original screen.png"');
    expect(html).toContain('aria-label="View original diagram.png"');
    expect(html).toContain("mission-attachment-thumbnail");
    expect(html).not.toContain("<figcaption");
    expect(html).toContain("This model does not support images");
    expect(html.match(/mission-attachment-model-error/g)).toHaveLength(1);
    expect(html).toContain('</figure></div><div class="mission-attachment-model-error">');
  });

  it("renders a chromeless image preview with only an icon close control", () => {
    const html = renderToStaticMarkup(
      <MissionImagePreviewDialog
        name="screen.png"
        src="data:image/webp;base64,aW1hZ2U="
        onClose={() => undefined}
      />,
    );

    expect(html).toContain("mission-original-image-backdrop");
    expect(html).toContain("mission-original-image-close");
    expect(html).toContain('aria-label="Close preview"');
    expect(html).toContain("mission-original-image");
    expect(html).not.toContain("ui-dialog-header");
    expect(html).not.toContain("ui-dialog-footer");
    expect(html).not.toContain("Original image</p>");
  });
});

describe("MissionModelOverrideControls", () => {
  it("flips the model options panel to the left when the right side is too narrow", () => {
    expect(
      resolveMissionModelMenuPlacement({
        triggerLeft: 680,
        viewportWidth: 960,
        menuWidth: 490,
        sectionsWidth: 242,
        optionsWidth: 240,
      }),
    ).toEqual({ left: 432, placement: "left" });
  });

  it("keeps the model options panel on the right when it fits", () => {
    expect(
      resolveMissionModelMenuPlacement({
        triggerLeft: 240,
        viewportWidth: 960,
        menuWidth: 490,
        sectionsWidth: 242,
        optionsWidth: 240,
      }),
    ).toEqual({ left: 240, placement: "right" });
  });

  it("combines the selected model and thinking depth without exposing the Runtime", () => {
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

    expect(html).toContain("DeepSeek Model · High");
    expect(html).toContain("mission-model-control");
    expect(html).not.toContain("Default model");
    expect(html).not.toContain("Default thinking depth");
    expect(html).not.toContain("runtimeId");
    expect(html).not.toContain("<select");
  });

  it("uses resolved default values as the selected model and thinking depth", () => {
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

    expect(html).toContain("GPT · Default (Medium)");
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("<select");
  });

  it("shows Default when the selected model has no resolved thinking depth", () => {
    const html = renderToStaticMarkup(
      <MissionModelOverrideControls
        models={[
          {
            id: "deepseek-v4-pro",
            displayName: "DeepSeek V4 Pro",
            provider: { kind: "registered", id: "deepseek", displayName: "DeepSeek" },
          },
        ]}
        value={{ providerId: "deepseek", modelId: "deepseek-v4-pro" }}
        onChange={() => undefined}
      />,
    );

    expect(html).toContain("DeepSeek V4 Pro · Default");
    expect(html).not.toContain("DeepSeek V4 Pro · Thinking depth");
  });

  it("uses the shared custom selector for detailed tool permissions", () => {
    const html = renderToStaticMarkup(
      <ToolPermissionSelect detailed value="full-access" onChange={() => undefined} />,
    );

    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="listbox"');
    expect(html).toContain("Full access");
    expect(html).toContain("Allow actions anywhere on this device without approval.");
    expect(html).toContain("tool-permission-menu");
    expect(html).toContain("is-full-access");
    expect(html).not.toContain("<select");
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
      avatarId: "pragma.avatar.expert.default",
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

  it("orders all favorite resource types by their saved Home rank", () => {
    const favorites = rankFavoriteHomeExecutors([
      {
        ...executors[0]!,
        name: "Second expert",
        preference: { favoriteScope: "global", hidden: false, favoriteRank: 1 },
      },
      {
        ...executors[1]!,
        ref: "team:0000000000000001" as const,
        kind: "team" as const,
        name: "First team",
        preference: { favoriteScope: "workspace", hidden: false, favoriteRank: 0 },
      },
      {
        ...executors[2]!,
        ref: "flow:0000000000000001" as const,
        kind: "flow" as const,
        name: "Unfavorited flow",
        preference: { favoriteScope: "none", hidden: false },
      },
    ]);

    expect(favorites.map((executor) => executor.name)).toEqual(["First team", "Second expert"]);
  });

  it("applies a complete drag preview order and ignores non-favorite entries", () => {
    const favorites = [
      {
        ...executors[0]!,
        name: "First",
        preference: { favoriteScope: "global" as const, hidden: false, favoriteRank: 0 },
      },
      {
        ...executors[1]!,
        name: "Second",
        preference: { favoriteScope: "global" as const, hidden: false, favoriteRank: 1 },
      },
    ];

    expect(orderFavoriteHomeExecutors(favorites, [favorites[1]!.ref, favorites[0]!.ref])).toEqual([
      favorites[1],
      favorites[0],
    ]);
    expect(
      orderFavoriteHomeExecutors(favorites, [favorites[1]!.ref, "more", favorites[0]!.ref]),
    ).toBe(favorites);
  });

  it("previews a favorite reorder before the pointer fully covers its target", () => {
    expect(previewFavoriteDragOrder(["a", "b", "c", "d"], "a", "c", false)).toEqual([
      "b",
      "a",
      "c",
      "d",
    ]);
    expect(previewFavoriteDragOrder(["a", "b", "c", "d"], "a", "c", true)).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  it("uses the assigned favorite workspace ahead of a resource's most recent workspace", () => {
    const executor = {
      ...executors[0]!,
      preference: {
        favoriteScope: "workspace" as const,
        hidden: false,
        favoriteWorkspace: { path: "/work/favorite", basename: "favorite" },
        lastWorkspace: { path: "/work/recent", basename: "recent" },
      },
    };

    expect(preferredWorkspaceForExecutorSelection(executor)).toEqual({
      path: "/work/favorite",
      basename: "favorite",
    });
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

  it("keeps a portaled selector inside its owning executor popup", () => {
    const ownedOverlay = {
      getAttribute: (name: string) => (name === "data-ui-overlay-owner" ? "executor-picker" : null),
    } as unknown as Element;

    expect(belongsToUiOverlayOwner(ownedOverlay, "executor-picker")).toBe(true);
    expect(belongsToUiOverlayOwner(ownedOverlay, "another-popup")).toBe(false);
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
