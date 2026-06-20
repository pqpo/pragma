import { buildServer } from "./app.ts";

const app = buildServer();
const port = 3001;

await app.listen({ host: "0.0.0.0", port });
