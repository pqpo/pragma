import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

const expert = await createExampleExpert("queued", "Process prompts in order.");
const session = await createExampleApp().experts.createSession(expert);
const first = await session.prompt("Write a short plan.", { requestId: "first" });
const second = await session.prompt("Summarize the plan.", { requestId: "second" });
await session.prompt("Focus on risks.", { requestId: "steer", mode: "steer" }).catch(console.error);
console.log(await first.result, await second.result);
await session.close();
