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
 *    includes a view count per video. Auto-discovers new uploads.
 *  - TikTok: per-video page HTML embeds a JSON blob
 *    (__UNIVERSAL_DATA_FOR_REHYDRATION__) with playCount/diggCount/
 *    shareCount/commentCount. Confirmed working, but TikTok does not expose
 *    a profile's video list without logging in — so videos must be added to
 *    config.json by URL manually as the team posts them.
 *  - Instagram: confirmed NOT scrapable logged-out as of 2026-08 — profile
 *    and post pages return an empty JS app-shell with no post data at all
 *    when fetched without a session. This still attempts a best-effort parse
 *    in case that ever changes, but expect it to return nothing. The only
 *    reliable path for Instagram is the official Graph API (free, but needs
 *    a Meta Developer app + Business account — see ../SOCIAL_SETUP.md).
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

const __dirname = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function loadConfig() {
  const raw = readFileSync(join(__dirname, 'config.json'), 'utf8');
  return JSON.parse(raw);
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

// ── Instagram: best-effort, expected to come back empty (see header) ────
async function fetchInstagramPost(url) {
  const embedUrl = url.replace(/\/?$/, '/').replace(/(\/)?$/, '/embed/captioned/');
  const res = await fetch(embedUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Instagram returned ${res.status} for ${url}`);
  const html = await res.text();
  const desc = (/<meta property="og:description" content="([^"]*)"/.exec(html) || [])[1];
  if (!desc) throw new Error(`No public data available for ${url} — Instagram requires login for this content today`);
  const likeMatch = /^([\d,]+) Likes/.exec(desc);
  return {
    title: decodeXmlEntities(desc).slice(0, 100),
    thumbnail: null,
    views: null,
    likes: likeMatch ? Number(likeMatch[1].replace(/,/g, '')) : null,
    date: null,
    url,
  };
}

async function fetchInstagramStats(cfg) {
  const urls = cfg.videoUrls || [];
  if (!urls.length) {
    console.log('[instagram] no post URLs configured — skipping (see social-scraper/config.json)');
    return null;
  }
  const recentVideos = [];
  for (const url of urls) {
    try {
      recentVideos.push(await fetchInstagramPost(url));
      await new Promise((r) => setTimeout(r, 1500));
    } catch (e) {
      console.error(`[instagram] failed for ${url}:`, e.message);
    }
  }
  if (!recentVideos.length) {
    console.log('[instagram] none of the configured URLs returned data — this is expected today, see header comment');
    return null;
  }
  const totalViews = recentVideos.reduce((s, v) => s + (v.views || 0), 0);
  return { connected: true, totalViews, postCount: recentVideos.length, recentVideos };
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
    const ig = await fetchInstagramStats(cfg.instagram);
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
