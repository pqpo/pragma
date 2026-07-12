import type { AgentMessageUsage } from "@pragma/core";

export function formatConsoleUsage(usage: AgentMessageUsage | undefined): string {
  if (usage === undefined) {
    return "\n总 Usage: 暂无可用数据。";
  }

  const cacheWrite1h =
    usage.cacheWrite1h === undefined ? "" : ` · cacheWrite1h=${formatInteger(usage.cacheWrite1h)}`;

  return [
    "\n总 Usage:",
    `  input=${formatInteger(usage.input)} · output=${formatInteger(usage.output)}`,
    `  cacheRead=${formatInteger(usage.cacheRead)} · cacheWrite=${formatInteger(usage.cacheWrite)}${cacheWrite1h}`,
    `  totalTokens=${formatInteger(usage.totalTokens)} · cost=$${usage.cost.total.toFixed(6)}`,
  ].join("\n");
}

function formatInteger(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
