import type { ExpertToolsMcpSessionRegistration } from "@pragma/core";

export function appendCodexExecutionMcpConfig(
  baseArgs: readonly string[],
  registration: Pick<ExpertToolsMcpSessionRegistration, "id" | "url">,
): readonly string[] {
  const serverKey = `mcp_servers.${registration.id}`;

  return [
    ...baseArgs,
    "-c",
    `${serverKey}.url=${JSON.stringify(registration.url)}`,
    "-c",
    `${serverKey}.enabled=true`,
    "-c",
    `${serverKey}.required=true`,
    "-c",
    `${serverKey}.default_tools_approval_mode="approve"`,
  ];
}
