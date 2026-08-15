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
 *    browser (Playwright/Chromium) does render the public profile grid —
 *    confirmed working: auto-discovers recent post/reel URLs, and each
 *    post page yields an exact publish date plus likes+comments via the
 *    og:description meta tag. View/play counts are NOT available even this
 *    way — Instagram hides that number from logged-out viewers entirely, so
 *    it's simply omitted rather than faked.
 *  - TikTok: per-video page HTML embeds a JSON blob
 *    (__UNIVERSAL_DATA_FOR_REHYDRATION__) with playCount/diggCount/
 *    shareCount/commentCount — confirmed working via plain fetch, no
 *    browser needed. But TikTok actively blocks even a real headless
 *    browser from loading a profile's video grid (tested — it renders a
 *    "Something went wrong / Log in" wall specifically there), so unlike
 *    YouTube/Instagram there's no way to auto-discover new videos. They
 *    must be added to config.json by URL as the team posts them.
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
  let totalViews = 0;
  const recentVideos = [];
  for (const entry of entries) {
    const published = (/<published>([^<]+)<\/published>/.exec(entry) || [])[1];
    if (!published || Date.parse(published) < cutoffMs) continue;
    const videoId = (/<yt:videoId>([^<]+)<\/yt:videoId>/.exec(entry) || [])[1];
    const title = decodeXmlEntities((/<media:title>([^<]*)<\/media:title>/.exec(entry) || [])[1]);
    const thumbnail = (/<media:thumbnail url="([^"]+)"/.exec(entry) || [])[1] || null;
    const views = Number((/<media:statistics views="(\d+)"/.exec(entry) || [])[1] || 0);
    totalViews += views;
    recentVideos.push({
      title: title || 'Untitled',
      thumbnail,
      views,
      date: published.slice(0, 10),
      url: videoId ? `https://www.youtube.com/watch?v=${videoId}` : null,
    });
  }
  recentVideos.sort((a, b) => (a.date < b.date ? 1 : -1));

  return { connected: true, totalViews, postCount: recentVideos.length, recentVideos: recentVideos.slice(0, 10) };
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
  let totalViews = 0, totalShares = 0;
  const recentVideos = [];
  for (const url of urls) {
    try {
      const v = await fetchTikTokVideo(url);
      if (v.date && Date.parse(v.date) < cutoffMs) continue;
      totalViews += v.views;
      totalShares += v.shares;
      recentVideos.push(v);
      await new Promise((r) => setTimeout(r, 1500)); // be a polite, low-rate visitor
    } catch (e) {
      console.error(`[tiktok] failed for ${url}:`, e.message);
    }
  }
  recentVideos.sort((a, b) => (a.date < b.date ? 1 : -1));
  return { connected: true, totalViews, totalShares, postCount: recentVideos.length, recentVideos: recentVideos.slice(0, 10) };
}

// ── Instagram: headless-browser auto-discovery ──────────────────────────
// A plain fetch() gets nothing (empty JS app-shell), but a real headless
// browser renders the public profile grid fine, so this launches one to
// (a) collect recent post/reel links from the profile page, then (b) visit
// each to read its exact publish date and its likes+comments via the
// og:description meta tag. View/play counts are never available this way —
// Instagram hides that number from logged-out viewers entirely — so
// totalViews stays null rather than a misleading 0.
async function fetchInstagramStats(cfg, cutoffMs) {
  const handle = (cfg.handle || '').replace(/^@/, '');
  const postUrls = new Set(cfg.videoUrls || []);
  if (!handle && !postUrls.size) {
    console.log('[instagram] no handle or post URLs configured — skipping (see social-scraper/config.json)');
    return null;
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ userAgent: UA });

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
      links.slice(0, 15).forEach((l) => postUrls.add(l));
    }

    const recentVideos = [];
    for (const url of postUrls) {
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(1200);
        const datetime = await page.$eval('time', (el) => el.getAttribute('datetime')).catch(() => null);
        if (datetime && Date.parse(datetime) < cutoffMs) continue;
        const desc = await page.$eval('meta[property="og:description"]', (el) => el.content).catch(() => null);
        const likeMatch = desc && /^([\d,.]+[KMB]?) [Ll]ikes/.exec(desc);
        const commentMatch = desc && /,\s*([\d,.]+[KMB]?) [Cc]omments/.exec(desc);
        recentVideos.push({
          title: decodeXmlEntities(desc || '').slice(0, 100) || 'Untitled',
          thumbnail: null,
          views: null,
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
    return { connected: true, totalViews: null, totalLikes, postCount: recentVideos.length, recentVideos: recentVideos.slice(0, 10) };
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
