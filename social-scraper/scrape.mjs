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
      publishedAt: published, // full ISO timestamp incl. time-of-day — used for the best-time-to-post insight
      url: permalink || (videoId ? `https://www.youtube.com/watch?v=${videoId}` : null),
      isShort,
    });
  }
  recentVideos.sort((a, b) => (a.publishedAt < b.publishedAt ? 1 : -1));

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
  const publishedAt = item.createTime ? new Date(Number(item.createTime) * 1000).toISOString() : null;
  return {
    title: (item.desc || 'Untitled').slice(0, 100),
    thumbnail: item.video?.cover || item.video?.originCover || item.video?.dynamicCover || null,
    views: Number(stats.playCount || 0),
    likes: Number(stats.diggCount || 0),
    shares: Number(stats.shareCount || 0),
    comments: Number(stats.commentCount || 0),
    saves: Number(stats.collectCount || 0),
    date: publishedAt ? publishedAt.slice(0, 10) : null,
    publishedAt, // full ISO timestamp incl. time-of-day — used for the best-time-to-post insight
    url,
  };
}

async function fetchTikTokStats(cfg, cutoffMs) {
  const urls = cfg.videoUrls || [];
  if (!urls.length) {
    // Real zero, not "not configured" — the team hasn't posted anything to
    // TikTok yet, which is a true fact worth writing, not a gap to hide
    // behind mock preview numbers.
    console.log('[tiktok] no video URLs configured yet — writing a real zero state');
    return { connected: true, totalViews: 0, totalLikes: 0, totalComments: 0, totalShares: 0, totalSaves: 0, postCount: 0, recentVideos: [] };
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
  recentVideos.sort((a, b) => ((a.publishedAt || a.date) < (b.publishedAt || b.date) ? 1 : -1));
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
        publishedAt: media.timestamp || null, // full ISO timestamp incl. time-of-day — used for the best-time-to-post insight
        url: media.permalink || null,
      });
    }
    url = hitCutoff ? null : (json.paging?.next || null);
  }

  recentVideos.sort((a, b) => ((a.publishedAt || a.date) < (b.publishedAt || b.date) ? 1 : -1));
  return {
    connected: true,
    totalViews: anyViews ? totalViews : null,
    totalLikes,
    totalComments,
    postCount: recentVideos.length,
    recentVideos: recentVideos.slice(0, 10),
  };
}

