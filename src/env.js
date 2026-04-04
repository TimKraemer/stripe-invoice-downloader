import 'dotenv/config';
import fs from 'fs';
import path from 'path';

const MONTH_RE = /^\d{4}-\d{2}$/;

export function getStorageStatePath() {
  const p = process.env.PLAYWRIGHT_STORAGE_STATE;
  if (!p?.trim()) {
    throw new Error('PLAYWRIGHT_STORAGE_STATE is required (path to save/load auth JSON)');
  }
  return path.resolve(p.trim());
}

export function getInvoiceMonths() {
  const file = process.env.INVOICE_MONTHS_FILE?.trim();
  if (file) {
    const abs = path.resolve(file);
    const content = fs.readFileSync(abs, 'utf8');
    const lines = [];
    for (const line of content.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      lines.push(t);
    }
    return validateMonths(lines);
  }
  const raw = process.env.INVOICE_MONTHS;
  if (!raw?.trim()) {
    throw new Error('INVOICE_MONTHS is required (e.g. 2025-01,2025-02) or set INVOICE_MONTHS_FILE');
  }
  const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return validateMonths(parts);
}

function validateMonths(months) {
  for (const m of months) {
    if (!MONTH_RE.test(m)) {
      throw new Error(`Invalid month "${m}" — use YYYY-MM`);
    }
  }
  if (months.length === 0) {
    throw new Error('No invoice months configured');
  }
  return [...months];
}

export function getTz() {
  return process.env.TZ?.trim() || 'UTC';
}

export function getOutputDir() {
  return path.resolve(process.env.OUTPUT_DIR?.trim() || './invoices');
}

export function isHeadless() {
  const h = process.env.HEADLESS?.trim().toLowerCase();
  if (h === undefined || h === '') return true;
  return h === 'true' || h === '1' || h === 'yes';
}

export function getCursorBillingUrl() {
  return process.env.CURSOR_BILLING_URL?.trim() || 'https://cursor.com/dashboard/billing';
}

export function getCursorAuthStartUrl() {
  return process.env.CURSOR_AUTH_START_URL?.trim() || 'https://cursor.com/dashboard';
}

export function ensureDirForFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
