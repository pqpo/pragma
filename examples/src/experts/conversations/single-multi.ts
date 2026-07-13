import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

const expert = await createExampleExpert(
  "conversation",
  "Answer briefly and remember prior turns.",
);
const session = await createExampleApp().experts.createSession(expert);
console.log(await (await session.prompt("Say hello.", { requestId: "hello" })).result);
console.log(await (await session.prompt("What did I ask first?", { requestId: "recall" })).result);
await session.close();
