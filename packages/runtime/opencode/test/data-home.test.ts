import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { prepareOpenCodeDataHome } from "../src/data-home.ts";

describe("OpenCode native data home", () => {
  it("keeps conversations under the Runtime Session and refreshes CLI authentication", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-opencode-data-home-"));
    const hostDataHome = join(root, "host-data");
    const hostAuthDir = join(hostDataHome, "opencode");
    const sessionDir = join(root, "pragma-session");
    await mkdir(hostAuthDir, { recursive: true });
    try {
      const authFile = join(hostAuthDir, "auth.json");
      await writeFile(authFile, '{"test":"first"}');
      const env = { HOME: root, XDG_DATA_HOME: hostDataHome };
      const first = await prepareOpenCodeDataHome(env, sessionDir);
      expect(first.XDG_DATA_HOME).toBe(join(sessionDir, "data"));
      expect(env.XDG_DATA_HOME).toBe(hostDataHome);
      const privateAuth = join(sessionDir, "data", "opencode", "auth.json");
      expect(await readFile(privateAuth, "utf8")).toBe('{"test":"first"}');

      await writeFile(authFile, '{"test":"second"}');
      await prepareOpenCodeDataHome(env, sessionDir);
      expect(await readFile(privateAuth, "utf8")).toBe('{"test":"second"}');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
