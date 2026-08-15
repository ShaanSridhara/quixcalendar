# Social panel — setup checklist

The Social page (`public/index.html`, page id `page-social`) reads a single
Firestore doc, `social/summary`. Two independent things write to it (or could
one day):

1. **`social-scraper/`** — a free scraper run on a GitHub Actions cron. This
   is the active path. No Firebase billing, no Google/Meta developer app, no
   API keys. Read-only.
2. **`functions/`** — a Cloud Functions scaffold for **posting** (composing
   from the app). Not deployed, not active, needs the paid Blaze plan +
   a Meta Developer app if you ever want it. Entirely optional.

Today the panel shows mock "Preview data" until step 1 below is configured.

## 1. Stats — social-scraper/ (free, no billing)

1. **YouTube** — auto-discovers new uploads, no setup beyond a channel ID.
   Open `social-scraper/config.json` and set `youtube.channelId` to the
   Quixilver channel's `UC...` ID (Channel → About → Share channel → Copy
   channel ID), or set `youtube.handle` to the `@handle` and the scraper
   will resolve it automatically. Uses YouTube's own public RSS feed — not
   really "scraping," it's an official, stable, intended-for-consumption
   feed. **Note:** the feed only returns the 15 most recent uploads; if the
   channel posts more than 15 times between the cutoff date and now, older
   ones in that window will be missed.
2. **Instagram** — two ways to get data, and both can run at once (the
   official API is tried first when configured; scraping is always the
   fallback):
   - **Scraping (already active, no setup)**: set `instagram.handle` in
     `social-scraper/config.json` to the account's `@username`, and/or add
     specific post URLs to `instagram.videoUrls`. Gets real likes + comments
     + exact publish dates. **Cannot get view counts, ever** — confirmed
     thoroughly (grid thumbnails, post pages, every aria-label, meta tags,
     JSON-LD — nothing exposes that number to a logged-out visitor, by
     Instagram's design, not a scraping gap). Auto-discovery from the
     profile grid is attempted every run but is blocked specifically from
     GitHub Actions' IPs, so in practice new posts need their URL added by
     hand to `instagram.videoUrls`, same habit as TikTok below.
   - **Official Graph API (optional, gets real view counts)**: set up once
     per the steps below, then set two **GitHub Actions secrets** (not
     Firebase secrets — this runs from the same free scraper, no billing
     plan needed):
     1. Create a Meta Developer app at developers.facebook.com, add the
        **Instagram Graph API** product.
     2. Convert the Quixilver Instagram account to a **Business** or
        **Creator** account (Instagram app → Settings → Account type) and
        link it to a Facebook Page.
     3. Generate a long-lived access token for that Instagram Business
        account with `instagram_basic` and `instagram_manage_insights`
        permissions (add `instagram_content_publish` too only if you're
        also setting up posting — see part 2 of this doc).
     4. Note the Instagram **Business Account ID** (via
        `GET /{page-id}?fields=instagram_business_account` on the Graph
        API).
     5. In the GitHub repo → **Settings → Secrets and variables →
        Actions**, add `IG_ACCESS_TOKEN` and `IG_BUSINESS_ACCOUNT_ID`.
     6. Once both secrets exist, every scraper run automatically uses the
        API instead of scraping for Instagram — real views included. If
        the API call ever fails (expired token, etc.), it falls back to
        the scraping path above rather than losing data entirely.
3. **TikTok** — same manual-URL model as Instagram above, and for the same
   underlying reason: TikTok actively blocks even a real headless browser
   from loading a profile's video grid (tested — it renders a "Something
   went wrong / Log in" wall specifically there). Add each video's URL to
   the `tiktok.videoUrls` array in `social-scraper/config.json` by hand as
   the team posts. Once given a URL, per-video scraping itself is solid,
   verified working: pulls views, likes, shares, and comments straight from
   that video's page.
4. **Firestore write access** — create a Firebase service account:
   Firebase Console → quixcalendar-fc708 → ⚙️ → **Project settings** →
   **Service accounts** → **Generate new private key**. This downloads a
   JSON file. Free on any plan, no card required.
5. In the GitHub repo → **Settings → Secrets and variables → Actions**,
   add a new secret named `FIREBASE_SERVICE_ACCOUNT_JSON` containing the
   full contents of that JSON file.
6. That's it — `.github/workflows/scrape-social.yml` runs every 6 hours
   automatically. To run it once immediately: repo → **Actions** tab →
   "Scrape social stats" → **Run workflow**.

To test locally before relying on the cron: `cd social-scraper && npm
install && node scrape.mjs` — without `FIREBASE_SERVICE_ACCOUNT_JSON` set,
it prints the result instead of writing to Firestore, so it's safe to run
against real config while checking the output looks right.

## 2. Posting — functions/ (optional, needs Blaze + a Meta app)

The Social page's "Compose post" UI was removed for now (to be re-added
later) — this backend is dormant scaffolding with no caller today. Only
relevant once that UI comes back and you want it to actually publish.

If you already did the Instagram Graph API setup in step 1.2 above
(Meta app, Business account, access token with `instagram_content_publish`
included, Business Account ID), you already have everything except the
Blaze upgrade — the same token/ID just need to be set again here, since
Cloud Functions secrets (Firebase Secret Manager) are a separate store from
the GitHub Actions secrets used in step 1.

1. Firebase Console → quixcalendar-fc708 → ⚙️ → **Usage and billing** →
   upgrade to **Blaze** (pay-as-you-go — required for Cloud Functions to
   make any outbound network call, but this workload is tiny and low-
   traffic, so expect to stay within Blaze's own free tier).
2. Set the two secrets (same values as `IG_ACCESS_TOKEN` /
   `IG_BUSINESS_ACCOUNT_ID` from step 1.2, just in a different place):
   ```
   firebase functions:secrets:set IG_ACCESS_TOKEN
   firebase functions:secrets:set IG_BUSINESS_ACCOUNT_ID
   ```
3. Deploy: `firebase deploy --only functions,hosting:quixcalendar,firestore:rules`
   — don't run a bare `firebase deploy` or omit the scoping, and don't
   touch the legacy `quixcalendar-fc708` hosting site (no `/api/*` rewrites
   there, and it shouldn't need any).

**YouTube posting isn't implemented** — the Data API v3 has no endpoint for
a short text/caption post; the only thing it can publish is a full video
upload, which this composer doesn't handle. `publishPost` returns a clear
501 for YouTube rather than pretending to support it.

**TikTok posting is out of scope by product decision**, not a missing
integration — the composer has no TikTok checkbox, and `publishPost`
rejects `platform: 'tiktok'` with a 400.

**Not built, and not recommended without a separate explicit decision:**
automated posting via a logged-in bot (browser automation using the team's
real password) instead of the official API. That's a meaningfully bigger
risk than read-only scraping — it can get the real account flagged or
locked, and more clearly crosses into automation the platforms actively
try to detect and block.
