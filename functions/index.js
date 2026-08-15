/**
 * Quix Calendar — Social panel backend (Cloud Functions v2, Node 20)
 * =====================================================================
 * SCAFFOLD ONLY — this codebase is committed but NOT deployed. The Firebase
 * project (quixcalendar-fc708) is currently on the free Spark plan, and
 * Cloud Functions require the paid Blaze plan. None of the secrets below
 * exist yet either (no Google Cloud OAuth client, no Meta Developer app).
 * See ../SOCIAL_SETUP.md for exactly what a human needs to do before this
 * can be deployed and turned on.
 *
 * Every exported function below is written to degrade gracefully when its
 * secrets aren't configured: it returns a structured "not_configured"
 * response (or, for the scheduled refresh, just skips that platform and
 * leaves whatever is already in Firestore untouched) instead of throwing.
 */
const {onRequest} = require('firebase-functions/v2/https');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {defineSecret} = require('firebase-functions/params');
const logger = require('firebase-functions/logger');
const admin = require('firebase-admin');
const {google} = require('googleapis');

admin.initializeApp();
const db = admin.firestore();

// ── Secrets ──────────────────────────────────────────────────────────────
// Names only — no values are stored here or anywhere in this repo. Set the
// real values with:
//   firebase functions:secrets:set YOUTUBE_CLIENT_ID
// (and so on for each one below) once the corresponding API credentials
// exist. See SOCIAL_SETUP.md.
const YOUTUBE_CLIENT_ID = defineSecret('YOUTUBE_CLIENT_ID');
const YOUTUBE_CLIENT_SECRET = defineSecret('YOUTUBE_CLIENT_SECRET');
const YOUTUBE_REFRESH_TOKEN = defineSecret('YOUTUBE_REFRESH_TOKEN');
const IG_ACCESS_TOKEN = defineSecret('IG_ACCESS_TOKEN');
const IG_BUSINESS_ACCOUNT_ID = defineSecret('IG_BUSINESS_ACCOUNT_ID');

// Only videos/posts published on/after this date count toward Social stats.
const SOCIAL_CUTOFF = '2026-01-01T00:00:00Z';
const SOCIAL_CUTOFF_MS = Date.parse(SOCIAL_CUTOFF);

// Mirrors CHARLIE_UID in public/index.html — the platform-admin UID used
// throughout the app's own client-side admin checks. Kept in sync manually
// since this backend has no shared-code build step with the frontend.
const PLATFORM_ADMIN_UID = 'FFCcwj3440ZXFcDZVAZzXmGuRQw2';

// ── Helpers ──────────────────────────────────────────────────────────────

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

function isPlatformAdmin(decoded) {
  return !!decoded && (decoded.uid === PLATFORM_ADMIN_UID || decoded.admin === true);
}

// ── YouTube stats ────────────────────────────────────────────────────────
// Sums viewCount across the channel's uploaded videos published on/after
// SOCIAL_CUTOFF, via the channel's "uploads" playlist.
async function fetchYouTubeStats() {
  const clientId = secretValue(YOUTUBE_CLIENT_ID);
  const clientSecret = secretValue(YOUTUBE_CLIENT_SECRET);
  const refreshToken = secretValue(YOUTUBE_REFRESH_TOKEN);
  if (!clientId || !clientSecret || !refreshToken) {
    logger.info('[social] YouTube secrets not configured — skipping (previous data left untouched)');
    return null;
  }

  const oauth2 = new google.auth.OAuth2(clientId, clientSecret);
  oauth2.setCredentials({refresh_token: refreshToken});
  const youtube = google.youtube({version: 'v3', auth: oauth2});

  // 1. Resolve the channel's uploads playlist.
  const chRes = await youtube.channels.list({part: ['contentDetails'], mine: true});
  const uploadsPlaylistId = chRes.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) throw new Error('No channel/uploads playlist found for the authorized YouTube account');

  // 2. Page through the uploads playlist, collecting video IDs published
  //    on/after the cutoff. Playlist items come back newest-first, so we
  //    can stop paging once we cross the cutoff.
  const videoIds = [];
  let pageToken;
  let keepPaging = true;
  while (keepPaging) {
    const plRes = await youtube.playlistItems.list({
      part: ['contentDetails', 'snippet'],
      playlistId: uploadsPlaylistId,
      maxResults: 50,
      pageToken,
    });
    for (const item of plRes.data.items || []) {
      const publishedAt = item.contentDetails?.videoPublishedAt || item.snippet?.publishedAt;
      if (publishedAt && Date.parse(publishedAt) >= SOCIAL_CUTOFF_MS) {
        videoIds.push(item.contentDetails.videoId);
      } else {
        keepPaging = false;
      }
    }
    pageToken = plRes.data.nextPageToken;
    if (!pageToken) keepPaging = false;
  }

  // 3. Fetch statistics + snippet for those videos, 50 IDs at a time.
  let totalViews = 0;
  const recentVideos = [];
  for (let i = 0; i < videoIds.length; i += 50) {
    const batch = videoIds.slice(i, i + 50);
    const vRes = await youtube.videos.list({part: ['statistics', 'snippet'], id: batch});
    for (const v of vRes.data.items || []) {
      const views = Number(v.statistics?.viewCount || 0);
      totalViews += views;
      recentVideos.push({
        title: v.snippet?.title || 'Untitled',
        thumbnail: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || null,
        views,
        date: (v.snippet?.publishedAt || '').slice(0, 10),
        url: `https://www.youtube.com/watch?v=${v.id}`,
      });
    }
  }
  recentVideos.sort((a, b) => (a.date < b.date ? 1 : -1));

  return {
    connected: true,
    totalViews,
    postCount: videoIds.length,
    recentVideos: recentVideos.slice(0, 10),
  };
}

