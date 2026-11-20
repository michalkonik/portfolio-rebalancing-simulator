import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const dataRoot = path.join(repo, "docs", "data");

function serveData(): Plugin {
  return {
    name: "serve-candle-data",
    configureServer(server) {
      server.middlewares.use("/portfolio-rebalancing-simulator/data", (req, res, next) => {
        const raw = decodeURIComponent((req.url ?? "/").split("?")[0]);
        const file = path.normalize(path.join(dataRoot, raw));
        if (!file.startsWith(dataRoot) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
          next();
          return;
        }
        if (file.endsWith(".json")) res.setHeader("Content-Type", "application/json; charset=utf-8");
        else if (file.endsWith(".gz")) res.setHeader("Content-Type", "application/gzip");
        else res.setHeader("Content-Type", "text/plain; charset=utf-8");
        fs.createReadStream(file).pipe(res);
      });
    },
  };
}

export default defineConfig({
  root: path.join(repo, "web"),
  base: "/portfolio-rebalancing-simulator/",
  plugins: [serveData()],
  build: {
    outDir: path.join(repo, "docs"),
    emptyOutDir: false,
    sourcemap: false,
    target: "es2022",
  },
  resolve: {
    alias: {
      "@engine": path.join(repo, "engine"),
    },
  },
  server: {
    fs: { allow: [repo] },
  },
});
