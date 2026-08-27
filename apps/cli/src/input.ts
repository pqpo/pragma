import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { stdin } from "node:process";

export const MAX_RUN_INPUT_BYTES = 4 * 1024 * 1024;

export class CliInputError extends Error {
  constructor(
    readonly reason: "missing" | "not_file" | "too_large" | "invalid_utf8" | "empty",
    message: string,
  ) {
    super(message);
    this.name = "CliInputError";
  }
}

export async function readBoundedUtf8(
  source: string,
  readStdin?: (() => Promise<Uint8Array>) | undefined,
): Promise<string> {
  const bytes = source === "-" ? await readStdinBytes(readStdin) : await readFileBytes(source);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new CliInputError("invalid_utf8", "Input is not valid UTF-8.");
  }
  if (text.trim() === "") throw new CliInputError("empty", "Input must not be empty.");
  return text;
}

export async function readBoundedJson(
  source: string,
  readStdin?: (() => Promise<Uint8Array>) | undefined,
): Promise<Record<string, unknown>> {
  const text = await readBoundedUtf8(source, readStdin);
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new CliInputError("invalid_utf8", "Input must be valid JSON.");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CliInputError("invalid_utf8", "Input JSON must be an object.");
  }
  return value as Record<string, unknown>;
}

/** Production stdin reader. It counts each chunk and stops the stream at the limit. */
export async function readProcessStdin(): Promise<Uint8Array> {
  return await readBoundedStream(stdin);
}

/** Injectable equivalent used by tests and other Node compositions. */
export function createBoundedStdinReader(
  source: AsyncIterable<Uint8Array | string> & { readonly destroy?: (() => void) | undefined },
): () => Promise<Uint8Array> {
  return async () => await readBoundedStream(source);
}

async function readStdinBytes(
  readStdin: (() => Promise<Uint8Array>) | undefined,
): Promise<Uint8Array> {
  if (readStdin === undefined) {
    throw new CliInputError("missing", "No stdin reader is configured for --input -.");
  }
  const bytes = await readStdin();
  if (bytes.byteLength > MAX_RUN_INPUT_BYTES) {
    throw new CliInputError("too_large", `Input exceeds the ${MAX_RUN_INPUT_BYTES}-byte limit.`);
  }
  return bytes;
}

async function readBoundedStream(
  source: AsyncIterable<Uint8Array | string> & { readonly destroy?: (() => void) | undefined },
): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of source) {
      const bytes = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_RUN_INPUT_BYTES) {
        source.destroy?.();
        throw new CliInputError("too_large", inputTooLargeMessage());
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError("missing", "Input could not be read from stdin.");
  }
  return Buffer.concat(chunks, size);
}

function inputTooLargeMessage(): string {
  return `Input exceeds the ${MAX_RUN_INPUT_BYTES}-byte limit.`;
}

async function readFileBytes(path: string): Promise<Uint8Array> {
  let file;
  try {
    file = await stat(path);
  } catch {
    throw new CliInputError("missing", `Input file not found: ${path}.`);
  }
  if (!file.isFile()) throw new CliInputError("not_file", `Input is not a file: ${path}.`);
  if (file.size > MAX_RUN_INPUT_BYTES) {
    throw new CliInputError("too_large", `Input exceeds the ${MAX_RUN_INPUT_BYTES}-byte limit.`);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of createReadStream(path)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_RUN_INPUT_BYTES) {
        throw new CliInputError(
          "too_large",
          `Input exceeds the ${MAX_RUN_INPUT_BYTES}-byte limit.`,
        );
      }
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof CliInputError) throw error;
    throw new CliInputError("missing", `Input file could not be read: ${path}.`);
  }
  return Buffer.concat(chunks, size);
}
