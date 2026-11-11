import { register } from 'node:module';
register('./alias-loader.mjs', import.meta.url);
if (process.env.PROOF_DIR) await import('./proof-video.mjs');
