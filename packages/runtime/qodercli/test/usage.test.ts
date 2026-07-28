import { describe, expect, it } from "vitest";
import type { SDKResultSuccess } from "@qoder-ai/qoder-agent-sdk";

import { mapQoderUsage } from "../src/session.ts";

describe("Qoder usage mapping", () => {
  it("keeps reported input, output, cache-read, and cache-write categories disjoint", () => {
    const result = {
      type: "result",
      subtype: "success",
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: false,
      num_turns: 1,
      result: "done",
      stop_reason: "end_turn",
      total_cost_usd: 0,
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: 2,
          ephemeral_5m_input_tokens: 3,
        },
        cache_creation_input_tokens: 5,
        cache_read_input_tokens: 20,
        inference_geo: "",
        input_tokens: 100,
        iterations: [],
        output_tokens: 30,
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "",
        speed: "",
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "result",
      session_id: "session",
    } satisfies SDKResultSuccess;

    expect(mapQoderUsage(result)).toEqual({
      measurement: "reported",
      input: 100,
      output: 30,
      cacheRead: 20,
      cacheWrite: 5,
      cacheWrite1h: 2,
      totalTokens: 155,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });
  });
});
