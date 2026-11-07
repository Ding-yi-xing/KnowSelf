/**
 * app.ts — createApp(runtime) → Hono 实例
 *
 * 职责：构造 Hono、挂载中间件、挂载 7 个路由组。
 * 中间件顺序：requestLogger → cors → routes。
 * 错误处理：app.onError(onError)。
 */

import { Hono } from "hono";
import type { Runtime } from "./runtime";
import { onError } from "./middleware/error";
import { requestLogger } from "./middleware/logger";
import { corsMiddleware } from "./middleware/cors";
import { chatRoutes } from "./routes/chat";
import { conversationRoutes } from "./routes/conversations";
import { profileRoutes } from "./routes/profile";
import { sourceRoutes } from "./routes/sources";
import { proposalRoutes } from "./routes/proposals";
import { settingsRoutes } from "./routes/settings";
import { systemRoutes } from "./routes/system";
import { templateRoutes } from "./routes/templates";
import { miningRoutes } from "./routes/mining";

export function createApp(runtime: Runtime): Hono {
  const app = new Hono();

  // Error handler (registered first, catches all errors)
  app.onError(onError);

  // Middleware
  app.use("*", requestLogger);
  app.use("*", corsMiddleware);

  // Routes
  app.route("/api/chat", chatRoutes(runtime));
  app.route("/api/conversations", conversationRoutes(runtime));
  app.route("/api/profile", profileRoutes(runtime));
  app.route("/api/sources", sourceRoutes(runtime));
  app.route("/api/proposals", proposalRoutes(runtime));
  app.route("/api/settings", settingsRoutes(runtime));
  app.route("/api/system", systemRoutes(runtime));
  app.route("/api/templates", templateRoutes(runtime));
  app.route("/api/mining", miningRoutes(runtime));

  return app;
}
