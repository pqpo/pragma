import { HealthResponseSchema, type HealthResponse } from "@pragma/shared";

export interface PragmaClient {
  getHealth(): Promise<HealthResponse>;
}

export interface ServerClientOptions {
  baseUrl?: string;
}

export class ServerClient implements PragmaClient {
  readonly #baseUrl: string;

  constructor(options: ServerClientOptions = {}) {
    this.#baseUrl = options.baseUrl ?? "http://localhost:3001";
  }

  async getHealth(): Promise<HealthResponse> {
    const response = await fetch(`${this.#baseUrl}/health`);

    if (!response.ok) {
      throw new Error(`Health request failed with status ${response.status}`);
    }

    return HealthResponseSchema.parse(await response.json());
  }
}
