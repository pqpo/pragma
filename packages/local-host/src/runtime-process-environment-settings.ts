import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";

import { PragmaPaths, withFileLock } from "@pragma/core";
import {
  DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS,
  RuntimeProcessEnvironmentSettingsSchema,
  UpdateRuntimeProcessEnvironmentPolicySchema,
  type RuntimeProcessEnvironmentPolicy,
  type RuntimeProcessEnvironmentSettings,
  type UpdateRuntimeProcessEnvironmentPolicy,
} from "@pragma/shared";

export interface RuntimeProcessEnvironmentSettingsStore {
  get(): Promise<RuntimeProcessEnvironmentSettings>;
  getSync(): RuntimeProcessEnvironmentSettings;
  getPolicy(): Promise<RuntimeProcessEnvironmentPolicy>;
  updatePolicy(
    input: UpdateRuntimeProcessEnvironmentPolicy,
  ): Promise<RuntimeProcessEnvironmentSettings>;
}

export function createRuntimeProcessEnvironmentSettingsStore(options: {
  readonly pragmaHome: string;
}): RuntimeProcessEnvironmentSettingsStore {
  const path = new PragmaPaths(options).runtimeProcessEnvironmentSettings();
  const lockPath = `${path}.lock`;

  const ensureSettingsDirectory = async (): Promise<void> => {
    const directory = dirname(path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
  };

  const read = async (): Promise<RuntimeProcessEnvironmentSettings> => {
    let contents: string;
    try {
      contents = await readFile(path, "utf8");
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS;
      throw new Error("runtime_process_environment_settings_unavailable", { cause: error });
    }

    try {
      return RuntimeProcessEnvironmentSettingsSchema.parse(JSON.parse(contents));
    } catch (error) {
      throw new Error("runtime_process_environment_settings_unavailable", { cause: error });
    }
  };

  const write = async (settings: RuntimeProcessEnvironmentSettings): Promise<void> => {
    const temporaryPath = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, path);
    await chmod(path, 0o600).catch(() => undefined);
  };

  return {
    async get() {
      await ensureSettingsDirectory();
      return await withFileLock(lockPath, read);
    },
    getSync() {
      try {
        return RuntimeProcessEnvironmentSettingsSchema.parse(
          JSON.parse(readFileSync(path, "utf8")),
        );
      } catch (error) {
        if (isNodeError(error, "ENOENT")) return DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS;
        throw new Error("runtime_process_environment_settings_unavailable", { cause: error });
      }
    },
    async getPolicy() {
      await ensureSettingsDirectory();
      return (await withFileLock(lockPath, read)).policy;
    },
    async updatePolicy(raw) {
      const input = UpdateRuntimeProcessEnvironmentPolicySchema.parse(raw);
      await ensureSettingsDirectory();
      return await withFileLock(lockPath, async () => {
        const current = await read();
        if (current.revision !== input.expectedRevision) {
          throw new Error("runtime_process_environment_settings_conflict");
        }
        const next = RuntimeProcessEnvironmentSettingsSchema.parse({
          schemaVersion: current.schemaVersion,
          revision: current.revision + 1,
          policy: input.policy,
        });
        await write(next);
        return next;
      });
    },
  };
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
