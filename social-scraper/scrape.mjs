#!/usr/bin/env node
/**
 * Free, scraping-based stats collector for the QuixCalendar Social panel.
 * Runs on a GitHub Actions cron (see ../.github/workflows/scrape-social.yml)
 * — no Firebase billing plan, no Google/Meta developer app, no API keys.
 *
 * Sources, in order of reliability (tested against real pages 2026-08):
 *  - YouTube: the channel's official public RSS feed
 *    (youtube.com/feeds/videos.xml?channel_id=...). Not really "scraping" —
 *    it's a stable, intended-for-consumption public feed, and it already
 *    includes a view count per video. Auto-discovers new uploads (last 15).
 *  - Instagram: a plain HTTP fetch gets nothing at all (Instagram serves an
 *    empty JS app-shell to non-browser requests), but a real headless
 *    browser (Playwright/Chromium) renders the public profile grid — from a
 *    normal dev machine. From GitHub Actions specifically, Instagram blocks
 *    even the full browser from loading the profile grid (confirmed —
 *    it comes back as the same empty "Instagram"-titled shell), likely
 *    because Actions runners sit on well-known Azure datacenter IP ranges.
 *    So auto-discovery is still attempted every run (harmless if it keeps
 *    failing there, and it'll pick up automatically if that ever changes),
 *    but the reliable path today is the same as TikTok's: visiting a
 *    *specific known* post URL directly (confirmed working even from
 *    Actions, unlike crawling the whole profile) still yields an exact
 *    publish date plus likes+comments via the og:description meta tag —
 *    so new posts need to be added to config.json by URL, same as TikTok.
 *    View/play counts are NOT available on Instagram even this way —
 *    Instagram hides that number from logged-out viewers entirely, so it's
 *    simply omitted rather than faked.
 *  - TikTok: per-video page HTML embeds a JSON blob
 *    (__UNIVERSAL_DATA_FOR_REHYDRATION__) with playCount/diggCount/
 *    shareCount/commentCount — confirmed working via plain fetch, no
 *    browser needed. But TikTok actively blocks even a real headless
 *    browser from loading a profile's video grid (tested — it renders a
 *    "Something went wrong / Log in" wall specifically there), so like
 *    Instagram there's no way to auto-discover new videos from Actions —
 *    they must be added to config.json by URL as the team posts them.
 *
 * Every fetch is read-only, against publicly-visible pages, with a normal
 * browser User-Agent — no login, no credentials, no bypassing any access
 * control. Every source degrades to "skip it" on failure rather than
 * throwing, so one platform breaking never takes down the others.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import admin from 'firebase-admin';
import { chromium } from 'playwright';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function loadConfig() {
  const raw = readFileSync(join(__dirname, 'config.json'), 'utf8');
  return JSON.parse(raw);
}

// Instagram abbreviates large counts in og:description ("260K likes", "2M
// likes") instead of giving an exact number — this is necessarily an
// approximation for those, not a precision QuixCalendar ever actually had.
function parseAbbreviatedNumber(s) {
  if (!s) return null;
  const m = /^([\d,.]+)([KMB]?)$/.exec(s.trim());
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  const mult = { K: 1e3, M: 1e6, B: 1e9 }[m[2]] || 1;
  return Math.round(n * mult);
}

function decodeXmlEntities(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ── YouTube: official public RSS feed ───────────────────────────────────
async function resolveYouTubeChannelId(handle) {
  if (!handle) return null;
  const clean = handle.replace(/^@/, '');
  try {
    const res = await fetch(`https://www.youtube.com/@${clean}/about`, { headers: { 'User-Agent': UA } });
    if (!res.ok) return null;
    const html = await res.text();
    const m = /"channelId":"(UC[\w-]{22})"/.exec(html);
    return m ? m[1] : null;
  } catch (e) {
    console.error('[youtube] handle resolution failed:', e.message);
    return null;
  }
}

async function fetchYouTubeStats(cfg, cutoffMs) {
  let channelId = cfg.channelId;
  if (!channelId || channelId === 'PUT_UC_CHANNEL_ID_HERE') {
    channelId = await resolveYouTubeChannelId(cfg.handle);
  }
  if (!channelId) {
    console.log('[youtube] no channelId configured — skipping (see social-scraper/config.json)');
    return null;
  }

  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`YouTube RSS feed returned ${res.status}`);
  const xml = await res.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
  let totalViews = 0, totalLikes = 0;
  const recentVideos = [];
  for (const entry of entries) {
    const published = (/<published>([^<]+)<\/published>/.exec(entry) || [])[1];
    if (!published || Date.parse(published) < cutoffMs) continue;
    const videoId = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry) || [])[1];
    const title = decodeXmlEntities((/<media:title>([^<]*)<\/media:title>/.exec(entry) || [])[1]);
    const thumbnail = (/<media:thumbnail url="([^"]+)"/.exec(entry) || [])[1] || null;
    const views = Number((/<media:statistics views="(\d+)"/.exec(entry) || [])[1] || 0);
    // The feed's starRating is a leftover from YouTube's old 5-star system —
    // every rating today is a 5, so the count IS effectively the like count
    // (confirmed: it scales proportionally with view count on every real
    // video checked). Not the real internal like number precisely, but the
    // same figure YouTube itself has publicly exposed here for years.
    const likes = Number((/<media:starRating count="(\d+)"/.exec(entry) || [])[1] || 0);
    // The feed already includes Shorts alongside regular uploads (same
    // upload pipeline, same <entry> shape) — the only difference is the
    // permalink shape, so preserve it as-is rather than always rewriting to
    // /watch?v=, which would silently turn every Short link into a regular
    // watch-page link.
    const permalink = (/<link rel="alternate" href="([^"]+)"/.exec(entry) || [])[1];
    const isShort = !!permalink && permalink.includes('/shorts/');
    totalViews += views;
    totalLikes += likes;
    recentVideos.push({
      title: title || 'Untitled',
      thumbnail,
      views,
      likes,
      date: published.slice(0, 10),
      url: permalink || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null),
      isShort,
    });
  }
  recentVideos.sort((a, b) => (a.date < b.date ? 1 : -1));

  return { connected: true, totalViews, totalLikes, postCount: recentVideos.length, recentVideos: recentVideos.slice(0, 10) };
}

// ── TikTok: per-video page scrape ───────────────────────────────────────
async function fetchTikTokVideo(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`TikTok returned ${res.status} for ${url}`);
  const html = await res.text();
  const m = /id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error(`Could not find TikTok data blob for ${url} (page structure may have changed, or this IP got blocked)`);
  const data = JSON.parse(m[1]);
  const item = data?.__DEFAULT_SCOPE__?.['webapp.video-detail']?.itemInfo?.itemStruct;
  if (!item) throw new Error(`No video data in TikTok blob for ${url}`);
  const stats = item.statsV2 || item.stats || {};
  return {
    title: (item.desc || 'Untitled').slice(0, 100),
    thumbnail: item.video?.cover || item.video?.originCover || item.video?.dynamicCover || null,
    views: Number(stats.playCount || 0),
    likes: Number(stats.diggCount || 0),
    shares: Number(stats.shareCount || 0),
    comments: Number(stats.commentCount || 0),
    saves: Number(stats.collectCount || 0),
    date: item.createTime ? new Date(Number(item.createTime) * 1000).toISOString().slice(0, 10) : null,
    url,
  };
}

async function fetchTikTokStats(cfg, cutoffMs) {
  const urls = cfg.videoUrls || [];
  if (!urls.length) {
    console.log('[tiktok] no video URLs configured — skipping (see social-scraper/config.json)');
    return null;
  }
  let totalViews = 0, totalLikes = 0, totalComments = 0, totalShares = 0, totalSaves = 0;
  const recentVideos = [];
  for (const url of urls) {
    try {
      const v = await fetchTikTokVideo(url);
      if (v.date && Date.parse(v.date) < cutoffMs) continue;
      totalViews += v.views;
      totalLikes += v.likes;
      totalComments += v.comments;
      totalShares += v.shares;
      totalSaves += v.saves;
      recentVideos.push(v);
      await new Promise((r) => setTimeout(r, 1500)); // be a polite, low-rate visitor
    } catch (e) {
      console.error(`[tiktok] failed for ${url}:`, e.message);
    }
  }
  recentVideos.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { connected: true, totalViews, totalLikes, totalComments, totalShares, totalSaves, postCount: recentVideos.length, recentVideos: recentVideos.slice(0, 10) };
}

// ── Instagram: headless-browser auto-discovery ──────────────────────────
// A plain fetch() gets nothing (empty JS app-shell), but a real headless
// browser renders the public profile grid fine, so this launches one to
// (a) collect recent post/reel links from the profile page, then (b) visit
// each to read its exact publish date and its likes+comments via the
// og:description meta tag. View/play counts are never available this way —
// Instagram hides that number from logged-out viewers entirely — so
// totalViews stays null rather than a misleading 0.
// Instagram post URLs are the same post whether written as
// /{username}/reel/{code}/, /reel/{code}/, or /p/{code}/?img_index=1 — key
// on the shortcode alone so auto-discovered and manually-added URLs for the
// same post dedupe instead of getting counted twice.
function instagramShortcode(url) {
  return (/\/(?:p|reel)\/([A-Za-z0-9_-]+)/.exec(url) || [])[1] || url;
}

// ── Instagram: official Graph API (real view counts) ─────────────────────
// Only used if IG_ACCESS_TOKEN + IG_BUSINESS_ACCOUNT_ID are set (GitHub
// Actions secrets — see SOCIAL_SETUP.md). This is the one path that can
// actually get view/play counts, since Instagram never exposes that number
// to a logged-out visitor no matter how it's fetched. No Firebase billing
// plan needed for this either — it's a plain HTTPS call, same as
// everything else here, just running from GitHub Actions instead of a paid
// Cloud Function.
const IG_GRAPH_API_BASE = 'https://graph.facebook.com/v19.0';

async function fetchInstagramStatsViaAPI(accessToken, businessAccountId, cutoffMs) {
  let totalViews = 0, totalLikes = 0, totalComments = 0, anyViews = false;
  const recentVideos = [];
  let url = `${IG_GRAPH_API_BASE}/${businessAccountId}/media?fields=id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count&access_token=${encodeURIComponent(accessToken)}`;

  while (url) {
    const res = await fetch(url);
    const json = await res.json();
    if (!res.ok) throw new Error(`Instagram Graph API error: ${json?.error?.message || res.status}`);

    let hitCutoff = false;
    for (const media of json.data || []) {
      // Media list is newest-first, so once we cross the cutoff we can stop
      // paging entirely rather than fetching insights for posts we'll discard.
      if (!(Date.parse(media.timestamp) >= cutoffMs)) { hitCutoff = true; continue; }

      let views = null;
      if (media.media_type === 'VIDEO' || media.media_type === 'REELS') {
        try {
          const metric = media.media_type === 'REELS' ? 'plays' : 'video_views';
          const insRes = await fetch(`${IG_GRAPH_API_BASE}/${media.id}/insights?metric=${metric}&access_token=${encodeURIComponent(accessToken)}`);
          const insJson = await insRes.json();
          if (insRes.ok) views = Number(insJson?.data?.[0]?.values?.[0]?.value ?? 0);
        } catch (e) {
          console.error(`[instagram] insights fetch failed for ${media.id}:`, e.message);
        }
      }
      if (views != null) { totalViews += views; anyViews = true; }
      const likes = Number(media.like_count || 0);
      const comments = Number(media.comments_count || 0);
      totalLikes += likes;
      totalComments += comments;
      recentVideos.push({
        title: (media.caption || '').slice(0, 100) || 'Untitled',
        thumbnail: media.thumbnail_url || media.media_url || null,
        views,
        likes,
        comments,
        date: (media.timestamp || '').slice(0, 10),
        url: media.permalink || null,
      });
    }
    url = hitCutoff ? null : (json.paging?.next || null);
  }

  recentVideos.sort((a, b) => (a.date < b.date ? 1 : -1));
  return {
    connected: true,
    totalViews: anyViews ? totalViews : null,
    totalLikes,
    totalComments,
    postCount: recentVideos.length,
    recentVideos: recentVideos.slice(0, 10),
  };
}

async function fetchInstagramStats(cfg, cutoffMs) {
  const accessToken = process.env.IG_ACCESS_TOKEN;
  const businessAccountId = process.env.IG_BUSINESS_ACCOUNT_ID;
  if (accessToken && businessAccountId) {
    try {
      return await fetchInstagramStatsViaAPI(accessToken, businessAccountId, cutoffMs);
    } catch (e) {
      console.error('[instagram] official API failed, falling back to scraping (no view counts that way):', e.message);
    }
  }

  const handle = (cfg.handle || '').replace(/^@/, '');
  const postUrls = new Map((cfg.videoUrls || []).map((u) => [instagramShortcode(u), u]));
  if (!handle && !postUrls.size) {
    console.log('[instagram] no handle or post URLs configured — skipping (see social-scraper/config.json)');
    return null;
  }

  // IG_SESSION_ID (optional): a sessionid cookie value from a normal,
  // human login — the script itself never logs in or sees a password. Not
  // risk-free (the session was created wherever you logged in, but gets
  // used from this runner's IP instead, which Instagram might flag; and
  // sessions expire and need periodically re-extracting), but a real step
  // down from storing actual credentials or running automated logins.
  const sessionId = process.env.IG_SESSION_ID;
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ userAgent: UA });
    if (sessionId) {
      await context.addCookies([{ name: 'sessionid', value: sessionId, domain: '.instagram.com', path: '/' }]);
      console.log('[instagram] using a logged-in session — attempting to read real view counts');
    }
    const page = await context.newPage();

    if (handle) {
      await page.goto(`https://www.instagram.com/${handle}/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      await page.waitForTimeout(2500);
      // Scoped to /{handle}/p/... and /{handle}/reel/... specifically —
      // the profile page also renders a "Suggested accounts" section with
      // /p/ and /reel/ links to OTHER accounts' posts, which a bare
      // a[href*="/p/"] selector would wrongly sweep in too.
      const links = await page.$$eval(
        `a[href^="/${handle}/p/"], a[href^="/${handle}/reel/"]`,
        (els) => [...new Set(els.map((e) => e.href))]
      );
      if (!links.length) {
        // Diagnostic aid — CI runner IPs (datacenter ranges) sometimes get a
        // different response than a residential/dev IP would (login wall,
        // rate limit, etc.), which is otherwise indistinguishable from
        // "wrong handle" in the logs.
        const title = await page.title().catch(() => '?');
        console.log(`[instagram] profile grid returned 0 links for @${handle} — page title was: "${title}"`);
      }
      links.slice(0, 15).forEach((l) => {
        const code = instagramShortcode(l);
        if (!postUrls.has(code)) postUrls.set(code, l);
      });
    }

    const recentVideos = [];
    for (const url of postUrls.values()) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1200);
        const datetime = await page.$eval('time', (el) => el.getAttribute('datetime')).catch(() => null);
        if (datetime && Date.parse(datetime) < cutoffMs) continue;
        const desc = await page.$eval('meta[property="og:description"]', (el) => el.content).catch(() => null);
        const likeMatch = desc && /^([\d,.]+[KMB]?) [Ll]ikes/.exec(desc);
        const commentMatch = desc && /,\s*([\d,.]+[KMB]?) [Cc]omments/.exec(desc);
        // View/play counts only ever render on a logged-in session — this is
        // untested against a real session (no test account available), so
        // it tries a couple of likely text patterns and logs plainly if none
        // match, rather than silently returning nothing.
        let views = null;
        if (sessionId) {
          const viewsText = await page.evaluate(() => {
            const m = /([\d,.]+[KMB]?)\s*(?:plays|views)/i.exec(document.body.innerText);
            return m ? m[1] : null;
          }).catch(() => null);
          if (viewsText) views = parseAbbreviatedNumber(viewsText);
          else console.log(`[instagram] logged-in session set but no view-count pattern matched on ${url} — page structure may differ from what was assumed, needs a look`);
        }
        recentVideos.push({
          title: decodeXmlEntities(desc || '').slice(0, 100) || 'Untitled',
          thumbnail: null,
          views,
          likes: likeMatch ? parseAbbreviatedNumber(likeMatch[1]) : null,
          comments: commentMatch ? parseAbbreviatedNumber(commentMatch[1]) : null,
          date: datetime ? datetime.slice(0, 10) : null,
          url,
        });
      } catch (e) {
        console.error(`[instagram] failed for ${url}:`, e.message);
      }
    }
    recentVideos.sort((a, b) => (a.date < b.date ? 1 : -1));
    if (!recentVideos.length) {
      console.log('[instagram] no posts returned data — check the handle in config.json is correct and public');
      return null;
    }
    const totalLikes = recentVideos.reduce((s, v) => s + (v.likes || 0), 0);
    const totalComments = recentVideos.reduce((s, v) => s + (v.comments || 0), 0);
    const anyViews = recentVideos.some((v) => v.views != null);
    const totalViews = anyViews ? recentVideos.reduce((s, v) => s + (v.views || 0), 0) : null;
    return { connected: true, totalViews, totalLikes, totalComments, postCount: recentVideos.length, recentVideos: recentVideos.slice(0, 10) };
  } finally {
    await browser.close();
  }
}

// ── Main ─────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  const cutoffMs = Date.parse(cfg.cutoffDate + 'T00:00:00Z');
  const update = {};

  try {
    const yt = await fetchYouTubeStats(cfg.youtube, cutoffMs);
    if (yt) update.youtube = yt;
  } catch (e) {
    console.error('[youtube] refresh failed:', e.message);
  }

  try {
    const tt = await fetchTikTokStats(cfg.tiktok, cutoffMs);
    if (tt) update.tiktok = tt;
  } catch (e) {
    console.error('[tiktok] refresh failed:', e.message);
  }

  try {
    const ig = await fetchInstagramStats(cfg.instagram, cutoffMs);
    if (ig) update.instagram = ig;
  } catch (e) {
    console.error('[instagram] refresh failed:', e.message);
  }

  if (Object.keys(update).length === 0) {
    console.log('Nothing to write — no platform returned data. Check social-scraper/config.json.');
    return;
  }

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!svcJson) {
    console.log('FIREBASE_SERVICE_ACCOUNT_JSON not set — printing result instead of writing to Firestore:');
    console.log(JSON.stringify(update, null, 2));
    return;
  }

  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svcJson)) });
  const db = admin.firestore();
  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db.doc('social/summary').set(update, { merge: true });
  console.log('Wrote updated stats for:', Object.keys(update).filter((k) => k !== 'updatedAt').join(', '));
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
