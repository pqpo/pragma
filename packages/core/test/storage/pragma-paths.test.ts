import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { encodePragmaPathSegment, PragmaPaths } from "../../src/storage/pragma-paths.ts";

describe("PragmaPaths", () => {
  it("prefers an explicit root and encodes every external id segment", () => {
    const paths = new PragmaPaths({
      pragmaHome: "/explicit/pragma",
      env: { PRAGMA_HOME: "/environment/pragma" },
    });

    expect(paths.root).toBe("/explicit/pragma");
    expect(paths.systemSessionRoot("workflow/../一", "session/../二")).toBe(
      join(
        "/explicit/pragma/state/workflows",
        encodePragmaPathSegment("workflow/../一"),
        "sessions",
        encodePragmaPathSegment("session/../二"),
      ),
    );
    expect(paths.agentPluginRoot("agent/a", "plugin/a")).toBe(
      join(
        "/explicit/pragma/cache/agents",
        encodePragmaPathSegment("agent/a"),
        "plugins",
        encodePragmaPathSegment("plugin/a"),
      ),
    );
    expect(paths.systemSessionOwner("session/../二")).toBe(
      join(
        "/explicit/pragma/state/workflows/.system-session-owners",
        `${encodePragmaPathSegment("session/../二")}.json`,
      ),
    );
  });

  it("uses PRAGMA_HOME when no explicit root is supplied", () => {
    expect(new PragmaPaths({ env: { PRAGMA_HOME: "/environment/pragma" } }).root).toBe(
      "/environment/pragma",
    );
  });

  it("uses distinct, URL-safe encodings without padding", () => {
    expect(encodePragmaPathSegment("a/b")).not.toBe(encodePragmaPathSegment("a_b"));
    expect(encodePragmaPathSegment("一/二")).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(encodePragmaPathSegment("agent")).not.toContain("=");
  });
});
