import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { handleOpenCodeQuestion } from "../src/adapter.ts";
import { prepareOpenCodeConfiguration } from "../src/configuration.ts";
import { v1Permission, v2PermissionRules } from "../src/permissions.ts";
import { probeOpenCode } from "../src/process.ts";

describe("OpenCode governance", () => {
  it.skipIf(process.platform === "win32")(
    "rejects CLI versions older than the exercised protocol baseline",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pragma-opencode-version-"));
      const executable = join(root, "opencode");
      try {
        await writeFile(executable, "#!/bin/sh\nprintf '1.18.31\\n'\n");
        await chmod(executable, 0o755);
        await expect(probeOpenCode(executable, process.env)).rejects.toThrow(/older than/);
        await writeFile(executable, "#!/bin/sh\nprintf '2.0.15\\n'\n");
        await expect(probeOpenCode(executable, process.env)).rejects.toThrow(/older than/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it("routes both native question dialects to the Host and replies with the native answer shape", async () => {
    const replyQuestion = vi.fn(async () => undefined);
    const humanInteractionHandler = vi.fn(async () => ({
      kind: "user_question" as const,
      answered: true,
      answers: { "Which target?": "Production" },
    }));
    const session = {
      id: "session-test",
      client: { replyQuestion },
      humanInteractionHandler,
    } as unknown as Parameters<typeof handleOpenCodeQuestion>[0];
    await handleOpenCodeQuestion(session, {
      type: "question.asked",
      data: {
        id: "que_test",
        sessionID: "session-test",
        questions: [
          {
            question: "Which target?",
            header: "Target",
            options: [{ label: "Production", description: "Live" }],
          },
        ],
      },
    });
    expect(replyQuestion).toHaveBeenLastCalledWith("session-test", "que_test", [["Production"]]);
    await handleOpenCodeQuestion(session, {
      type: "form.created",
      data: {
        form: {
          id: "frm_test",
          sessionID: "session-test",
          title: "Target",
          fields: [
            {
              key: "target",
              type: "string",
              title: "Which target?",
              options: [{ value: "prod", label: "Production" }],
            },
          ],
        },
      },
    });
    expect(replyQuestion).toHaveBeenLastCalledWith("session-test", "frm_test", { target: "prod" });
    expect(humanInteractionHandler).toHaveBeenCalledTimes(2);
  });

  it("keeps workspace boundaries and explicit denies in both permission dialects", () => {
    expect(v1Permission("auto-approve", { read: { "secrets/*": "deny" } })).toMatchObject({
      "*": "deny",
      bash: "deny",
      edit: "allow",
      external_directory: "deny",
      read: { "secrets/*": "deny" },
    });
    expect(v1Permission("request-approval", {}).edit).toBe("ask");
    expect(v1Permission("full-access", { "*": "deny" })).toEqual({ "*": "deny" });
    expect(v1Permission("auto-approve", { read: { "*": "deny" } }).read).toBe("deny");
    expect(v2PermissionRules("auto-approve", [])).toEqual(
      expect.arrayContaining([
        { action: "shell", resource: "*", effect: "deny" },
        { action: "external_directory", resource: "*", effect: "deny" },
        { action: "edit", resource: "*", effect: "allow" },
      ]),
    );
    expect(v2PermissionRules("full-access", [])).toEqual([
      { action: "*", resource: "*", effect: "allow" },
    ]);
  });

  it("imports only model settings and rejects project customization before launch", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-opencode-governance-"));
    const workspace = join(root, "project");
    const configDir = join(root, "host-config", "opencode");
    await mkdir(workspace);
    await mkdir(configDir, { recursive: true });
    try {
      await writeFile(
        join(configDir, "opencode.jsonc"),
        `{
        // Model access is retained, executable customization is not.
        provider: { local: { models: { echo: { name: "Echo" } } } },
        mcp: { unsafe: { type: "local", command: ["cat", "/secret"] } },
        plugin: ["unsafe"],
        permission: { read: { "secrets/*": "deny" } },
        experimental: { policies: [{ action: "permission", resource: "shell:git push *", effect: "deny" }] },
      }`,
      );
      await writeFile(
        join(workspace, "opencode.json"),
        JSON.stringify({ model: "local/echo", mcp: { unsafe: {} } }),
      );
      const env = { HOME: root, XDG_CONFIG_HOME: join(root, "host-config") };
      const result = await prepareOpenCodeConfiguration({
        env,
        workspace,
        sessionDir: join(root, "session"),
        major: 1,
      });
      const config = JSON.parse(result.env.OPENCODE_CONFIG_CONTENT!) as Record<string, unknown>;
      expect(config).toMatchObject({
        provider: { local: { models: { echo: { name: "Echo" } } } },
        model: "local/echo",
      });
      expect(config).not.toHaveProperty("mcp");
      expect(config).not.toHaveProperty("plugin");
      expect(config.permission).toMatchObject({ read: { "secrets/*": "deny" } });
      expect(config.experimental).toMatchObject({
        policies: [{ action: "permission", resource: "shell:git push *", effect: "deny" }],
      });
      expect(result.env.XDG_CONFIG_HOME).toBe(join(root, "session", "config"));
      await mkdir(join(workspace, ".opencode", "plugins"), { recursive: true });
      await expect(
        prepareOpenCodeConfiguration({
          env,
          workspace,
          sessionDir: join(root, "session"),
          major: 1,
        }),
      ).rejects.toThrow(/customization/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
