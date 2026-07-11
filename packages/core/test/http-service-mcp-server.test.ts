import { afterEach, describe, expect, it, vi } from "vitest";

import { createHttpServiceMcpServer } from "../src/http-service-mcp-server.ts";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createHttpServiceMcpServer", () => {
  it("maps path and query input to a JSON HTTP tool", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "42", name: "Ada" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const server = createHttpServiceMcpServer({
      name: "Customer API",
      baseUrl: "https://api.example.test/v1",
      auth: { type: "none" },
      tools: [
        {
          name: "get_customer",
          description: "Get a customer.",
          method: "GET",
          path: "/customers/{id}",
          parameters: [
            { name: "id", location: "path", required: true, type: "string" },
            { name: "expand", location: "query", required: false, type: "boolean" },
          ],
        },
      ],
    });

    await expect(server.listTools()).resolves.toEqual([
      expect.objectContaining({ name: "get_customer", inputSchema: expect.any(Object) }),
    ]);
    const result = await server.callTool("get_customer", {
      path: { id: "42" },
      query: { expand: true },
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/v1/customers/42?expand=true",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    expect(result).toMatchObject({
      content: [{ type: "text", text: JSON.stringify({ id: "42", name: "Ada" }) }],
    });
  });

  it("injects encrypted-at-rest credentials only into the outgoing request", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const server = createHttpServiceMcpServer({
      name: "Customer API",
      baseUrl: "https://api.example.test",
      auth: { type: "api_key_header", headerName: "X-API-Key", value: "secret-value" },
      tools: [
        {
          name: "create_customer",
          description: "Create a customer.",
          method: "POST",
          path: "/customers",
          parameters: [],
          bodySchema: { type: "object" },
        },
      ],
    });

    const result = await server.callTool("create_customer", { body: { name: "Ada" } });

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.example.test/customers",
      expect.objectContaining({
        headers: expect.objectContaining({ "X-API-Key": "secret-value" }),
        body: JSON.stringify({ name: "Ada" }),
      }),
    );
    expect(result).toEqual({ content: [{ type: "text", text: "" }] });
  });

  it("returns structured MCP errors for upstream failures and invalid JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('{"error":"slow down"}', { status: 429 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const server = createHttpServiceMcpServer({
      name: "Customer API",
      baseUrl: "https://api.example.test",
      auth: { type: "none" },
      tools: [
        { name: "search", description: "Search.", method: "GET", path: "/search", parameters: [] },
      ],
    });

    await expect(server.callTool("search", {})).resolves.toMatchObject({
      isError: true,
      details: { code: "rate_limited", status: 429 },
    });
    await expect(server.callTool("search", {})).resolves.toMatchObject({
      isError: true,
      details: { code: "invalid_response", status: 200 },
    });
  });
});
