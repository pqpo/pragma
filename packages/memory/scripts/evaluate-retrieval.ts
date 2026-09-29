import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMemoryVectorIndex } from "../src/retrieval/vector-index.ts";
import { createOpenAIEmbeddingProvider } from "../src/retrieval/embedding.ts";
import { createJevDecisionProvider } from "../src/attention/providers/jev.ts";

// Hand-labelled bilingual plumbing cases. The offline encoder deliberately shares
// a fixed concept vocabulary; its scores are not evidence of production model quality.
const records = [
  {
    id: "sqlite",
    text: "SQLite 写入忙：竞争事务需要退避重试。Concurrent database writes need backoff.",
  },
  {
    id: "auth",
    text: "鉴权失败后轮换凭据，不打印密钥。Unauthorized requests require credential rotation.",
  },
  {
    id: "worker",
    text: "大规模向量扫描放在 worker，避免阻塞界面。Run vector scans off the main thread.",
  },
  {
    id: "conflict",
    text: "语义事实存在冲突，应保留来源并核验。Conflicting facts need source verification.",
  },
  {
    id: "denied",
    text: "鉴权失败 Unauthorized requests require credential rotation.",
    denied: true,
  },
];
const cases = [
  { query: "SQLite", expected: "sqlite", language: "en" },
  { query: "并发写数据库需要退避", expected: "sqlite", language: "zh" },
  { query: "The server rejected my login token", expected: "auth", language: "en" },
  { query: "怎样解决鉴权失败", expected: "auth", language: "zh" },
  { query: "界面被向量计算卡住", expected: "worker", language: "zh" },
  { query: "Keep the UI responsive during similarity search", expected: "worker", language: "en" },
  { query: "两条事实互相矛盾", expected: "conflict", language: "zh" },
  { query: "Which contradictory claim should I trust?", expected: "conflict", language: "en" },
];
const vocabulary = [
  /sqlite|database|数据库|并发|退避/iu,
  /auth|credential|login|token|鉴权|凭据/iu,
  /vector|main thread|responsive|similarity|worker|界面|向量/iu,
  /conflict|contradict|claim|事实|矛盾/iu,
];
const encode = (text: string) => {
  const vector = new Float32Array(vocabulary.map((term) => (term.test(text) ? 1 : 0)));
  const norm = Math.hypot(...vector) || 1;
  return vector.map((value) => value / norm);
};
const live = process.argv.includes("--live");
if (
  live &&
  (!process.env["PRAGMA_EVALUATION_EMBEDDING_KEY"] || !process.env["PRAGMA_EVALUATION_JEV_KEY"])
)
  throw new Error("Live evaluation requires explicit embedding and Jev evaluation keys.");
const root = await mkdtemp(join(tmpdir(), "pragma-retrieval-evaluation-"));
const profile = {
  fingerprint: "evaluation",
  providerId: "evaluation",
  modelId: process.env["PRAGMA_EVALUATION_EMBEDDING_MODEL"] ?? "text-embedding-3-small",
  baseUrl: process.env["PRAGMA_EVALUATION_EMBEDDING_URL"] ?? "https://api.openai.com/v1",
  maxInputTokens: 8192,
  maxBatchInputs: 32,
  maxBatchTokens: 300000,
  projectionVersion: 1 as const,
};
const index = await createMemoryVectorIndex({ path: join(root, "vectors.sqlite") });
try {
  await index.call("ensure", { profile });
  const embedding = live
    ? createOpenAIEmbeddingProvider({
        profile,
        getApiKey: async () => process.env["PRAGMA_EVALUATION_EMBEDDING_KEY"]!,
      })
    : undefined;
  const encoded = embedding
    ? await embedding.embed(
        records.map((record) => record.text),
        AbortSignal.timeout(20_000),
      )
    : undefined;
  for (const [i, record] of records.entries())
    await index.call("replace", {
      generation: "evaluation",
      module: "episodic",
      memoryId: record.id,
      revision: 1,
      dimensions: encoded?.dimensions ?? 4,
      responseModel: encoded?.model ?? "reference-concepts",
      segments: [
        {
          segmentId: "overview",
          fieldPath: "overview",
          start: 0,
          end: record.text.length,
          textHash: record.id,
          vector: encoded?.vectors[i] ?? encode(record.text),
        },
      ],
    });
  const jev = live
    ? createJevDecisionProvider({
        getApiKey: async () => process.env["PRAGMA_EVALUATION_JEV_KEY"]!,
      })
    : undefined;
  const output = [];
  for (const task of cases) {
    const signal = AbortSignal.timeout(20_000);
    const query = embedding
      ? (await embedding.embed([task.query], signal)).vectors[0]!
      : encode(task.query);
    const vectors = await index.search(
      {
        generation: "evaluation",
        module: "episodic",
        vector: query,
        allowed: records
          .filter((record) => !record.denied)
          .map((record) => ({ id: record.id, revision: 1 })),
        limit: 4,
      },
      signal,
    );
    const lexical = records.filter(
      (record) => !record.denied && record.text.toLowerCase().includes(task.query.toLowerCase()),
    );
    const scores = new Map<string, number>();
    for (const ranked of [lexical.map((record) => record.id), vectors.map((hit) => hit.memoryId)])
      ranked.forEach((id, i) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + i + 1)));
    const hybrid = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    let selected: string | undefined;
    if (jev) {
      const judgments = await jev.assessCandidates(
        {
          delta: {
            missionId: "evaluation",
            contextId: "evaluation",
            missionGoal: task.query,
            latestObservation: task.query,
            lastAction: "search",
            trigger: "new_observation",
            concepts: [],
          },
          active: [],
          candidates: hybrid.map((id) => ({
            module: "episodic",
            memoryId: id,
            revision: 1,
            title: id,
            summary: records.find((record) => record.id === id)!.text,
          })),
        },
        signal,
      );
      selected = judgments.sort((a, b) => b.relevance - a.relevance)[0]?.key;
    }
    output.push({
      ...task,
      lexical: lexical[0]?.id ?? null,
      hybrid: hybrid[0],
      jev: selected ?? null,
      authorizedOnly: !vectors.some((hit) => hit.memoryId === "denied"),
    });
  }
  console.log(
    JSON.stringify(
      {
        mode: live
          ? "live embedding + Jev"
          : "offline reference encoder; Jev not run; pipeline validation only",
        cases: output,
        lexicalTop1: output.filter((row) => row.lexical === row.expected).length,
        hybridTop1: output.filter((row) => row.hybrid === row.expected).length,
        jevTop1: live
          ? output.filter((row) => row.jev === `episodic:${row.expected}`).length
          : null,
        total: output.length,
      },
      null,
      2,
    ),
  );
} finally {
  await index.close();
  await rm(root, { recursive: true, force: true });
}
