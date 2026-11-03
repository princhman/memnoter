import type { Env as SyncEnv } from "../src/env";

declare global {
  namespace Cloudflare {
    interface Env extends SyncEnv {}
  }
}
