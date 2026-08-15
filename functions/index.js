/**
 * Quix Calendar — Social panel: post-publishing backend (Cloud Functions v2, Node 20)
 * ======================================================================================
 * Stats collection (views/likes/shares) no longer lives here — that's done for
 * free by social-scraper/ on a GitHub Actions cron, writing straight into
 * Firestore `social/summary`, no Firebase billing plan required. See
 * ../SOCIAL_SETUP.md.
 *
 * This file only remains for optional future POSTING support, which is a
 * fundamentally different problem than reading public stats: publishing to
 * Instagram/YouTube on the team's behalf needs an authenticated write, which
 * realistically means either the official APIs (what's implemented below —
 * free to use, but needs a Meta Developer app + Blaze to deploy) or logging
 * in as a bot with real account credentials (not implemented here — that's a
 * meaningfully higher-risk approach that can get the real account flagged,
 * and isn't something to do without an explicit separate decision).
 *
 * SCAFFOLD ONLY — this codebase is committed but NOT deployed. The Firebase
 * project (quixcalendar-fc708) is currently on the free Spark plan, and
 * Cloud Functions require the paid Blaze plan to deploy at all. No secrets
 * exist yet either (no Meta Developer app). See ../SOCIAL_SETUP.md.
 *
 * publishPost degrades gracefully when its secrets aren't configured: it
 * returns a structured "not_configured" response instead of throwing.
 */
const {onRequest} = require('firebase-functions/v2/https');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');

admin.initializeApp();

// ── Secrets ──────────────────────────────────────────────────────────────
// Names only — no values are stored here or anywhere in this repo. Set the
// real values with:
//   firebase functions:secrets:set IG_ACCESS_TOKEN
//   firebase functions:secrets:set IG_BUSINESS_ACCOUNT_ID
// once the corresponding API credentials exist. See SOCIAL_SETUP.md.
const IG_ACCESS_TOKEN = defineSecret('IG_ACCESS_TOKEN');
const IG_BUSINESS_ACCOUNT_ID = defineSecret('IG_BUSINESS_ACCOUNT_ID');

// A secret param that isn't bound resolves to '' at runtime rather than
// throwing, so treat empty/whitespace as "not configured".
function secretValue(param) {
  try {
    const v = param.value();
    return v && String(v).trim() ? String(v).trim() : null;
  } catch (e) {
    return null;
  }
}

async function verifyCaller(req) {
  const header = req.get('Authorization') || '';
  const m = /^Bearer (.+)$/.exec(header);
  if (!m) return null;
  try {
    return await admin.auth().verifyIdToken(m[1]);
  } catch (e) {
    return null;
  }
}

// ── Publish a post ───────────────────────────────────────────────────────
// Instagram: real 2-step Graph API publish flow (create media container,
// then publish it) — the one platform where "post a caption + media" is a
// well-defined API operation.
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

async function publishToInstagram({caption, mediaUrl}) {
  const accessToken = secretValue(IG_ACCESS_TOKEN);
  const businessAccountId = secretValue(IG_BUSINESS_ACCOUNT_ID);
  if (!accessToken || !businessAccountId) {
    return {status: 501, body: {error: 'not_configured', platform: 'instagram'}};
  }
  if (!mediaUrl) {
    return {status: 400, body: {error: 'bad_request', platform: 'instagram', message: 'Instagram posts require a mediaUrl (image or video URL).'}};
  }

  // Step 1: create a media container.
  const createRes = await fetch(`${GRAPH_API_BASE}/${businessAccountId}/media`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({
      image_url: mediaUrl, // NOTE: video posts would use video_url + media_type: 'REELS' instead; out of scope for this scaffold's first cut.
      caption,
      access_token: accessToken,
    }),
  });
  const createJson = await createRes.json();
  if (!createRes.ok || !createJson.id) {
    return {status: 502, body: {error: 'instagram_api_error', platform: 'instagram', message: createJson?.error?.message || 'Failed to create media container'}};
  }

  // Step 2: publish the container.
  const publishRes = await fetch(`${GRAPH_API_BASE}/${businessAccountId}/media_publish`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({creation_id: createJson.id, access_token: accessToken}),
  });
  const publishJson = await publishRes.json();
  if (!publishRes.ok || !publishJson.id) {
    return {status: 502, body: {error: 'instagram_api_error', platform: 'instagram', message: publishJson?.error?.message || 'Failed to publish media container'}};
  }

  return {status: 200, body: {ok: true, platform: 'instagram', id: publishJson.id}};
}

// YouTube: the Data API v3 has no endpoint for a short text/caption "post" —
// Community posts (the tab that looks like a text post) have no public API
// at all, and the only thing the API *can* publish is a full video upload
// (videos.insert), which needs an actual video file and is out of scope for
// a text/caption composer like this one. So this always returns 501.
async function publishToYouTube() {
  return {
    status: 501,
    body: {
      error: 'unsupported',
      platform: 'youtube',
      message: "YouTube does not support text-post publishing via API; only full video uploads are supported, which this composer does not yet handle.",
    },
  };
}

exports.publishPost = onRequest(
  {secrets: [IG_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID]},
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({error: 'method_not_allowed'});
      return;
    }
    const decoded = await verifyCaller(req);
    if (!decoded) {
      res.status(401).json({error: 'unauthorized'});
      return;
    }

    const {platforms, caption, mediaUrl} = req.body || {};
    if (!Array.isArray(platforms) || platforms.length === 0 || typeof caption !== 'string' || !caption.trim()) {
      res.status(400).json({error: 'bad_request', message: 'Expected {platforms: string[], caption: string, mediaUrl?: string}'});
      return;
    }
    const ALLOWED = new Set(['youtube', 'instagram']);
    const bad = platforms.find((p) => !ALLOWED.has(p));
    if (bad) {
      // TikTok posting is explicitly out of scope (view-stats only) — same
      // 400 covers it and any other unrecognized platform.
      res.status(400).json({error: 'bad_request', message: `Unsupported platform: ${bad}. Only 'youtube' and 'instagram' are supported for posting.`});
      return;
    }

    const results = {};
    const statuses = [];
    for (const platform of platforms) {
      try {
        const r = platform === 'instagram' ? await publishToInstagram({caption, mediaUrl}) : await publishToYouTube();
        results[platform] = r.body;
        statuses.push(r.status);
      } catch (e) {
        logger.error(`[social] publishPost failed for ${platform}`, e);
        results[platform] = {error: 'internal', message: e.message};
        statuses.push(500);
      }
    }

    // Single-platform posts (the common case) return that platform's own
    // status/body directly — e.g. a lone `platforms:['instagram']` request
    // with no secrets configured comes back as a plain 501
    // {error:'not_configured', platform:'instagram'}, not wrapped. Multi-
    // platform requests get an aggregate 207 with a per-platform breakdown,
    // since each platform can succeed/fail independently.
    if (platforms.length === 1) {
      res.status(statuses[0]).json(results[platforms[0]]);
    } else {
      const anyFailed = statuses.some((s) => s >= 300);
      res.status(anyFailed ? 207 : 200).json({results});
    }
  }
);
