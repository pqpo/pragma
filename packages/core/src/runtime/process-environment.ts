const LOOPBACK_NO_PROXY_HOSTS = ["127.0.0.1", "localhost", "::1"] as const;
const NO_PROXY_VARIABLES = ["NO_PROXY", "no_proxy"] as const;

/**
 * Keep local Runtime HTTP endpoints reachable when the host uses a proxy.
 *
 * Runtime child processes inherit this environment and may use different HTTP
 * client implementations, so both common proxy-variable spellings are kept
 * in sync without changing any other environment values.
 */
export function ensureLoopbackNoProxy(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...environment };
  const merged = appendLoopbackNoProxy(
    NO_PROXY_VARIABLES.map((variable) => result[variable])
      .filter((value): value is string => value !== undefined)
      .join(","),
  );
  for (const variable of NO_PROXY_VARIABLES) result[variable] = merged;
  return result;
}

function appendLoopbackNoProxy(value: string | undefined): string {
  const existing: string[] = [];
  const present = new Set<string>();
  for (const entry of value
    ?.split(",")
    .map((item) => item.trim())
    .filter(Boolean) ?? []) {
    const normalized = entry.toLowerCase();
    if (present.has(normalized)) continue;
    present.add(normalized);
    existing.push(entry);
  }
  const missing = LOOPBACK_NO_PROXY_HOSTS.filter((host) => !present.has(host));
  return [...existing, ...missing].join(",");
}
