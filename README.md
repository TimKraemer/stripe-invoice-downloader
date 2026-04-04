# Cursor → Stripe Invoice PDF Downloader

Downloads invoice PDFs from the Stripe customer billing portal reached via your **Cursor** account, filtered by the calendar months you configure.

You are a **customer** — no Stripe API keys needed. The tool uses **Playwright** to automate a real browser session because Cursor uses **OAuth** (Google / GitHub / Apple) for sign-in.

> **This project was 100% AI-coded** (built with Cursor + Claude).
> It is tested against the **German locale** of the Stripe billing portal. The selectors and button labels (e.g. *Rechnung herunterladen*, *Mehr anzeigen*) target the German UI. It may or may not work with other browser/Stripe languages — if yours differs, PRs are welcome. It works for me and I can't be bothered to test every locale.

## Prerequisites

- Node.js 18+ (or Bun)
- Linux (tested on Ubuntu-based distros)

## Setup

```bash
git clone https://github.com/<you>/stripe-invoice-downloader.git
cd stripe-invoice-downloader
npm install          # also runs: playwright install chromium
cp .env.example .env
```

Edit `.env`:

| Variable | Description |
|---|---|
| `PLAYWRIGHT_STORAGE_STATE` | Path to saved session file (default `./.secrets/cursor-auth.json`, gitignored) |
| `INVOICE_MONTHS` | Comma-separated `YYYY-MM` values, e.g. `2026-01,2026-02,2026-03` |
| `INVOICE_MONTHS_FILE` | Alternative: path to a text file with one month per line (`#` comments OK, see `months.example.txt`) |
| `TZ` | IANA timezone for month boundaries, e.g. `Europe/Berlin` or `UTC` |
| `OUTPUT_DIR` | Where PDFs are saved (default `./invoices`) |
| `HEADLESS` | `true` for headless, `false` to watch the browser (useful for debugging) |

## One-time auth (interactive)

```bash
npm run auth
```

A headed browser opens. Complete your **Cursor OAuth** login (Google / GitHub / etc.) until you see your account dashboard. Return to the terminal and press **Enter** — the session is saved to `PLAYWRIGHT_STORAGE_STATE`.

Re-run this whenever your session expires (the download script will tell you).

## Download invoices

```bash
npm run download
```

What happens:

1. Loads your saved browser session.
2. Opens Cursor billing (`https://cursor.com/dashboard/billing`).
3. Clicks **Manage in Stripe** to open the Stripe customer portal.
4. Expands the full invoice history (*Mehr anzeigen*).
5. Filters invoices by your configured months (parses `DD.MM.YYYY` and `DD. Monat YYYY` date formats).
6. Opens matching invoices **in parallel** (4 tabs at a time), clicks *Rechnung herunterladen*, intercepts the PDF URL from Stripe's API, and saves each PDF.

## Locale / language

The script was built and tested with a **German browser locale**. It looks for button labels like:

- *Mehr anzeigen* (Show more)
- *Rechnung herunterladen* (Download invoice)

English fallbacks (`Show more`, `Download invoice`) are included but not battle-tested. If your Stripe portal renders in a different language the selectors may not match. Run with `HEADLESS=false` to debug.

## Fragility

Cursor and Stripe can change their HTML at any time. If things break:

1. Run with `HEADLESS=false`
2. Check which selectors changed
3. Update `src/download.js`

This tool downloads **your own** invoices. Respect Cursor and Stripe terms of use.

## Security

- `PLAYWRIGHT_STORAGE_STATE` is effectively **account access**. Keep it private; never commit it.
- `.env` contains no passwords but points to the session file — don't commit it either.
- Both are gitignored by default.

## License

[MIT](LICENSE)
