import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import console from "node:console";
import { createSqliteExecutionStore } from "../dist/index.js";
import { acquireHostStoragePool } from "../dist/host-storage-pool.js";
import { PragmaPaths } from "@pragma/core";
const template = JSON.parse(
  await readFile(new URL("../test/fixtures/execution-file-v12.json", import.meta.url), "utf8"),
);
const results = [];
const percentile = (values, fraction) =>
  values.length < 20
    ? null
    : values.toSorted((a, b) => a - b)[Math.ceil(values.length * fraction) - 1];
for (const history of [500, 5000, 50000]) {
  const home = await mkdtemp(join(tmpdir(), "pragma-preparation-benchmark-"));
  const paths = new PragmaPaths({ pragmaHome: home });
  const store = createSqliteExecutionStore({ pragmaHome: home });
  const pool = acquireHostStoragePool();
  try {
    const probes = Array.from({ length: 4 }, (_, index) => `probe-${index}`);
    for (const id of probes)
      await store.create(
        { ...template.execution, executionId: id, version: 0, lastAppliedSequence: 0 },
        template.invocations[0],
      );
    await pool.clients[0].call("get", probes[0], undefined, false, home);
    await mkdir(paths.executionRoot("current"), { recursive: true });
    for (const [key, file] of [
      ["execution", paths.executionState("current")],
      ["invocations", paths.executionInvocations("current")],
      ["agents", paths.executionAgents("current")],
      ["contexts", paths.executionContexts("current")],
      ["commits", paths.executionCommits("current")],
    ])
      await writeFile(
        file,
        JSON.stringify(
          key === "execution" ? { ...template[key], lastAppliedSequence: history } : template[key],
        ),
      );
    const base = template.events[0];
    await writeFile(
      paths.executionEvents("current"),
      Array.from({ length: history }, (_, index) =>
        JSON.stringify({
          ...base,
          eventId: index === 0 ? base.eventId : `synthetic-${index}`,
          cursor: { executionId: "current", sequence: index + 1 },
        }),
      ).join("\n") + "\n",
    );
    let done = false;
    const started = performance.now();
    const preparation = store.prepareOwner("current").finally(() => {
      done = true;
    });
    const control = [];
    while (!done && control.length < 200) {
      const start = performance.now();
      await Promise.all(probes.map((id) => store.get(id)));
      control.push(performance.now() - start);
    }
    await preparation;
    const preparationMs = performance.now() - started;
    const ready = [];
    for (let i = 0; i < 20; i++) {
      const start = performance.now();
      await store.get("current");
      ready.push(performance.now() - start);
    }
    results.push({
      history,
      preparedOwners: 4,
      preparationMs,
      foregroundFourOwnerReadDuringPreparation: {
        samples: control.length,
        p50: percentile(control, 0.5),
        p95: percentile(control, 0.95),
        max: Math.max(...control),
      },
      convertedOwnerRead: {
        samples: ready.length,
        p50: percentile(ready, 0.5),
        p95: percentile(ready, 0.95),
      },
    });
  } finally {
    await store.close();
    await pool.close();
    await rm(home, { recursive: true, force: true });
  }
}
console.log(
  JSON.stringify(
    {
      schemaVersion: "pragma.storage-preparation-benchmark/v1",
      observedAt: new Date().toISOString(),
      cpu: cpus()[0]?.model,
      source:
        "Synthetic expansion of the actual v12 file-writer fixture; four prepared Execution owners, no model or renderer. Read samples are four-owner batches; fewer than 20 samples omit percentiles. Not end-to-end Mission acceptance.",
      results,
    },
    null,
    2,
  ),
);
