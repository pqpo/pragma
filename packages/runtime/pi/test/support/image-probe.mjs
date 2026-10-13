import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import {
  createAgentSession,
  createReadTool,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";

// Run real SDK preprocessing and provider serialization against a local HTTP model fixture.
// This is also bundled into the isolated release resource smoke.
export async function probePiImages(directory, fixtures) {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
  });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  let received;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(
      `data: ${JSON.stringify({ id: "image-probe", object: "chat.completion.chunk", created: 1, model: "image-probe", choices: [{ index: 0, delta: { role: "assistant", content: "image received" }, finish_reason: null }] })}\n\n` +
        `data: ${JSON.stringify({ id: "image-probe", object: "chat.completion.chunk", created: 1, model: "image-probe", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
        "data: [DONE]\n\n",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  modelRuntime.registerProvider("image-probe", {
    baseUrl,
    api: "openai-completions",
    apiKey: "packaging-test-key",
    models: [
      {
        id: "image-probe",
        name: "Image probe",
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      },
    ],
  });
  const loader = new DefaultResourceLoader({
    cwd: directory,
    agentDir: join(directory, "agent"),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: directory,
    agentDir: join(directory, "agent"),
    modelRuntime,
    model: modelRuntime.getModel("image-probe", "image-probe"),
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory(directory),
    settingsManager,
  });
  try {
    for (const { path, mimeType } of fixtures) {
      const result = await createReadTool(directory).execute("image-read", { path });
      assert.ok(
        result.content.some((block) => block.type === "image" && block.data.length > 0),
        `Pi read dropped ${path}: ${JSON.stringify(result.content)}`,
      );
      assert.ok(!JSON.stringify(result.content).includes("Image omitted"));
      received = undefined;
      await session.prompt("Describe the image", {
        images: [{ type: "image", data: (await readFile(path)).toString("base64"), mimeType }],
      });
      const user = received?.messages?.findLast((message) => message.role === "user");
      assert.ok(
        user?.content.some(
          (block) =>
            block.type === "image_url" && /^data:image\/[^;]+;base64,.+/.test(block.image_url?.url),
        ),
        `Pi prompt dropped ${path}: ${JSON.stringify(user)}`,
      );
      assert.ok(!JSON.stringify(user).includes("Image omitted"));
    }
  } finally {
    session.dispose();
    await new Promise((resolve) => server.close(resolve));
  }
}
