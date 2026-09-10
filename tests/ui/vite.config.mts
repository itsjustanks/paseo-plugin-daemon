import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));
// Most specific first: a bare "@getpaseo/plugin" alias would otherwise rewrite the subpaths too.
export default defineConfig({
  root: here("./"),
  resolve: { alias: [
    { find: "@getpaseo/plugin/client/react-native", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin/client/ui", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin/client", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin/react-native", replacement: here("./plugin.tsx") },
    { find: "@getpaseo/plugin", replacement: here("./plugin.tsx") },
    { find: "react-native", replacement: "react-native-web" },
  ] },
  server: { host: "127.0.0.1", port: 43197, strictPort: true },
});
