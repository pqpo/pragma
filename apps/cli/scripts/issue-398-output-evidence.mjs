import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";
import {
  createRuntimeTokenCounter,
  paginateIntegrationItems,
  readMissionContentValue,
} from "@pragma/local-host";

const baseline = "1cec48eba13590094c6ac0ddcd61dad3d01598ba";
const cliRoot = fileURLToPath(new URL("../", import.meta.url));
const repository = fileURLToPath(new URL("../../../", import.meta.url));
await mkdir(join(cliRoot, ".release"), { recursive: true });
const temporary = await mkdtemp(join(cliRoot, ".release", "398-evidence-"));
const counter = createRuntimeTokenCounter();
try {
  if (!(await counter.load())) throw new Error("The shared tokenizer could not load.");
  const bundle = async (name, contents, resolveDir) => {
    const path = join(temporary, `${name}.mjs`);
    await build({
      stdin: { contents, resolveDir, sourcefile: `${name}.ts`, loader: "ts" },
      outfile: path,
      bundle: true,
      packages: "external",
      platform: "node",
      format: "esm",
      logLevel: "silent",
      banner: {
        js: 'import {createRequire} from "node:module"; const require=createRequire(import.meta.url);',
      },
    });
    return await import(pathToFileURL(path).href);
  };
  const before = await bundle(
    "before",
    execFileSync("git", ["show", `${baseline}:apps/cli/src/presenters/index.ts`], {
      cwd: repository,
      encoding: "utf8",
    }),
    join(cliRoot, "src", "presenters"),
  );
  const after = await bundle(
    "after",
    'export * from "./index.ts";',
    join(cliRoot, "src", "presenters"),
  );
  const missionId = "11111111-1111-4111-8111-111111111111";
  const executionId = "22222222-2222-4222-8222-222222222222";
  const queryHash = createHash("sha256")
    .update(JSON.stringify({ command: "mission.list", filters: [] }))
    .digest("hex");
  const oldCursor = `pragma.cli.cursor.v2.${Buffer.from(JSON.stringify({ offset: 1, command: "mission.list", queryHash })).toString("base64url")}`;
  const items = [
    {
      id: missionId,
      title: "Review repository",
      status: "succeeded",
      updatedAt: "2026-10-14T00:00:00.000Z",
      workspace: { canonicalPath: "/work" },
    },
    {
      id: executionId,
      title: "Another task",
      status: "queued",
      updatedAt: "2026-10-14T00:00:00.000Z",
    },
  ];
  const cursor = paginateIntegrationItems(items, { limit: 1 }, "mission.list").nextCursor;
  const measure = (text) => {
    const count = counter.countText(text);
    if (count.source !== "tokenizer") throw new Error("Exact tokenizer measurement unavailable.");
    return { bytes: Buffer.byteLength(text), tokens: count.tokens };
  };
  const normalize = (value) => {
    if (Array.isArray(value)) return value.map(normalize);
    if (value === null || typeof value !== "object") return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "durationMs"
          ? 0
          : ["startedAt", "completedAt", "emittedAt"].includes(key)
            ? "2026-10-14T00:00:00.000Z"
            : key === "eventId"
              ? executionId
              : normalize(item),
      ]),
    );
  };
  const output = (presenter, command, result, format = "text", view = "full") => {
    const lines = [];
    presenter.presentSuccess(
      {
        io: { writeStdout: (s) => lines.push(s), writeStderr: () => {} },
        format,
        outputView: view,
        ...(command === "mission.list"
          ? { continuationCommand: (cursor) => `pragma mission list --limit 1 --cursor ${cursor}` }
          : {}),
        requestId: missionId,
        command,
        cliVersion: "fixture",
        startedAt: new Date(),
      },
      result,
    );
    return format === "text"
      ? lines.join("")
      : lines.map((line) => JSON.stringify(normalize(JSON.parse(line))) + "\n").join("");
  };
  const runOutput = (presenter, outcome) => {
    const lines = [];
    presenter.presentRunOutcome(
      {
        io: { writeStdout: (s) => lines.push(s), writeStderr: () => {} },
        format: "text",
        requestId: missionId,
        command: "expert.run",
        cliVersion: "fixture",
        startedAt: new Date(),
      },
      outcome,
    );
    return lines.join("");
  };
  const oldList = { items: items.slice(0, 1), nextCursor: oldCursor };
  const newList = { items: items.slice(0, 1), nextCursor: cursor };
  const result = {
    schemaVersion: "pragma.mission-result/v1",
    missionId,
    executionId,
    status: "succeeded",
    available: true,
    result: "Reviewed the repository.\nNo blocking issues.",
  };
  const interaction = {
    schemaVersion: "pragma.human-interaction/v1",
    kind: "request",
    missionId,
    executionId,
    interactionId: "choose-region",
    sensitive: false,
    interaction: {
      kind: "question",
      prompt: "Choose the deployment region",
      questions: [
        {
          header: "Region",
          question: "Which region?",
          kind: "single_choice",
          options: [
            { label: "West", value: "us-west", description: "Western region" },
            { label: "East", value: "us-east", description: "Eastern region" },
          ],
        },
      ],
    },
  };
  const waiting = { status: "input_required", missionId, executionId, interaction };
  const response = {
    missionId,
    operation: { missionId, requestId: executionId, operationId: executionId, state: "applied" },
  };
  const boardText = Array.from({ length: 400 }, (_, i) => `第 ${i} 行 😀: alpha beta gamma\n`).join(
    "",
  );
  const fingerprint = `sha256:${createHash("sha256").update(boardText).digest("hex")}`;
  const boardPage = (start) => {
    const page = readMissionContentValue(
      missionId,
      { source: "result", id: executionId, fingerprint, start, maxBytes: 8000 },
      boardText,
    );
    return {
      schemaVersion: "pragma.board-read/v1",
      missionId,
      item: {
        id: "report.md",
        namespace: "mission-board",
        description: "Review report",
        trigger: "manual",
        priority: "normal",
        revision: "fixture",
        sizeBytes: Buffer.byteLength(boardText),
        content: page.content,
        contentRange: page.contentRange,
      },
    };
  };
  const first = boardPage(0);
  const second = boardPage(first.item.contentRange.nextStart);
  if (
    second.item.contentRange.nextStart !== undefined ||
    first.item.content + second.item.content !== boardText
  )
    throw new Error("Board fixture must reconstruct exactly in two pages.");
  const workflow = (oldOutputs, newOutputs, explanation) => ({
    before: { calls: oldOutputs.length, ...measure(oldOutputs.join("")) },
    after: { calls: newOutputs.length, ...measure(newOutputs.join("")) },
    explanation,
  });
  const report = {
    baseline,
    tokenizer: "@pragma/core RuntimeTokenCounter (gpt-tokenizer o200k_base)",
    methodology:
      "Fixed semantic fixtures rendered through the baseline and current presenters. Synthetic timestamps/event IDs normalized for repeatability. Calls count the explicitly scripted paths to acquire the same task/answer/range facts; this is an output benchmark, not native Runtime performance.",
    cursor: {
      before: { characters: oldCursor.length, ...measure(oldCursor) },
      after: { characters: cursor.length, ...measure(cursor) },
    },
    continuation: {
      before: measure(
        `Next cursor: ${oldCursor}\nContinue: pragma mission list --limit 1 --cursor ${oldCursor}\n`,
      ),
      after: measure(`Continue: pragma mission list --limit 1 --cursor ${cursor}\n`),
    },
    workflows: {
      findTaskAndResult: workflow(
        [
          output(before, "mission.list", oldList),
          output(before, "mission.list", oldList, "json"),
          output(before, "mission.get", result),
        ],
        [
          output(after, "mission.list", newList),
          output(after, "mission.get", {
            ...result,
            schemaVersion: "pragma.mission-result/v2",
            title: items[0].title,
          }),
        ],
        "Baseline text list has no title, so the scripted caller repeats the list as JSON to identify the task; the current title removes that call.",
      ),
      waitAnswerContinue: workflow(
        [
          runOutput(before, waiting),
          output(
            before,
            "mission.get",
            {
              schemaVersion: "pragma.mission-result/v1",
              missionId,
              executionId,
              status: "waiting",
              available: false,
              interaction,
            },
            "json",
          ),
          output(before, "mission.respond", response, "json"),
        ],
        [runOutput(after, waiting), output(after, "mission.respond", response, "json", "compact")],
        "Baseline text omits the question/choices and requires a result query before submitting the same response. Current text supplies them; response ownership/authorization remains unchanged.",
      ),
      readLargeBoard: workflow(
        [
          output(before, "mission.board.read", first),
          output(before, "mission.board.read", first, "json"),
          output(before, "mission.board.read", second, "json"),
        ],
        [output(after, "mission.board.read", first), output(after, "mission.board.read", second)],
        "The baseline caller repeats the first read as JSON to discover truncation and the next byte offset. Current text carries the range/continuation, and both paths reconstruct identical UTF-8 content.",
      ),
    },
    jsonlQuery: {
      before: measure(output(before, "mission.get", result, "jsonl")),
      after: measure(output(after, "mission.get", result, "jsonl", "compact")),
    },
  };
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2) + "\n");
  else process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  counter.dispose();
  await rm(temporary, { recursive: true, force: true });
}
