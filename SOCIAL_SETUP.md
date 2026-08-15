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
2. **Instagram** — set `instagram.handle` in `social-scraper/config.json`
   to the account's `@username` (no `@`) — the scraper always attempts to
   auto-discover new posts from the profile grid, and it's harmless to
   leave that on. But in practice, **from GitHub Actions specifically,
   Instagram blocks that profile-grid crawl** (confirmed — same empty
   app-shell a plain request gets), most likely because Actions runners sit
   on well-known Azure datacenter IPs. So the reliable path today is the
   same as TikTok: add each new post's URL to `instagram.videoUrls` in
   `social-scraper/config.json` by hand. Confirmed working even from
   Actions: reads that post's exact publish date and its likes + comments
   via the `og:description` meta tag. **View counts are the one thing
   that's genuinely not available** — Instagram hides that number from
   logged-out visitors even in a full browser — so the Social page shows
   "—" for Instagram's views and shows total likes in that stat's place
   instead, rather than a misleading 0.
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

1. Firebase Console → quixcalendar-fc708 → ⚙️ → **Usage and billing** →
   upgrade to **Blaze** (pay-as-you-go — required for Cloud Functions to
   make any outbound network call, but this workload is tiny and low-
   traffic, so expect to stay within Blaze's own free tier).
2. Create a Meta Developer app at developers.facebook.com, add the
   **Instagram Graph API** product.
3. Convert the Quixilver Instagram account to a **Business** or **Creator**
   account (Instagram app → Settings → Account type) and link it to a
   Facebook Page.
4. Generate a long-lived access token for that Instagram Business account
   with `instagram_basic`, `instagram_manage_insights`, and
   `instagram_content_publish` permissions.
5. Note the Instagram **Business Account ID** (via
   `GET /{page-id}?fields=instagram_business_account` on the Graph API).
6. Set the two secrets:
   ```
   firebase functions:secrets:set IG_ACCESS_TOKEN
   firebase functions:secrets:set IG_BUSINESS_ACCOUNT_ID
   ```
7. Deploy: `firebase deploy --only functions,hosting:quixcalendar,firestore:rules`
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
