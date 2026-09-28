import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { canUseOpenCodeRuntime } from "../src/availability.ts";

describe("OpenCode availability", () => {
  it.skipIf(process.platform === "win32")(
    "caches successful probes and supports explicit refresh",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pragma-opencode-availability-"));
      const executablePath = join(root, "opencode");
      try {
        await writeFile(executablePath, "#!/bin/sh\nprintf '1.18.32\\n'\n");
        await chmod(executablePath, 0o755);
        const input = { executablePath, env: { ...process.env } };
        await expect(canUseOpenCodeRuntime(input)).resolves.toMatchObject({ usable: true });

        await writeFile(executablePath, "#!/bin/sh\nprintf 'invalid\\n'\n");
        await expect(canUseOpenCodeRuntime(input)).resolves.toMatchObject({ usable: true });
        await expect(
          canUseOpenCodeRuntime({ ...input, forceRefresh: true }),
        ).resolves.toMatchObject({ usable: false });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
});
