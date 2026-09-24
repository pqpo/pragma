import { randomBytes } from "node:crypto";
import { execFile, spawn, type ChildProcessByStdio } from "node:child_process";
import { createServer } from "node:net";
import type { Readable } from "node:stream";
import { promisify } from "node:util";
import { OpenCode } from "@opencode/client";
import { v1Permission, type OpenCodePermissionMode } from "./permissions.ts";

type OpenCodeChild = ChildProcessByStdio<null, Readable, Readable>;
const execFileAsync = promisify(execFile);

export type OpenCodeMajor = 1 | 2;
const MINIMUM_VERSION: Record<OpenCodeMajor, readonly [number, number, number]> = {
  1: [1, 18, 32],
  2: [2, 0, 16],
};

export interface OpenCodeProcess {
  readonly major: OpenCodeMajor;
  readonly version: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly child: OpenCodeChild;
  close(): Promise<void>;
}

export async function probeOpenCode(
  executablePath: string,
  env: NodeJS.ProcessEnv,
): Promise<{ major: OpenCodeMajor; version: string }> {
  const { stdout, stderr } = await execFileAsync(executablePath, ["--version"], {
    env,
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  const output = stdout + stderr;
  const match = /(?:^|\s|v)([12])\.(\d+)\.(\d+)(?:\b|[-+])/.exec(output);
  if (match === null) throw new Error("OpenCode CLI version is unavailable or unsupported.");
  const major = Number(match[1]) as OpenCodeMajor;
  const version = [major, Number(match[2]), Number(match[3])];
  const minimum = MINIMUM_VERSION[major];
  if (version[1]! < minimum[1] || (version[1] === minimum[1] && version[2]! < minimum[2])) {
    throw new Error(
      `OpenCode ${version.join(".")} is older than the supported ${minimum.join(".")}.`,
    );
  }
  return {
    major,
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

export async function startOpenCodeProcess(input: {
  readonly executablePath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd: string;
  readonly major: OpenCodeMajor;
  readonly version: string;
  readonly permissionMode?: OpenCodePermissionMode | undefined;
  readonly mcpUrl?: string | undefined;
}): Promise<OpenCodeProcess> {
  const port = await unusedLoopbackPort();
  const password = randomBytes(32).toString("base64url");
  const existingConfig = input.env["OPENCODE_CONFIG_CONTENT"];
  const parsedConfig: unknown = existingConfig === undefined ? {} : JSON.parse(existingConfig);
  if (typeof parsedConfig !== "object" || parsedConfig === null || Array.isArray(parsedConfig)) {
    throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object.");
  }
  const config = asObject(parsedConfig);
  const managedConfig =
    input.major === 1
      ? {
          ...config,
          ...(input.permissionMode === undefined
            ? {}
            : {
                permission: v1Permission(input.permissionMode, asObject(config["permission"])),
              }),
          mcp:
            input.mcpUrl === undefined
              ? {}
              : {
                  pragma_tools: { type: "remote", url: input.mcpUrl, enabled: true },
                },
        }
      : {
          ...config,
          ...(input.permissionMode === undefined || input.permissionMode === "full-access"
            ? {}
            : {
                experimental: {
                  policies: [
                    ...(Array.isArray(asObject(config["experimental"])["policies"])
                      ? (asObject(config["experimental"])["policies"] as unknown[])
                      : []),
                    { action: "permission", resource: "shell:*", effect: "deny" },
                    { action: "permission", resource: "execute:*", effect: "deny" },
                    { action: "permission", resource: "external_directory:*", effect: "deny" },
                  ],
                },
              }),
        };
  const child = spawn(
    input.executablePath,
    ["serve", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: input.cwd,
      env: {
        ...input.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(managedConfig),
        OPENCODE_SERVER_PASSWORD: password,
        OPENCODE_SERVER_USERNAME: "opencode",
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    },
  );
  const url = `http://127.0.0.1:${port}`;
  let diagnostic = "";
  let actualPassword = password;
  let spawnError: Error | undefined;
  child.on("error", (error) => {
    spawnError = error;
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk: Buffer) => {
      diagnostic = (diagnostic + chunk.toString("utf8")).slice(-4096);
      const match = /server password\s+(\S+)/i.exec(diagnostic);
      if (match !== null) actualPassword = match[1]!;
    });
  }
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (spawnError !== undefined) throw spawnError;
      if (child.exitCode !== null) throw new Error("OpenCode service exited before readiness.");
      try {
        const headers = { Authorization: basicAuth(actualPassword) };
        const healthy =
          input.major === 1
            ? (await fetch(`${url}/global/health`, { headers, signal: AbortSignal.timeout(1_000) }))
                .ok
            : (await OpenCode.make({ baseUrl: url, headers }).server.info({
                signal: AbortSignal.timeout(1_000),
              })) !== undefined;
        if (healthy) {
          return {
            major: input.major,
            version: input.version,
            url,
            headers,
            child,
            close: async () => await stopChild(child),
          };
        }
      } catch {
        // The listener can take time to start; the bounded deadline controls retries.
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("OpenCode service did not become ready within 15 seconds.");
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function basicAuth(password: string): string {
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("Could not reserve OpenCode port.");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function stopChild(child: OpenCodeChild): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    child.stdout.destroy();
    child.stderr.destroy();
    return;
  }
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      /* The process group already exited. */
    }
  } else if (child.exitCode === null) {
    child.kill("SIGTERM");
  }
  await Promise.race([
    new Promise<void>((resolve) => child.once("close", () => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      /* The process group already exited. */
    }
  } else if (child.exitCode === null) {
    child.kill("SIGKILL");
  }
  child.stdout.destroy();
  child.stderr.destroy();
}
