# Social panel — setup checklist

The Social page (`public/index.html`, page id `page-social`) and its
Cloud Functions backend (`functions/`) are fully scaffolded and committed,
but **not deployed and not live**. Today the panel runs entirely on mock
"Preview data" so it's visibly functional with zero backend. This doc is the
checklist for turning it into the real thing.

Nothing here is done yet. None of the steps below have been run, and no real
credentials exist anywhere in this repo — only placeholder secret *names*.

## 1. Upgrade to the Blaze plan

Cloud Functions require the paid Blaze plan; the project is currently on the
free Spark plan.

- Firebase Console → quixcalendar-fc708 → ⚙️ → **Usage and billing** →
  upgrade to **Blaze** (pay-as-you-go). The functions in this repo are tiny
  and low-traffic (a 6-hour cron + a couple of on-demand HTTPS calls), so
  expect to stay within or very near the free tier of Blaze itself — but
  Blaze is required to deploy functions at all.

## 2. YouTube — Google Cloud OAuth client

1. In Google Cloud Console (same project, or a linked one), enable the
   **YouTube Data API v3**.
2. Create an **OAuth 2.0 Client ID** (type: Web application) under
   **APIs & Services → Credentials**.
3. Run through the OAuth consent flow once (e.g. with `google-oauthlib` or
   any OAuth playground) for the Quixilver team's YouTube channel account,
   with scope `https://www.googleapis.com/auth/youtube.readonly` (add
   `youtube.force-ssl` too only if upload/community-post support is ever
   added later) to obtain a **refresh token**.
4. Set the three secrets:
   ```
   firebase functions:secrets:set YOUTUBE_CLIENT_ID
   firebase functions:secrets:set YOUTUBE_CLIENT_SECRET
   firebase functions:secrets:set YOUTUBE_REFRESH_TOKEN
   ```
   (`YOUTUBE_REFRESH_TOKEN` is the one from step 3 above. Double-check
   `functions/index.js` still references exactly `YOUTUBE_CLIENT_ID` /
   `YOUTUBE_CLIENT_SECRET` / `YOUTUBE_REFRESH_TOKEN`.)

## 3. Instagram — Meta Developer app

1. Create a Meta Developer app at developers.facebook.com, add the
   **Instagram Graph API** product.
2. Convert the Quixilver Instagram account to a **Business** or **Creator**
   account (Instagram app → Settings → Account type) and link it to a
   Facebook Page.
3. Generate a long-lived access token for that Instagram Business account
   with `instagram_basic`, `instagram_manage_insights`, and
   `instagram_content_publish` permissions.
4. Note the Instagram **Business Account ID** (via
   `GET /{page-id}?fields=instagram_business_account` on the Graph API).
5. Set the two secrets:
   ```
   firebase functions:secrets:set IG_ACCESS_TOKEN
   firebase functions:secrets:set IG_BUSINESS_ACCOUNT_ID
   ```

## 4. TikTok — intentionally not built yet

TikTok view-stats collection is **not implemented** in this scaffold (see the
TODO comment in `functions/index.js`, `runSocialRefresh()`). It would need
its own **TikTok for Developers** app and a Login Kit OAuth flow, which
doesn't exist yet. Until that's built, the TikTok card on the Social page
will keep showing mock "Preview data" forever — that's expected, not a bug.

**Posting to TikTok is out of scope by product decision**, not a missing
integration — the composer intentionally has no TikTok checkbox, and
`publishPost` rejects `platform: 'tiktok'` with a 400. Don't add it without
re-confirming that decision.

## 5. Deploy

Once the secrets above are set and the Blaze plan is active:

```
firebase deploy --only functions,hosting:quixcalendar,firestore:rules
```

Do **not** run a bare `firebase deploy` or `firebase deploy --only functions`
without the `hosting:quixcalendar` / `firestore:rules` scoping shown above —
in particular, avoid touching the legacy `quixcalendar-fc708` hosting site,
which has no `/api/*` rewrites configured (and shouldn't need any).

After deploy, `refreshSocialStats` starts running every 6 hours
automatically. To trigger it once immediately for testing (admin-only —
checks the caller's Firebase ID token against the same platform-admin UID
check the app already uses client-side):

```
curl -X POST https://<region>-quixcalendar-fc708.cloudfunctions.net/refreshSocialStatsNow \
  -H "Authorization: Bearer <your Firebase ID token>"
```

(or via the `/api/refresh-social-now` Hosting rewrite once deployed).
