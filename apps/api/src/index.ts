import Fastify from "fastify";
import cors from "@fastify/cors";
import { createLogger, loadConfig } from "@global-link/shared";
import authPlugin from "./authPlugin.js";
import { registerMailboxRoutes } from "./routes/mailboxes.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerMeRoutes } from "./routes/me.js";

const logger = createLogger("api");
const env = loadConfig();

async function main(): Promise<void> {
  const app = Fastify({ logger: false });
  await app.register(cors, { origin: true });
  await app.register(authPlugin);

  app.get("/health", async () => ({ ok: true }));

  await registerMailboxRoutes(app);
  await registerThreadRoutes(app);
  await registerMeRoutes(app);

  await app.listen({ port: env.API_PORT, host: "0.0.0.0" });
  logger.info({ port: env.API_PORT }, "API listening");
}

main().catch((err) => {
  logger.error({ err }, "api failed to start");
  process.exit(1);
});
