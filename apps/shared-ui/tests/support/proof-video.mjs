// PROOF_DIR=<dir>: every browser page a test opens records a video into <dir>.
// For showing a fix to the user (upload, then delete); never commit the videos.
import { mkdirSync } from 'node:fs';
import { chromium, webkit } from 'playwright';

const dir = process.env.PROOF_DIR;
if (dir) {
  mkdirSync(dir, { recursive: true });
  const record = options => ({ ...options, recordVideo: { dir, size: options?.viewport ?? { width: 1280, height: 800 }, ...options?.recordVideo } });
  for (const type of [chromium, webkit]) {
    const launch = type.launch.bind(type);
    type.launch = async options => {
      const browser = await launch(options);
      const newContext = browser.newContext.bind(browser);
      browser.newContext = options => newContext(record(options));
      const newPage = browser.newPage.bind(browser);
      browser.newPage = options => newPage(record(options));
      return browser;
    };
  }
}