// ── Instagram stats ──────────────────────────────────────────────────────
// Sums view/play counts across media posted on/after SOCIAL_CUTOFF for a
// Business/Creator account via the Instagram Graph API.
const GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

async function fetchInstagramStats() {
  const accessToken = secretValue(IG_ACCESS_TOKEN);
  const businessAccountId = secretValue(IG_BUSINESS_ACCOUNT_ID);
  if (!accessToken || !businessAccountId) {
    logger.info('[social] Instagram secrets not configured — skipping (previous data left untouched)');
    return null;
  }

  let totalViews = 0;
  const recentVideos = [];
  let postCount = 0;
  let url = `${GRAPH_API_BASE}/${businessAccountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp&access_token=${encodeURIComponent(accessToken)}`;

  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) throw new Error(`Instagram Graph API error: ${json?.error?.message || res.status}`);

    for (const media of json.data || []) {
      const ts = Date.parse(media.timestamp);
      if (!(ts >= SOCIAL_CUTOFF_MS)) continue; // media list is newest-first, but be defensive
      postCount++;

      // View-like metric name depends on media type (Reels use "plays",
      // videos use "video_views", images have no view metric at all).
      const metric = media.media_type === 'VIDEO' || media.media_type === 'REELS' ? 'plays' : null;
      let views = 0;
      if (metric) {
        try {
          const insRes = await fetch(`${GRAPH_API_BASE}/${media.id}/insights?metric=${metric}&access_token=${encodeURIComponent(accessToken)}`);
          const insJson = await insRes.json();
          if (insRes.ok) views = Number(insJson?.data?.[0]?.values?.[0]?.value || 0);
        } catch (e) {
          logger.warn(`[social] Instagram insights fetch failed for ${media.id}`, e);
        }
      }
      totalViews += views;
      recentVideos.push({
        title: (media.caption || '').slice(0, 80) || 'Untitled',
        thumbnail: media.thumbnail_url || media.media_url || null,
        views,
        date: (media.timestamp || '').slice(0, 10),
        url: media.permalink || null,
      });
    }
    url = json.paging?.next || null;
  }

  return {
    connected: true,
    totalViews,
    postCount,
    recentVideos: recentVideos.slice(0, 10),
  };
}

// ── Core refresh logic (shared by the scheduled + manual-trigger functions) ─
async function runSocialRefresh() {
  const update = {};

  try {
    const yt = await fetchYouTubeStats();
    if (yt) update.youtube = yt;
  } catch (e) {
    logger.error('[social] YouTube refresh failed', e);
  }

  try {
    const ig = await fetchInstagramStats();
    if (ig) update.instagram = ig;
  } catch (e) {
    logger.error('[social] Instagram refresh failed', e);
  }

  // TikTok: intentionally not implemented. Live view-stats would require its
  // own TikTok for Developers app + Login Kit OAuth flow, which does not
  // exist yet — see SOCIAL_SETUP.md. Nothing is written for `tiktok` here,
  // so the frontend's mock/preview fallback keeps showing for that card
  // until this TODO is picked up.
  logger.info('[social] TikTok stats collection skipped — no TikTok for Developers app configured yet (TODO).');

  if (Object.keys(update).length > 0) {
    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    await db.doc('social/summary').set(update, {merge: true});
    logger.info('[social] Wrote updated stats for: ' + Object.keys(update).filter((k) => k !== 'updatedAt').join(', '));
  } else {
    logger.info('[social] No platforms configured — nothing to write.');
  }
  return update;
}

// ── a) Scheduled refresh ─────────────────────────────────────────────────
exports.refreshSocialStats = onSchedule(
  {
    schedule: 'every 6 hours',
    secrets: [YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, IG_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID],
  },
  async () => {
    await runSocialRefresh();
  }
);

// ── b) Manual on-demand refresh (admin-only) ─────────────────────────────
exports.refreshSocialStatsNow = onRequest(
  {
    secrets: [YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN, IG_ACCESS_TOKEN, IG_BUSINESS_ACCOUNT_ID],
  },
  async (req, res) => {
    const decoded = await verifyCaller(req);
    if (!decoded) {
      res.status(401).json({error: 'unauthorized'});
      return;
    }
    if (!isPlatformAdmin(decoded)) {
      res.status(403).json({error: 'forbidden', message: 'Admin only'});
      return;
    }
    try {
      const result = await runSocialRefresh();
      res.status(200).json({ok: true, updated: Object.keys(result)});
    } catch (e) {
      logger.error('[social] refreshSocialStatsNow failed', e);
      res.status(500).json({error: 'internal', message: e.message});
    }
  }
);

// ── c) Publish a post ────────────────────────────────────────────────────
// Instagram: real 2-step Graph API publish flow (create media container,
// then publish it) — the one platform where "post a caption + media" is a
// well-defined API operation.
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
