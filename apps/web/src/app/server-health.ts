import { HealthResponseSchema, type HealthResponse } from "@pragma/shared";

const DEFAULT_SERVER_BASE_URL = "http://localhost:3001";

export async function getServerHealth(baseUrl = DEFAULT_SERVER_BASE_URL): Promise<HealthResponse> {
  const response = await fetch(`${baseUrl}/health`);

  if (!response.ok) {
    throw new Error(`Health request failed with status ${response.status}`);
  }

  return HealthResponseSchema.parse(await response.json());
}
