import Fastify from "fastify";
import { HealthResponseSchema } from "@expertmesh/contracts";
import { createDatabaseClient } from "@expertmesh/database";

export const buildServer = () => {
  const app = Fastify({
    logger: true
  });
  const database = createDatabaseClient();

  app.addHook("onRequest", (_request, reply, done) => {
    reply.header("Access-Control-Allow-Origin", "*");
    done();
  });

  app.get("/health", async () => {
    void database;

    return HealthResponseSchema.parse({
      service: "server",
      status: "ok"
    });
  });

  return app;
};
