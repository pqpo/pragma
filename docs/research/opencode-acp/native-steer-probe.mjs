import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import assert from "node:assert/strict";
const executablePath = process.argv[2];
const evidencePath = process.argv[3];
if (!executablePath || !evidencePath)
  throw new Error("Usage: node native-steer-probe.mjs /path/to/opencode /path/to/evidence.json");
// Resolve the pinned ESM-only SDK from the workspace that owns it.
const { OpenCode } = await import(
  new URL(
    "../../../packages/runtime/opencode/node_modules/@opencode/client/dist/promise/index.js",
    import.meta.url,
  ).href
);
const { stdout } = await promisify(execFile)(executablePath, ["--version"], { timeout: 5000 });
assert.match(stdout, /(?:^|\s|v)2\.0\.16\b/); // This probe is evidence for this exact native version.
const root = await mkdtemp(join(tmpdir(), "pragma-steer-probe-"));
let native;
const requests = [];
let release;
let hold = false;
const endpoint = createServer(async (req, res) => {
  let body = "";
  for await (const c of req) body += c;
  if (req.url !== "/v1/chat/completions") {
    res.writeHead(404).end();
    return;
  }
  const input = JSON.parse(body);
  requests.push(input);
  if (hold) {
    hold = false;
    await new Promise((r) => (release = r));
  }
  res.writeHead(200, { "content-type": "text/event-stream" });
  const base = { id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1, model: "echo" };
  res.write(
    "data: " +
      JSON.stringify({
        ...base,
        choices: [
          {
            index: 0,
            delta: { role: "assistant", content: "Native probe answer" },
            finish_reason: null,
          },
        ],
      }) +
      "\n\n",
  );
  res.write(
    "data: " +
      JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
      "\n\n",
  );
  res.end("data: [DONE]\n\n");
});
await new Promise((r) => endpoint.listen(0, "127.0.0.1", r));
const portServer = createServer();
await new Promise((r) => portServer.listen(0, "127.0.0.1", r));
const port = portServer.address().port;
await new Promise((r) => portServer.close(r));
const config = {
  model: "pragma_mock/echo",
  providers: {
    pragma_mock: {
      package: "@opencode/ai/providers/openai-compatible",
      settings: { baseURL: `http://127.0.0.1:${endpoint.address().port}/v1`, apiKey: "test" },
      models: { echo: { name: "Echo", limit: { context: 128000, output: 4096 } } },
    },
  },
};
const env = {
  PATH: process.env.PATH,
  OPENCODE_SERVER_PASSWORD: "probe",
  OPENCODE_SERVER_USERNAME: "opencode",
  HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  OPENCODE_TEST_HOME: root,
  OPENCODE_DISABLE_PROJECT_CONFIG: "1",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
  OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
};
await mkdir(join(root, "config", "opencode"), { recursive: true });
const evidence = {
  version: "2.0.16",
  provider: "local synthetic OpenAI-compatible server",
  cases: {},
};
try {
  native = spawn(executablePath, ["serve", "--hostname", "127.0.0.1", "--port", String(port)], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let diagnostic = "";
  native.stderr.on("data", (c) => (diagnostic = (diagnostic + c).slice(-2000)));
  const client = OpenCode.make({
    baseUrl: `http://127.0.0.1:${port}`,
    fetch: (input, init) =>
      fetch(input, {
        ...init,
        signal: AbortSignal.any([
          AbortSignal.timeout(30000),
          ...(init?.signal ? [init.signal] : []),
        ]),
      }),
    headers: { Authorization: "Basic " + Buffer.from("opencode:probe").toString("base64") },
  });
  for (let i = 0; ; i++) {
    try {
      await client.server.info();
      break;
    } catch (e) {
      if (i > 200) throw new Error(diagnostic || e.message);
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  const create = () =>
    client.session.create({
      location: { directory: root },
      permissions: [{ action: "*", resource: "*", effect: "allow" }],
    });
  const first = await create();
  await client.session.prompt({ sessionID: first.id, text: "FIRST" });
  await client.session.wait({ sessionID: first.id });
  const count = requests.length;
  await client.session.synthetic({
    sessionID: first.id,
    text: "LATE_STEER",
    delivery: "steer",
    resume: false,
  });
  await client.session.wait({ sessionID: first.id });
  const pending = await client.session.inbox.list({ sessionID: first.id });
  assert.equal(pending.length, 1);
  assert.equal(requests.length, count);
  await client.session.prompt({ sessionID: first.id, text: "NEXT_TURN" });
  await client.session.wait({ sessionID: first.id });
  assert(requests.slice(count).some((x) => JSON.stringify(x.messages).includes("LATE_STEER")));
  evidence.cases.idleResumeFalse = {
    acceptedWhileIdle: true,
    wokeModel: false,
    pendingBeforeNextTurn: 1,
    consumedByNextTurn: true,
  };
  console.log("idle resume:false leak reproduced");
  const second = await create();
  await client.session.prompt({ sessionID: second.id, text: "FIRST" });
  await client.session.wait({ sessionID: second.id });
  const count2 = requests.length;
  await client.session.synthetic({
    sessionID: second.id,
    text: "LATE_WAKE",
    delivery: "steer",
    resume: true,
  });
  await client.session.wait({ sessionID: second.id });
  assert(requests.slice(count2).some((x) => JSON.stringify(x.messages).includes("LATE_WAKE")));
  evidence.cases.idleResumeTrue = {
    startsNewNativeExecution: true,
    inboxAfterWait: (await client.session.inbox.list({ sessionID: second.id })).length,
  };
  console.log("idle resume:true starts execution");
  const revoked = await create();
  await client.session.prompt({ sessionID: revoked.id, text: "FIRST" });
  await client.session.wait({ sessionID: revoked.id });
  const count3 = requests.length;
  const receipt = await client.session.synthetic({
    sessionID: revoked.id,
    text: "REVOKED_LATE_STEER",
    delivery: "steer",
    resume: false,
  });
  await client.session.inbox.cancel({ sessionID: revoked.id, inboxID: receipt.id });
  assert.equal((await client.session.inbox.list({ sessionID: revoked.id })).length, 0);
  await client.session.prompt({ sessionID: revoked.id, text: "NEXT_AFTER_REVOKE" });
  await client.session.wait({ sessionID: revoked.id });
  assert(
    !requests.slice(count3).some((x) => JSON.stringify(x.messages).includes("REVOKED_LATE_STEER")),
  );
  evidence.cases.revokedIdleSteer = { pendingAfterCancel: 0, observedByLaterModel: false };
  console.log("idle steer cancellation prevents spill");
  const third = await create();
  hold = true;
  await client.session.prompt({ sessionID: third.id, text: "ACTIVE" });
  for (let i = 0; !release; i++) {
    if (i > 200) throw new Error("provider not reached");
    await new Promise((r) => setTimeout(r, 20));
  }
  await client.session.synthetic({
    sessionID: third.id,
    text: "ACTIVE_STEER",
    delivery: "steer",
    resume: false,
  });
  release();
  release = undefined;
  await client.session.wait({ sessionID: third.id });
  const remaining = await client.session.inbox.list({ sessionID: third.id });
  evidence.cases.activeResumeFalse = {
    pendingAfterFinal: remaining.length,
    observedByModel: requests.some((x) => JSON.stringify(x.messages).includes("ACTIVE_STEER")),
  };
  console.log("active final steer probed", JSON.stringify(evidence.cases.activeResumeFalse));
} catch (e) {
  evidence.error = e.message;
  process.exitCode = 1;
  console.log("probe error:", e.message);
} finally {
  release?.();
  native?.kill("SIGTERM");
  if (native)
    await new Promise((r) => {
      if (native.exitCode !== null) return r();
      const timer = setTimeout(() => {
        native.kill("SIGKILL");
        r();
      }, 3000);
      native.once("exit", () => {
        clearTimeout(timer);
        r();
      });
    });
  endpoint.closeAllConnections();
  await new Promise((r) => endpoint.close(r));
  try {
    await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
