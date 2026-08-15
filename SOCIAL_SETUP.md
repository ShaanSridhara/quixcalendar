# Social panel — setup checklist

The Social page (`public/index.html`, page id `page-social`) reads a single
Firestore doc, `social/summary`. Two independent things write to it (or could
one day):

1. **`social-scraper/`** — a free scraper run on a GitHub Actions cron. This
   is the active path. No Firebase billing, no Google/Meta developer app, no
   API keys. Covers **view/like/share counts only** (read-only).
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
2. **TikTok** — there's no public way to list a profile's videos without
   logging in, so add each video's URL to the `tiktok.videoUrls` array in
   `social-scraper/config.json` by hand as the team posts. Verified
   working: pulls views, likes, shares, and comments straight from the
   video page.
3. **Instagram** — verified **not scrapable while logged out** as of
   2026-08 (profile/post pages return an empty JS app-shell with zero post
   data). URLs can still be added to the `instagram.videoUrls` array in
   `social-scraper/config.json` on a best-effort basis, but expect them to
   come back empty. The only
   reliable path for Instagram is the official Graph API — see step 2
   below if that's ever worth doing; it's free (no Blaze needed if run from
   GitHub Actions instead of Cloud Functions) but does require a Meta
   Developer app + converting the account to Business/Creator.
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

Only relevant if you want the in-app "Compose post" button to actually
publish, rather than showing its current "not connected yet" message.

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
