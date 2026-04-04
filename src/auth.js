import readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { chromium } from 'playwright';
import {
  getStorageStatePath,
  getCursorAuthStartUrl,
  ensureDirForFile,
} from './env.js';

async function main() {
  const storagePath = getStorageStatePath();
  ensureDirForFile(storagePath);
  const startUrl = getCursorAuthStartUrl();

  console.log('Opening browser. Sign in to Cursor with Google/GitHub (OAuth) in the window.');
  console.log(`Start URL: ${startUrl}`);
  console.log('When you are fully logged in and see your Cursor account, return here.\n');

  const browser = await chromium.launch({
    headless: false,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL?.trim() || undefined,
  });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  } catch (e) {
    await browser.close();
    throw e;
  }

  const rl = readline.createInterface({ input, output });
  await rl.question('Press Enter to save session and close the browser… ');
  rl.close();

  await context.storageState({ path: storagePath });
  console.log(`Saved Playwright storage state to ${storagePath}`);
  await browser.close();
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
