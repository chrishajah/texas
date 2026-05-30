import path from "node:path";
import { fileURLToPath } from "node:url";
import { createPokerServer } from "./app.js";

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";
const isProduction = process.env.NODE_ENV === "production";
const currentFile = fileURLToPath(import.meta.url);
const currentDir = path.dirname(currentFile);
const clientDist = path.resolve(currentDir, "../../client");

const { app, httpServer } = createPokerServer({
  clientDist: isProduction ? clientDist : undefined
});

if (!isProduction) {
  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    server: {
      middlewareMode: true
    },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

httpServer.listen(port, host, () => {
  console.log(`Texas Hold'em server listening on http://${host}:${port}`);
});
