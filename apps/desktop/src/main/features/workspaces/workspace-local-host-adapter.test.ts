import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createLocalHostApplication, type WorkspaceFilesystemPort } from "@pragma/local-host";
import { afterEach, describe, expect, it } from "vitest";

import { availableRecentWorkspaces } from "./workspace-history-store.ts";
import { createWorkspaceFilesystemPort } from "./workspace-filesystem-port.ts";

const temporaryPaths: string[] = [];

describe("Desktop Local Host workspace adapter", () => {
  it("matches a CLI-side harness for the same symlink fixture", async () => {
    const root = await temporaryRoot();
    const workspace = join(root, "workspace");
    const alias = join(root, "workspace-alias");
    await mkdir(workspace);
    await symlink(workspace, alias);
    const fixture = {
      mission: { id: "mission-1", title: "Fixture Mission" },
      board: { items: [{ id: "handoffs/m3.md" }] },
    };

    const desktopApplication = createApplication(createWorkspaceFilesystemPort(), fixture);
    const cliHarness = createApplication(createCliFilesystemPort(), fixture);

    const [desktopDto, cliDto] = await Promise.all([
      canonicalFixtureDto(desktopApplication, alias),
      canonicalFixtureDto(cliHarness, alias),
    ]);

    expect(desktopDto).toEqual(cliDto);
    expect(desktopDto.workspace).toMatchObject({
      requestedPath: alias,
      canonicalPath: await realpath(workspace),
      displayName: "workspace",
    });
  });

  it("resolves every recent path through Local Host and de-duplicates canonical identity", async () => {
    const root = await temporaryRoot();
    const defaultWorkspace = join(root, "default");
    const defaultAlias = join(root, "default-alias");
    const recentWorkspace = join(root, "recent");
    await Promise.all([mkdir(defaultWorkspace), mkdir(recentWorkspace)]);
    await symlink(defaultWorkspace, defaultAlias);
    const application = createApplication(createWorkspaceFilesystemPort());
    const defaultSelection = await application.resolveWorkspace(defaultWorkspace);

    const recent = await availableRecentWorkspaces(
      [defaultAlias, defaultWorkspace, recentWorkspace, recentWorkspace],
      defaultSelection.identityHash,
      async (path) => await application.resolveWorkspace(path),
    );

    expect(recent).toHaveLength(1);
    expect(recent[0]).toMatchObject({
      requestedPath: recentWorkspace,
      canonicalPath: await realpath(recentWorkspace),
    });
  });

  it("uses identity rather than platform-specific path spelling when filtering recent workspaces", async () => {
    const resolved = await availableRecentWorkspaces(
      ["C:\\Work\\Pragma", "c:/work/pragma/", "C:\\Work\\Other"],
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      async (requestedPath) => ({
        schemaVersion: "pragma.integration-workspace/v1" as const,
        requestedPath,
        canonicalPath: requestedPath,
        displayName: "workspace",
        identityHash: requestedPath.includes("Other")
          ? "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
          : "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        access: { exists: true, readable: true, writable: true },
        source: "explicit" as const,
      }),
    );

    expect(resolved.map((workspace) => workspace.requestedPath)).toEqual(["C:\\Work\\Other"]);
  });
});

function createApplication(
  filesystem: WorkspaceFilesystemPort,
  fixture: {
    readonly mission: { readonly id: string; readonly title: string };
    readonly board: { readonly items: readonly { readonly id: string }[] };
  } = { mission: { id: "mission-1", title: "Fixture Mission" }, board: { items: [] } },
) {
  return createLocalHostApplication({
    integrationCapability: async () => ({
      schemaVersion: "pragma.integration-capability/v1",
      protocol: "pragma.integration/v1",
      readableVersions: ["pragma.integration/v1"],
      migratableFromVersions: [],
      features: ["workspace.resolve"],
    }),
    catalog: {
      listProjects: async () => [],
      getProjectRevision: async () => undefined,
      listExecutors: async () => [],
    },
    missions: {
      get: async (id) => ({ ...fixture.mission, id }),
      list: async () => [fixture.mission],
    },
    workspace: filesystem,
    board: {
      list: async () => fixture.board,
      read: async () => ({ content: "" }),
      search: async () => [],
    },
    runtime: { resolver: {} as never },
  });
}

async function canonicalFixtureDto(
  application: ReturnType<typeof createApplication>,
  workspacePath: string,
) {
  const [missions, mission, workspace, board] = await Promise.all([
    application.listMissions(),
    application.getMission("mission-1"),
    application.resolveWorkspace(workspacePath),
    application.listSharedBoard("mission-1"),
  ]);
  return { missions, mission, workspace, board };
}

function createCliFilesystemPort(): WorkspaceFilesystemPort {
  return {
    stat: async (path) => await stat(path),
    access: async (path, mode) =>
      await access(path, mode === "read" ? fsConstants.R_OK : fsConstants.W_OK),
    realpath: async (path) => await realpath(path),
  };
}

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pragma-local-host-workspace-"));
  temporaryPaths.push(path);
  return path;
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map(async (path) => await rm(path, { recursive: true })),
  );
});
