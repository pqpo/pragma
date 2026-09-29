import { Worker } from "node:worker_threads";
import { z } from "zod";
import { EmbeddingProfileSchema, type EmbeddingProfile } from "./profile.ts";
export const VectorHitSchema = z.object({
  memoryId: z.string(),
  revision: z.number(),
  segmentId: z.string(),
  fieldPath: z.string(),
  textHash: z.string(),
  start: z.number(),
  end: z.number(),
  similarity: z.number(),
});
export type VectorHit = z.infer<typeof VectorHitSchema>;
export async function createMemoryVectorIndex(options: {
  path: string;
  readOnly?: boolean;
  workerUrl?: URL;
}) {
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const workerUrl = options.workerUrl ?? new URL(`./vector-worker.${extension}`, import.meta.url);
  const worker = new Worker(workerUrl, {
    workerData: { path: options.path, readOnly: options.readOnly ?? false },
    ...(workerUrl.pathname.endsWith(".ts")
      ? { execArgv: [...process.execArgv, "--import", "tsx"] }
      : {}),
  });
  let serial = 0,
    closed = false;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  let failure: Error | undefined;
  const ready = new Promise<void>((resolve, reject) => {
    worker.on("message", (message: unknown) => {
      const parsed = z
        .object({
          ready: z.boolean().optional(),
          id: z.number().optional(),
          ok: z.boolean().optional(),
          value: z.unknown().optional(),
          code: z.string().optional(),
        })
        .safeParse(message);
      if (!parsed.success) return;
      const value = parsed.data;
      if (value.ready) {
        resolve();
        return;
      }
      if (value.id === undefined) return;
      const request = pending.get(value.id);
      if (request === undefined) return;
      pending.delete(value.id);
      if (value.ok) request.resolve(value.value);
      else request.reject(new Error(value.code ?? "embedding_index_unavailable"));
    });
    const fail = (error: Error) => {
      failure = error;
      reject(error);
      for (const request of pending.values()) request.reject(error);
      pending.clear();
    };
    worker.on("error", (error) =>
      fail(
        new Error(
          error instanceof Error && /^embedding_[a-z_]+$/u.test(error.message)
            ? error.message
            : "embedding_worker_unavailable",
        ),
      ),
    );
    worker.on("exit", () => {
      if (!closed) fail(new Error("embedding_worker_unavailable"));
    });
  });
  await ready;
  const call = async (
    operation: string,
    payload: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> => {
    if (closed || failure !== undefined) throw failure ?? new Error("embedding_index_unavailable");
    if (pending.size >= 16) throw new Error("embedding_search_busy");
    signal?.throwIfAborted();
    const id = ++serial,
      cancel = new SharedArrayBuffer(4);
    return await new Promise((resolve, reject) => {
      const abort = () => {
        Atomics.store(new Int32Array(cancel), 0, 1);
        pending.delete(id);
        reject(new Error("embedding_cancelled"));
      };
      signal?.addEventListener("abort", abort, { once: true });
      const finish = (fn: (value: unknown) => void, value: unknown) => {
        signal?.removeEventListener("abort", abort);
        fn(value);
      };
      pending.set(id, {
        resolve: (value) => finish(resolve, value),
        reject: (error) => {
          signal?.removeEventListener("abort", abort);
          reject(error);
        },
      });
      worker.postMessage({ id, operation, payload, cancel });
    });
  };
  return {
    call,
    async binding(): Promise<
      { profile: EmbeddingProfile; dimensions: number; responseModel: string } | undefined
    > {
      const raw = await call("binding", {});
      if (raw === null) return undefined;
      const value = z
        .object({ profileJson: z.string(), dimensions: z.number(), responseModel: z.string() })
        .parse(raw);
      return {
        profile: EmbeddingProfileSchema.parse(JSON.parse(value.profileJson)),
        dimensions: value.dimensions,
        responseModel: value.responseModel,
      };
    },
    async search(
      input: {
        generation: string;
        module: "episodic" | "semantic";
        vector: Float32Array;
        allowed: readonly { id: string; revision: number }[];
        limit: number;
      },
      signal: AbortSignal,
    ): Promise<VectorHit[]> {
      return z.array(VectorHitSchema).parse(await call("search", input, signal));
    },
    async close() {
      if (closed) return;
      try {
        await call("close", {});
      } finally {
        closed = true;
        await worker.terminate();
      }
    },
  };
}
export type MemoryVectorIndex = Awaited<ReturnType<typeof createMemoryVectorIndex>>;