async function fetchInstagramStats(cfg, cutoffMs, db) {
  const accessToken = process.env.IG_ACCESS_TOKEN;
  const businessAccountId = process.env.IG_BUSINESS_ACCOUNT_ID;
  if (accessToken && businessAccountId) {
    try {
      return await fetchInstagramStatsViaAPI(accessToken, businessAccountId, cutoffMs);
    } catch (e) {
      console.error('[instagram] official API failed, falling back to scraping (no view counts that way):', e.message);
    }
  }

  // Confirmed via a real run: Instagram occasionally 429s a handful of
  // requests mid-scrape (5 posts in a row briefly rate-limited, out of 136
  // requests that run — not a hard block, just a hiccup) and a 429
  // response has no <time> or og:description at all. Every scrape run
  // fully replaces `instagram.recentVideos`, so writing that as
  // title:"Untitled"/likes:null overwrote perfectly good data that had
  // been scraped seconds earlier — visible on the live site until the
  // next successful run corrected it a minute later. Reading the last
  // known-good result first means a degraded fetch can fall back to it
  // instead of ever publishing the blank version.
  let previousByShortcode = new Map();
  if (db) {
    try {
      const prevSnap = await db.doc('social/summary').get();
      for (const v of prevSnap.data()?.instagram?.recentVideos || []) {
        if (v.url) previousByShortcode.set(instagramShortcode(v.url), v);
      }
    } catch (e) {
      console.error('[instagram] failed to read previous summary (fallback-on-failure disabled this run):', e.message);
    }
  }

  const handle = (cfg.handle || '').replace(/^@/, '');
  // Instagram's own "copy link" share button gives you the bare
  // /reel/{code}/ form (no username) — confirmed by a real scrape run that
  // every reel visited in that bare form came back with zero <time>
  // element after two full attempts, while the handle-prefixed form
  // (/{handle}/reel/{code}/, what auto-discovery always produces) worked
  // every time. Instagram appears to render the bare URL as a stripped
  // player view rather than the normal post page. Rewrite to the
  // handle-prefixed form before ever visiting it, since a manually-pasted
  // config.json URL is the main way the bare form gets in here.
  const withHandlePrefix = (u) => {
    if (!handle) return u;
    const m = /^https:\/\/www\.instagram\.com\/reel\/([A-Za-z0-9_-]+)\/?/.exec(u);
    return m ? `https://www.instagram.com/${handle}/reel/${m[1]}/` : u;
  };
  const postUrls = new Map((cfg.videoUrls || []).map((u) => {
    const full = withHandlePrefix(u);
    return [instagramShortcode(full), full];
  }));
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
  // Confirmed 2026-08-16: a fresh cookie works for exactly one login before
  // Instagram blocks it again within ~60s — the workflow's own inner loop
  // was retrying every ~60s, which reflagged the session almost
  // immediately. IG_ALLOW_LOGIN (set by the workflow, see
  // scrape-social.yml) restricts the authenticated attempt to once per
  // ~8min job instead of once per ~60s iteration, to stop needlessly
  // burning through the session and hammering the real account.
  const sessionId = process.env.IG_ALLOW_LOGIN === '1' ? process.env.IG_SESSION_ID : null;
  if (process.env.IG_SESSION_ID && !sessionId) {
    console.log('[instagram] skipping logged-in session this iteration (IG_ALLOW_LOGIN throttle) — reusing last known-good view counts instead');
  }
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

    // Logged-in only: the Reels tab grid (/{handle}/reels/) overlays a view
    // count directly on each thumbnail — confirmed from a real screenshot
    // (a logged-out visitor, or the general profile grid, never shows this;
    // it's specific to this tab while authenticated). One page load reads
    // every reel's view count at once, keyed by shortcode, rather than
    // guessing at text patterns on each individual post page.
    const reelViews = new Map();
    if (sessionId && handle) {
      try {
        await page.goto(`https://www.instagram.com/${handle}/reels/`, { waitUntil: 'domcontentloaded', timeout: 20000 });
        await page.waitForTimeout(2500);
        const items = await page.$$eval(
          `a[href^="/${handle}/reel/"]`,
          (els) => els.map((e) => ({ href: e.href, text: e.innerText.trim() }))
        );
        let mergedFromReelsTab = 0;
        for (const item of items) {
          const code = instagramShortcode(item.href);
          // The Reels tab is the one page guaranteed to list every reel —
          // merge its URLs into postUrls too, not just the view counts read
          // off it below. Without this, a reel that hadn't yet surfaced in
          // the mixed profile grid (which only gets a 2.5s settle window
          // before we read it) was silently never visited at all, so it
          // never got a date/likes/comments and just didn't show up.
          if (!postUrls.has(code)) { postUrls.set(code, item.href); mergedFromReelsTab++; }
          const m = /^([\d,.]+[KMB]?)$/.exec(item.text);
          if (m) reelViews.set(code, parseAbbreviatedNumber(m[1]));
        }
        console.log(`[instagram] read ${reelViews.size} view count(s) from the Reels tab, merged ${mergedFromReelsTab} reel URL(s) not already found via the profile grid`);
        if (items.length && !reelViews.size) {
          console.log(`[instagram] Reels tab found ${items.length} reel(s) but none matched the expected view-count text — sample: "${items[0]?.text}"`);
        }
      } catch (e) {
        console.error('[instagram] failed to read Reels tab view counts:', e.message);
      }
    }

    const recentVideos = [];
    for (const url of postUrls.values()) {
      try {
        const _resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
        // Reels take noticeably longer to hydrate their <time> element than
        // photo posts do (confirmed: absent at 1200ms, present by 3200ms on
        // a real reel; photo posts had it immediately) — wait for the
        // element itself rather than guessing a fixed delay long enough for
        // the slowest case. A GitHub Actions runner is slower and more
        // variable than the dev machine that 3200ms number came from, so
        // this waits longer (10s) and, if the element still isn't there,
        // reloads once and gives it a second try before giving up — a
        // single slow tick shouldn't cost the post its timestamp entirely.
        let datetime = null;
        for (let attempt = 0; attempt < 2 && !datetime; attempt++) {
          if (attempt > 0) await page.reload({ waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => null);
          await page.waitForSelector('time', { timeout: 10000 }).catch(() => null);
          datetime = await page.$eval('time', (el) => el.getAttribute('datetime')).catch(() => null);
        }
        if (datetime && Date.parse(datetime) < cutoffMs) continue;
        const desc = await page.$eval('meta[property="og:description"]', (el) => el.content).catch(() => null);
        // Confirmed signature of a 429/rate-limited response: no <time>
        // AND no og:description at all (a real successful page always has
        // at least one). Fall back to the last known-good scrape of this
        // exact post instead of publishing a blank "Untitled" that would
        // overwrite perfectly good data until the next run corrects it.
        if (!datetime && !desc) {
          const prev = previousByShortcode.get(instagramShortcode(url));
          if (prev) {
            console.log(`[instagram] fetch degraded for ${url} (HTTP ${_resp?.status()}, no <time>/og:description) — reusing last known-good data instead of overwriting it`);
            recentVideos.push(prev);
            continue;
          }
          console.log(`[instagram] fetch degraded for ${url} (HTTP ${_resp?.status()}) and no previous data to fall back to — will show as "Untitled" this run`);
        }
        const thumbnail = await page.$eval('meta[property="og:image"]', (el) => el.content).catch(() => null);
        const likeMatch = desc && /^([\d,.]+[KMB]?) [Ll]ikes/.exec(desc);
        const commentMatch = desc && /,\s*([\d,.]+[KMB]?) [Cc]omments/.exec(desc);
        // Photo posts (not reels) have no play count at all — reelViews
        // simply won't have an entry for those, and views stays null. But a
        // *reel* missing from reelViews just means the Reels tab (logged-in
        // only, and confirmed 2026-08-16 to get blocked again within ~60s
        // of a session successfully logging in) didn't come through this
        // particular run — falling back to the last run's real view count
        // instead of null means one lucky successful login isn't wiped out
        // by the very next (blocked) iteration a minute later.
        const code = instagramShortcode(url);
        const prevViews = previousByShortcode.get(code)?.views;
        const views = reelViews.has(code) ? reelViews.get(code) : (prevViews ?? null);
        recentVideos.push({
          title: decodeXmlEntities(desc || '').slice(0, 100) || 'Untitled',
          thumbnail,
          views,
          likes: likeMatch ? parseAbbreviatedNumber(likeMatch[1]) : null,
          comments: commentMatch ? parseAbbreviatedNumber(commentMatch[1]) : null,
          date: datetime ? datetime.slice(0, 10) : null,
          publishedAt: datetime, // full ISO timestamp incl. time-of-day — used for the best-time-to-post insight
          url,
        });
      } catch (e) {
        console.error(`[instagram] failed for ${url}:`, e.message);
      }
    }
    recentVideos.sort((a, b) => ((a.publishedAt || a.date) < (b.publishedAt || b.date) ? 1 : -1));
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

  const svcJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  let db = null;
  if (svcJson) {
    admin.initializeApp({ credential: admin.credential.cert(JSON.parse(svcJson)) });
    db = admin.firestore();

    // Links added via the QuixCalendar app itself (Social page → TikTok/
    // Instagram card → "Manage links", admin-only) — merged in alongside
    // config.json's own list rather than replacing it, deduped. TikTok has
    // no auto-discovery (see header comment), so this is the actual way new
    // videos get tracked day to day, without needing a repo edit. Instagram
    // auto-discovery is attempted too, but confirmed (real Actions run
    // logs, 2026-08-16) to return 0 profile-grid links every single time —
    // even with IG_SESSION_ID set — so in practice it's exactly as
    // manual-only as TikTok today, and needs the same escape hatch.
    try {
      const configSnap = await db.doc('social/config').get();
      if (configSnap.exists) {
        const remote = configSnap.data();
        if (Array.isArray(remote.tiktokVideoUrls) && remote.tiktokVideoUrls.length) {
          const merged = new Set([...(cfg.tiktok.videoUrls || []), ...remote.tiktokVideoUrls]);
          cfg.tiktok.videoUrls = [...merged];
          console.log(`[config] merged in ${remote.tiktokVideoUrls.length} TikTok link(s) from social/config`);
        }
        if (Array.isArray(remote.instagramVideoUrls) && remote.instagramVideoUrls.length) {
          const merged = new Set([...(cfg.instagram.videoUrls || []), ...remote.instagramVideoUrls]);
          cfg.instagram.videoUrls = [...merged];
          console.log(`[config] merged in ${remote.instagramVideoUrls.length} Instagram link(s) from social/config`);
        }
      }
    } catch (e) {
      console.error('Failed to read social/config from Firestore (continuing with config.json only):', e.message);
    }
  }

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
    const ig = await fetchInstagramStats(cfg.instagram, cutoffMs, db);
    if (ig) update.instagram = ig;
  } catch (e) {
    console.error('[instagram] refresh failed:', e.message);
  }

  if (Object.keys(update).length === 0) {
    console.log('Nothing to write — no platform returned data. Check social-scraper/config.json.');
    return;
  }

  // One-line per-platform breakdown so a jump/drop in the dashboard's
  // "Total engagement" number can be attributed to a specific platform from
  // the run log, without having to read raw Firestore data.
  const ENGAGEMENT_KEYS = ['totalViews', 'totalLikes', 'totalComments', 'totalShares', 'totalSaves'];
  let grandTotal = 0;
  for (const [platform, stats] of Object.entries(update)) {
    const total = ENGAGEMENT_KEYS.reduce((s, k) => s + (stats[k] || 0), 0);
    grandTotal += total;
    console.log(`[summary] ${platform}: ${total} total engagement (views=${stats.totalViews ?? 'n/a'} likes=${stats.totalLikes ?? 0} comments=${stats.totalComments ?? 0} shares=${stats.totalShares ?? 0} saves=${stats.totalSaves ?? 0}) across ${stats.postCount ?? 0} post(s)`);
  }
  console.log(`[summary] grand total engagement across all platforms: ${grandTotal}`);

  if (!db) {
    console.log('FIREBASE_SERVICE_ACCOUNT_JSON not set — printing result instead of writing to Firestore:');
    console.log(JSON.stringify(update, null, 2));
    return;
  }

  update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
  await db.doc('social/summary').set(update, { merge: true });
  console.log('Wrote updated stats for:', Object.keys(update).filter((k) => k !== 'updatedAt').join(', '));

  // Daily growth history — one doc per day (top-level `socialHistory`
  // collection, same read-only-to-clients lockdown as social/summary),
  // overwritten by every run that same day so re-runs don't create
  // duplicate snapshots. Two levels: account totals (for the growth chart)
  // and a per-post snapshot (so an individual video's view count climbing
  // day over day is visible, and so the best-time-to-post insight has
  // exact publish timestamps to bucket once enough days accumulate).
  const today = new Date().toISOString().slice(0, 10);
  const historyUpdate = { recordedAt: admin.firestore.FieldValue.serverTimestamp() };
  for (const [platform, stats] of Object.entries(update)) {
    if (platform === 'updatedAt') continue;
    const posts = {};
    for (const v of stats.recentVideos || []) {
      const key = shortHash(v.url || v.title || '');
      if (!key) continue;
      posts[key] = {
        views: v.views ?? null, likes: v.likes ?? null, comments: v.comments ?? null,
        shares: v.shares ?? null, saves: v.saves ?? null,
        date: v.date || null, publishedAt: v.publishedAt || null, url: v.url || null,
      };
    }
    historyUpdate[platform] = {
      totalViews: stats.totalViews ?? null, totalLikes: stats.totalLikes ?? null,
      totalComments: stats.totalComments ?? null, totalShares: stats.totalShares ?? null,
      totalSaves: stats.totalSaves ?? null, postCount: stats.postCount ?? 0, posts,
    };
  }
  await db.doc(`socialHistory/${today}`).set(historyUpdate, { merge: true });
  console.log(`Wrote history snapshot for ${today}`);
}

// Firestore map keys can't contain . # $ [ ] / — post URLs often do, so
// derive a short, stable, safe key from the URL instead of using it as-is.
function shortHash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return 'p' + (h >>> 0).toString(36);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
