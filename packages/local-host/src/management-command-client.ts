import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  ManagementCommandResultSchema,
  type ManagementCommandRequest,
  type ManagementCommandResult,
  managementCommandError,
} from "@pragma/shared/integration";

export const MANAGEMENT_COMMAND_ENDPOINT_ENV = "PRAGMA_EXECUTION_COMMAND_ENDPOINT";

/** Agent mode never falls back to a privileged, independently composed user Host. */
export async function callManagementCommand(input: {
  readonly request: ManagementCommandRequest;
  readonly endpoint?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ManagementCommandResult> {
  if (input.signal?.aborted)
    throw managementCommandError("INTERRUPTED", "The command was interrupted.");
  const endpoint = input.endpoint;
  if (endpoint === undefined)
    throw managementCommandError(
      "DEPENDENCY_UNAVAILABLE",
      "No active Execution command endpoint. Run this command inside an authorized Pragma Mission.",
    );
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw managementCommandError("PERMISSION_DENIED", "Invalid Execution command endpoint.");
  }
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !/^\/sessions\/[A-Za-z0-9_-]{43}\/mcp$/u.test(url.pathname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw managementCommandError(
      "PERMISSION_DENIED",
      "Execution command endpoints must be private loopback routes.",
    );
  const client = new Client({ name: "pragma-execution-cli", version: "1" });
  const disconnected = new AbortController();
  client.onerror = () => disconnected.abort();
  client.onclose = () => disconnected.abort();
  const signal =
    input.signal === undefined
      ? disconnected.signal
      : AbortSignal.any([input.signal, disconnected.signal]);
  try {
    await client.connect(new StreamableHTTPClientTransport(url), { signal });
    const server = client.getServerVersion();
    if (server?.name !== "Pragma private execution commands" || server.version !== "1")
      throw managementCommandError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        "The command client and Host protocol do not match. Update Pragma and start a new Mission.",
      );
    const result = await client.callTool(
      { name: "execute_command", arguments: input.request },
      { signal, timeout: 30 * 60 * 1000 },
    );
    const parsed = ManagementCommandResultSchema.safeParse(result.structuredContent);
    if (!parsed.success)
      throw managementCommandError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        "The Host returned an incompatible command result. Update Pragma and start a new Mission.",
      );
    if (
      parsed.data.requestId !== input.request.requestId ||
      parsed.data.command !== input.request.command
    )
      throw managementCommandError(
        "PROTOCOL_VERSION_UNSUPPORTED",
        "The command result does not match its request.",
      );
    return parsed.data;
  } catch (error) {
    if (input.signal?.aborted)
      throw managementCommandError("INTERRUPTED", "The command was interrupted.");
    if (typeof error === "object" && error !== null && "schemaVersion" in error) throw error;
    // Never include the transport URL (which is a bearer credential) in diagnostics.
    throw managementCommandError(
      "DEPENDENCY_UNAVAILABLE",
      "The Execution command channel is unavailable or revoked. Resume the owning Mission and retry the original requestId.",
    );
  } finally {
    // Cleanup must not replace the structured result or expose a transport bearer URL.
    await client.close().catch(() => undefined);
  }
}
