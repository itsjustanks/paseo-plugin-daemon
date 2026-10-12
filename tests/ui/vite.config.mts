import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Most specific first: a bare "@getpaseo/plugin" alias would otherwise rewrite the subpaths too.
export default defineConfig({
  root: here("./"),
  ...(process.env.HOSTS_PREVIEW_CACHE_DIR ? { cacheDir: process.env.HOSTS_PREVIEW_CACHE_DIR } : {}),
  resolve: { alias: [
    { find: "@getpaseo/plugin/client/react-native", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin/client/ui", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin/client", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin/react-native", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin", replacement: here("./plugin.tsx") },
    { find: "react-native", replacement: "react-native-web" },
  ] },
  server: { proxy: process.env.HOSTS_MANAGED_BROWSER_FIXTURE === "1" ? { "/__managed-browser": { target: "http://127.0.0.1:43198", rewrite: (path) => path.replace("/__managed-browser", "") } } : undefined, host: "127.0.0.1", port: 43197, strictPort: true },
});
