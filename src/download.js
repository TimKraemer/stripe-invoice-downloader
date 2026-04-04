import fs from 'fs';
import path from 'path';
import { chromium } from 'playwright';
import {
  getStorageStatePath,
  getInvoiceMonths,
  getTz,
  getOutputDir,
  isHeadless,
  getCursorBillingUrl,
} from './env.js';

const GERMAN_MONTHS = {
  jan: 0,
  januar: 0,
  feb: 1,
  februar: 1,
  mär: 2,
  märz: 2,
  maerz: 2,
  mrz: 2,
  mar: 2,
  marz: 2,
  apr: 3,
  april: 3,
  mai: 4,
  jun: 5,
  juni: 5,
  jul: 6,
  juli: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  okt: 9,
  oktober: 9,
  nov: 10,
  november: 10,
  dez: 11,
  dezember: 11,
};

function yearMonthInTimeZone(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
  });
  const parts = fmt.formatToParts(date);
  let y;
  let m;
  for (const p of parts) {
    if (p.type === 'year') y = p.value;
    if (p.type === 'month') m = p.value;
  }
  if (!y || !m) {
    throw new Error(`Could not format date in timezone ${tz}`);
  }
  return `${y}-${m}`;
}

/** Parse dates from Stripe / browser locale (EN/DE, etc.). */
function parseInvoiceDateText(text) {
  const t = text.trim();
  if (!t) return null;

  const iso = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (iso) {
    const d = new Date(`${iso[1]}-${iso[2]}-${iso[3]}T12:00:00Z`);
    if (!Number.isNaN(d.getTime())) return d;
  }

  const deNumeric = t.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (deNumeric) {
    const day = Number.parseInt(deNumeric[1], 10);
    const month = Number.parseInt(deNumeric[2], 10) - 1;
    const year = Number.parseInt(deNumeric[3], 10);
    if (month >= 0 && month <= 11 && day >= 1 && day <= 31) {
      const d = new Date(Date.UTC(year, month, day, 12, 0, 0));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  const de = t.match(
    /(\d{1,2})\.\s*([A-Za-zäÄöÖüÜß]+)\.?\s*(\d{4})/i,
  );
  if (de) {
    const day = Number.parseInt(de[1], 10);
    const year = Number.parseInt(de[3], 10);
    const rawMon = de[2].toLowerCase().replace(/\.$/, '');
    const monthIdx = GERMAN_MONTHS[rawMon] ?? GERMAN_MONTHS[rawMon.slice(0, 3)];
    if (monthIdx !== undefined && !Number.isNaN(day) && !Number.isNaN(year)) {
      const d = new Date(Date.UTC(year, monthIdx, day, 12, 0, 0));
      if (!Number.isNaN(d.getTime())) return d;
    }
  }

  const d = new Date(t);
  if (!Number.isNaN(d.getTime())) return d;
  return null;
}

function isLikelyCursorLoginUrl(url) {
  if (url.includes('authenticator.cursor.sh')) return true;
  if (url.includes('/api/auth/login')) return true;
  if (url.includes('cursor.com/sign-in')) return true;
  return false;
}

async function findStripePortalPage(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const p of context.pages()) {
      try {
        const u = p.url();
        if (u.includes('billing.stripe.com')) return p;
      } catch {
        /* closed */
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

async function resolveStripePortalOpener(page) {
  const manageBtn = page.getByRole('button', { name: /manage\s+in\s+stripe/i }).first();
  const manageLink = page.getByRole('link', { name: /manage\s+in\s+stripe/i }).first();
  const directStripe = page.locator('a[href*="billing.stripe.com"]').first();

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const loc of [manageBtn, manageLink, directStripe]) {
      const visible = await loc.isVisible().catch(() => false);
      if (visible) return loc;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function openStripePortalFromCursor(page, context) {
  const opener = await resolveStripePortalOpener(page);
  if (!opener) {
    throw new Error(
      'Could not find "Manage in Stripe" (button or link) or a billing.stripe.com link on the Cursor billing page. Set CURSOR_BILLING_URL=https://cursor.com/dashboard/billing and run with HEADLESS=false.',
    );
  }

  const pageEvt = context.waitForEvent('page', { timeout: 20_000 }).catch(() => null);
  const popupEvt = page.waitForEvent('popup', { timeout: 20_000 }).catch(() => null);
  await opener.click();
  await Promise.race([pageEvt, popupEvt]).catch(() => null);

  let stripePage = await findStripePortalPage(context, 5000);
  if (!stripePage && page.url().includes('billing.stripe.com')) {
    stripePage = page;
  }
  if (!stripePage) {
    stripePage = await findStripePortalPage(context, 115_000);
  }
  if (!stripePage) {
    throw new Error(
      'Could not detect a billing.stripe.com page after opening Stripe from Cursor. Try HEADLESS=false.',
    );
  }
  await stripePage.waitForLoadState('domcontentloaded');
  return stripePage;
}


async function scrollToBottom(stripePage) {
  await stripePage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await stripePage.waitForTimeout(300);
}

async function expandAllInvoiceHistory(stripePage) {
  const moreRe = /mehr\s+anzeigen|mehr\s+laden|weitere|show\s+more|load\s+more/i;

  for (let round = 0; round < 80; round++) {
    await scrollToBottom(stripePage);

    const btn = stripePage.locator('button').filter({ hasText: moreRe }).first();
    const visible = await btn.isVisible().catch(() => false);
    if (!visible) break;

    const before = await stripePage.locator(`a:has(${BILLING_PORTAL_INVOICE_ROW})`).count().catch(() => 0);
    console.log(`    "Mehr anzeigen" round ${round + 1} (${before} rows so far)…`);
    await btn.click({ timeout: 10_000 }).catch(() => {});
    await stripePage.waitForTimeout(2000);
    const after = await stripePage.locator(`a:has(${BILLING_PORTAL_INVOICE_ROW})`).count().catch(() => 0);
    if (after <= before) break;
  }
  await scrollToBottom(stripePage);
}

function absolutizeHref(pageUrl, href) {
  if (!href) return null;
  try {
    return new URL(href, pageUrl).href;
  } catch {
    return null;
  }
}

/** API invoices use `in_…`; hosted pages use `invoice.stripe.com/i/…/live_…`. */
function stripeInvoiceIdFromUrl(abs) {
  const api = abs.match(/(in_[a-zA-Z0-9]+)/);
  if (api) return api[1];
  try {
    const u = new URL(abs);
    const h = u.hostname.toLowerCase();
    if (!h.endsWith('.stripe.com')) return null;
    const parts = u.pathname.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last && last.length > 4) {
      return last.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160);
    }
  } catch {
    /* ignore */
  }
  const fallback = abs.replace(/^https?:\/\//i, '').replace(/[^a-zA-Z0-9_-]/g, '_');
  return fallback.slice(0, 160) || null;
}

/** Stripe billing portal: date lives inside this row inside the invoice `<a>`. */
const BILLING_PORTAL_INVOICE_ROW = '[data-testid="billing-portal-invoice-row"]';

async function invoiceDateTextFromAnchor(link) {
  const row = link.locator(BILLING_PORTAL_INVOICE_ROW).first();
  if (await row.count()) {
    return (await row.innerText()).trim();
  }
  return link.evaluate((el) => {
    let n = el;
    for (let i = 0; i < 12 && n; i++) {
      const text = (n.innerText || '').trim();
      if (text.length > 8) return text;
      n = n.parentElement;
    }
    return (el.innerText || '').trim();
  });
}

async function collectInvoiceEntryHrefs(stripePage) {
  const out = [];
  const seen = new Set();
  const pageBase = stripePage.url();

  let links = stripePage.locator(`a:has(${BILLING_PORTAL_INVOICE_ROW})`);
  let n = await links.count();
  if (n === 0) {
    links = stripePage.locator('a[href*="invoice.stripe.com"]');
    n = await links.count();
  }
  if (n === 0) {
    links = stripePage.locator('a[href*="in_"]');
    n = await links.count();
  }

  for (let i = 0; i < n; i++) {
    const link = links.nth(i);
    const href = await link.getAttribute('href');
    if (!href) continue;
    const abs = absolutizeHref(pageBase, href);
    if (!abs || !/stripe\.com/i.test(abs)) continue;
    const id = stripeInvoiceIdFromUrl(abs);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const cardText = await invoiceDateTextFromAnchor(link);
    out.push({ id, href: abs, cardText });
  }
  return out;
}

async function findInvoicePdfTrigger(detailPage) {
  const textRe = /rechnung\s+herunterladen|download\s+invoice/i;

  const strategies = [
    detailPage.locator('button').filter({ hasText: textRe }),
    detailPage.locator('button.Button--primary').filter({ hasText: textRe }),
    detailPage.locator('a').filter({ hasText: textRe }),
    detailPage.getByRole('button', { name: textRe }),
    detailPage.getByRole('link', { name: textRe }),
  ];

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const loc of strategies) {
      const first = loc.first();
      if ((await first.count()) === 0) continue;
      if (await first.isVisible().catch(() => false)) return first;
    }
    await detailPage.waitForTimeout(150);
  }

  for (const frame of detailPage.frames()) {
    try {
      const u = frame.url();
      if (!u || u === 'about:blank') continue;
    } catch {
      continue;
    }
    for (const loc of [
      frame.locator('button').filter({ hasText: textRe }),
      frame.locator('a').filter({ hasText: textRe }),
    ]) {
      const first = loc.first();
      if ((await first.count()) > 0 && (await first.isVisible().catch(() => false))) return first;
    }
  }

  return null;
}


async function downloadSingleInvoice(context, outputDir, target) {
  const { id: invoiceId, href, ym } = target;
  const label = invoiceId.slice(0, 30);
  const detailPage = await context.newPage();

  try {
    let pdfFileUrl = null;
    const responseHandler = async (resp) => {
      try {
        if (resp.url().includes('invoice_pdf_file_url')) {
          const json = await resp.json();
          const fileUrl = json?.url || json?.file_url || json?.pdf_url;
          if (fileUrl) pdfFileUrl = fileUrl;
        }
      } catch { /* ignore */ }
    };
    detailPage.on('response', responseHandler);

    await detailPage.goto(href, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    const trigger = await findInvoicePdfTrigger(detailPage);
    if (!trigger) {
      console.warn(`  [${label}] ⚠ Kein Download-Button — übersprungen.`);
      return false;
    }

    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ timeout: 15_000 });

    const deadline = Date.now() + 15_000;
    while (!pdfFileUrl && Date.now() < deadline) {
      await detailPage.waitForTimeout(300);
    }
    detailPage.off('response', responseHandler);

    if (!pdfFileUrl) {
      console.warn(`  [${label}] ⚠ Keine PDF-URL erhalten — übersprungen.`);
      return false;
    }

    const resp = await context.request.get(pdfFileUrl);
    const body = await resp.body();
    if (!body || body.length < 100) {
      console.warn(`  [${label}] ⚠ PDF leer — übersprungen.`);
      return false;
    }

    const safeName = `${ym}_${invoiceId}.pdf`.replace(/[/\\?%*:|"<>]/g, '_').slice(0, 200);
    const target2 = path.join(outputDir, safeName);
    fs.writeFileSync(target2, body);
    console.log(`  ✓ [${label}] ${(body.length / 1024).toFixed(0)} KB → ${safeName}`);
    return true;
  } finally {
    await detailPage.close().catch(() => {});
  }
}

async function processStripeInvoicesGermanPortal(stripePage, context, outputDir, wantedMonths, tz) {
  const wanted = new Set(wantedMonths);
  console.log('  Waiting for portal to settle…');
  await stripePage.waitForTimeout(2000);
  console.log('  Expanding invoice history (clicking "Mehr anzeigen")…');
  await expandAllInvoiceHistory(stripePage);

  console.log('  Collecting invoice entry links…');
  const entries = await collectInvoiceEntryHrefs(stripePage);
  console.log(`  Found ${entries.length} invoice link(s).`);
  const targets = [];

  for (const e of entries) {
    const parsed = parseInvoiceDateText(e.cardText);
    if (!parsed) continue;
    const ym = yearMonthInTimeZone(parsed, tz);
    if (!wanted.has(ym)) continue;
    targets.push({ ...e, ym });
  }

  if (entries.length === 0) {
    console.warn(
      'Keine Rechnungs-Zeilen gefunden (erwartet: <a> mit div[data-testid="billing-portal-invoice-row"]). HEADLESS=false, TZ und INVOICE_MONTHS prüfen.',
    );
    return 0;
  }
  if (targets.length === 0) {
    console.warn(
      `${entries.length} Rechnung(en) gefunden, keine im Zeitraum ${[...wanted].join(', ')}. TZ in .env anpassen oder Monate prüfen.`,
    );
    for (const e of entries.slice(0, 8)) {
      const parsed = parseInvoiceDateText(e.cardText);
      const ym = parsed ? yearMonthInTimeZone(parsed, tz) : '(unparsbar)';
      const snippet = e.cardText.replace(/\s+/g, ' ').slice(0, 100);
      console.warn(`  → erkannt: ${ym} | ${snippet}`);
    }
    return 0;
  }

  console.log(`  ${targets.length} invoice(s) match. Downloading in parallel…`);

  const CONCURRENCY = 4;
  let count = 0;

  for (let i = 0; i < targets.length; i += CONCURRENCY) {
    const batch = targets.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((t) => downloadSingleInvoice(context, outputDir, t)),
    );
    for (const r of results) {
      if (r.status === 'fulfilled' && r.value) count += 1;
      if (r.status === 'rejected') console.warn(`  ⚠ ${r.reason?.message || r.reason}`);
    }
  }

  return count;
}

async function withRetries(fn, { attempts = 3, delayMs = 2000 } = {}) {
  let last;
  for (let a = 1; a <= attempts; a++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if (a < attempts) {
        console.warn(`Attempt ${a} failed: ${e.message || e}. Retrying…`);
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
  }
  throw last;
}

async function main() {
  const storagePath = getStorageStatePath();
  if (!fs.existsSync(storagePath)) {
    throw new Error(
      `Missing ${storagePath}. Run "npm run auth" once to capture your Cursor session.`,
    );
  }

  const wantedMonths = getInvoiceMonths();
  const tz = getTz();
  const outputDir = getOutputDir();
  const billingUrl = getCursorBillingUrl();
  fs.mkdirSync(outputDir, { recursive: true });

  const headless = isHeadless();
  console.log(`Months: ${wantedMonths.join(', ')} (TZ=${tz})`);
  console.log(`Output: ${outputDir} headless=${headless}`);

  const browser = await chromium.launch({
    headless,
    channel: process.env.PLAYWRIGHT_CHROME_CHANNEL?.trim() || undefined,
  });

  const context = await browser.newContext({
    storageState: storagePath,
    acceptDownloads: true,
  });

  const page = await context.newPage();

  try {
    console.log('[1/4] Opening Cursor billing page…');
    await withRetries(
      async () => {
        await page.goto(billingUrl, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        console.log(`  → landed on: ${page.url()}`);
        if (isLikelyCursorLoginUrl(page.url())) {
          throw new Error(
            'Cursor sent you to a login page — session expired. Run "npm run auth" again, then retry.',
          );
        }
      },
      { attempts: 2 },
    );

    console.log('[2/4] Searching for "Manage in Stripe" button…');
    const stripePage = await withRetries(() => openStripePortalFromCursor(page, context), {
      attempts: 2,
    });
    console.log(`  → Stripe portal: ${stripePage.url()}`);

    console.log('[3/4] Expanding invoice history + collecting entries…');
    const n = await processStripeInvoicesGermanPortal(
      stripePage,
      context,
      outputDir,
      wantedMonths,
      tz,
    );
    console.log('[4/4] Finished.');
    if (n === 0) {
      console.warn('No PDFs downloaded. Use HEADLESS=false to inspect the Stripe portal.');
    } else {
      console.log(`Done. Downloaded ${n} PDF(s).`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
