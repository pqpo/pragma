import { State } from "../../src/pipeline/extraction-session/schema.ts";
import { markInlineRead } from "../../src/pipeline/extraction-session/evidence.ts";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { createMemoryExtractionSessionStore } from "../../src/pipeline/extraction-session/store.ts";

/** Unit-test setup for the supported legacy tool adapter, not a historical migration fixture. */
export function createLegacyExtractionSessionStore(
  options: Parameters<typeof createMemoryExtractionSessionStore>[0] = {},
) {
  const store = createMemoryExtractionSessionStore(options);
  return {
    ...store,
    async create(input: Parameters<typeof store.create>[0]) {
      const session = await store.create(input);
      if (session.toolContractVersion === 1) return session;
      const db = new DatabaseSync(new PragmaPaths(options).memoryExtractionSessions());
      try {
        const row = db
          .prepare("SELECT state_json FROM sessions WHERE key = ?")
          .get(session.key) as { state_json: string };
        const state = State.parse(JSON.parse(row.state_json));
        state.toolContractVersion = 1;
        markInlineRead(state);
        db.prepare("UPDATE sessions SET state_json = ? WHERE key = ?").run(
          JSON.stringify(state),
          session.key,
        );
      } finally {
        db.close();
      }
      return await store.create(input);
    },
  };
}
