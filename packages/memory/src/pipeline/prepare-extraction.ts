import type { MemoryExtractorOptions } from "./extraction-session.ts";

export class MemoryExtractionDeferred extends Error {
  constructor() {
    super("memory_curator_companion_not_ready");
  }
}

/** A claimed delivery prepared without admitting a model. Settlement resumes its owning Module. */
export interface PreparedMemoryExtraction<Input, Result> {
  readonly input: Input;
  readonly options: MemoryExtractorOptions | undefined;
  readonly finished: boolean;
  settle(result: Result): Promise<void>;
  fail(error: unknown): Promise<void>;
  defer(): Promise<void>;
}

export async function prepareMemoryExtraction<Input, Result>(
  run: (
    extract: (input: Input, options?: MemoryExtractorOptions) => Promise<Result>,
  ) => Promise<void>,
): Promise<PreparedMemoryExtraction<Input, Result> | undefined> {
  let ready!: (prepared: PreparedMemoryExtraction<Input, Result> | undefined) => void;
  let failed!: (error: unknown) => void;
  const prepared = new Promise<PreparedMemoryExtraction<Input, Result> | undefined>(
    (resolve, reject) => {
      ready = resolve;
      failed = reject;
    },
  );
  const running = run(
    (input, options) =>
      new Promise<Result>((resolve, reject) => {
        let finished = false;
        ready({
          input,
          options,
          get finished() {
            return finished;
          },
          async settle(result) {
            if (finished) return;
            finished = true;
            resolve(result);
            await running;
          },
          async fail(error) {
            if (finished) return;
            finished = true;
            reject(error);
            await running;
          },
          async defer() {
            if (finished) return;
            finished = true;
            reject(new MemoryExtractionDeferred());
            await running;
          },
        });
      }),
  );
  void running.then(() => ready(undefined), failed);
  return await prepared;
}
