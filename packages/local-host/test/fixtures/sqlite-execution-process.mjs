import { createSqliteExecutionStore } from "../../dist/index.js";
import process from "node:process";
import console from "node:console";
const [home, commitId, mode] = process.argv.slice(2);
const store = createSqliteExecutionStore({
  pragmaHome: home,
  canonicalEventFeed:
    mode === "source"
      ? {
          append: async () => {
            throw new Error("offline");
          },
        }
      : undefined,
});
try {
  const result = await store.commit({
    executionId: "execution",
    commitId,
    ...(mode === "source" ? {} : { expectedVersion: 0 }),
    events: [{ eventId: commitId, invocationId: "root", type: "progress", data: 1 }],
  });
  console.log(JSON.stringify({ ok: true, version: result.execution.version }));
} catch (error) {
  console.log(JSON.stringify({ ok: false, name: error.name, message: error.message }));
} finally {
  // Fault injection: leave durable source custody to the parent Host while its
  // delivery fence is held. Do not wait for that fence before simulating a crash.
  if (mode === "source") process.exit(0);
  await store.close();
}
