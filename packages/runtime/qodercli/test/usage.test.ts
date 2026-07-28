import { describe, expect, it } from "vitest";
import type { SDKResultError, SDKResultSuccess } from "@qoder-ai/qoder-agent-sdk";

import {
  deriveQoderContextWindowUsage,
  mapQoderUsage,
  requireSuccessfulQoderResult,
} from "../src/session.ts";

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

  it("derives context usage from the CLI-reported ratio", () => {
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
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        context_usage_ratio: 0.125,
        inference_geo: "",
        input_tokens: 0,
        iterations: [],
        output_tokens: 0,
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "",
        speed: "",
      },
      modelUsage: {},
      permission_denials: [],
      uuid: "result",
      session_id: "session",
    } satisfies SDKResultSuccess;

    expect(deriveQoderContextWindowUsage(result, 200_000)).toMatchObject({
      usedTokens: 25_000,
      contextWindowTokens: 200_000,
      percent: 12.5,
      measurement: "derived",
    });
  });

  it("preserves a structured Qoder failure when the process also exits unsuccessfully", () => {
    const result = {
      type: "result",
      subtype: "error_during_execution",
      duration_ms: 10,
      duration_api_ms: 8,
      is_error: true,
      num_turns: 1,
      stop_reason: null,
      total_cost_usd: 0,
      usage: {
        cache_creation: {
          ephemeral_1h_input_tokens: 0,
          ephemeral_5m_input_tokens: 0,
        },
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        inference_geo: "",
        input_tokens: 0,
        iterations: [],
        output_tokens: 0,
        server_tool_use: { web_fetch_requests: 0, web_search_requests: 0 },
        service_tier: "",
        speed: "",
      },
      modelUsage: {},
      permission_denials: [],
      errors: ["Qoder quota is exhausted."],
      uuid: "result",
      session_id: "session",
    } satisfies SDKResultError;

    expect(() =>
      requireSuccessfulQoderResult(
        result,
        new Error("Qoder CLI process exited with code 1"),
        "missing result",
      ),
    ).toThrow("Qoder quota is exhausted.");
  });
});
