import Fastify from "fastify";
import { HealthResponseSchema } from "@pragma/shared";

export const buildServer = () => {
  const app = Fastify({
    logger: true,
  });
  app.addHook("onRequest", (_request, reply, done) => {
    reply.header("Access-Control-Allow-Origin", "*");
    done();
  });

  app.get("/health", async () => {
    return HealthResponseSchema.parse({
      service: "server",
      status: "ok",
    });
  });

  return app;
};
