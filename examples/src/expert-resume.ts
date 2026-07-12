import { createExampleApp, createExampleExpert } from "./example-kit.ts";

const expert = await createExampleExpert("resumable", "Maintain conversational context.");
const app = createExampleApp();
const created = await app.experts.createSession(expert);
await (
  await created.prompt("Remember the word amber.", { requestId: "remember" })
).result;
const resumed = await app.experts.resumeSession(expert, { sessionId: created.sessionId });
console.log(await (await resumed.prompt("Which word?", { requestId: "continue" })).result);
await resumed.close();
