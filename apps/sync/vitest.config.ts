import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: { AUTH_SECRET: "test-secret", DEV_RETURN_CODE: "1", ADMIN_SECRET: "test-admin", FREE_STORAGE_LIMIT_BYTES: "1000" },
      },
    }),
  ],
});
