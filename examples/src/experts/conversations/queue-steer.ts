import { createExampleApp, createExampleExpert } from "../../support/example-kit.ts";

const expert = await createExampleExpert("queued", "Process prompts in order.");
const session = await createExampleApp().experts.createSession(expert);
const first = await session.prompt("Write a short plan.");
const steering = await session.prompt("Focus on risks.", { mode: "steer" });
const second = await session.prompt("Summarize the plan.");
console.log("Generated request IDs:", {
  first: first.requestId,
  second: second.requestId,
  steering: steering.requestId,
});
console.log("First turn (steered):", await first.result);
console.log("Second turn (queued):", await second.result);
await session.close();
