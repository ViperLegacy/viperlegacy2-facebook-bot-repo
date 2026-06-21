#!/usr/bin/env node
//
// fb-groups.js. Read-only Playwright wrapper for the ViperLegacy
// Facebook parts bot. NO write verbs by design.
//
// Three subcommands, each prints JSON to stdout and exits:
//   auth-check                                  verify cookies still log in
//   read-group --url <url> --count N            scroll a group, extract feed posts
//   read-post  --url <permalink> --max-comments N   open one post, pull body + comments
//
// read-group returns per-post comments_count + reactions_count so the
// agent can detect comment-count DELTAS against prior cycles. read-post
// is how the agent then "re-reviews" a changed thread: it opens the
// permalink and returns the comment bodies, where the transaction
// signal usually lives (a WTB post someone answers with "I have one",
// a WTS post answered "sold / still available", a part located in the
// thread). Still strictly read-only: no post/comment/react/DM verbs.
//
// Cookies loaded from /secrets/facebook.cookies.json (read-only
// mount). Expected format: top-level array in Playwright's
// addCookies() shape. Same normalization as the engager wrappers
// (sameSite mapping across exporter formats).
//
// Stealth + headed under Xvfb. The Comet UI has aggressive class-
// name hashing, so SELECTORS leans on aria-label, role, and href
// patterns. Selectors WILL break; centralized for one-line fixes.

'use strict';

const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
chromium.use(StealthPlugin());

const fs = require('fs');

const COOKIES_PATH = process.env.FB_COOKIES_PATH
  || '/secrets/facebook.cookies.json';

const BASE = 'https://www.facebook.com';

const SCREENSHOTS_DIR = '/workspace/repo/data/screenshots';

const SELECTORS = {
  // Logged-in indicator. Facebook's global nav has a profile
  // button; pre-login the same area has "Sign Up" / "Log In".
  loggedInAccountButton: '[aria-label*="Your profile" i], [aria-label="Account"]',

  // Post containers in a group feed. Comet UI wraps both posts
  // AND comments in role="article", so a bare role-article match
  // picks up comments-as-posts. We grab all role-article elements
  // first then JS-filter to TOP-LEVEL ones (no ancestor role-
  // article) inside the extraction loop. aria-posinset would be
  // a cleaner discriminator but Comet doesn't always emit it on
  // group feeds.
  postArticle:           'div[role="article"]',

  // Inside a post header. Author live links are anchors to
  // /user/<id>/ within the group, or to /<vanity>/ at the root.
  // Multiple fallbacks because Comet hashes class names.
  postAuthorLink:        'a[role="link"][href*="/user/"], a[role="link"][href*="/profile.php"], a[role="link"][aria-label*="profile" i], h3 strong a, h2 strong a, h3 a[role="link"]',
  // Permalink is anchored to the post's timestamp.
  postTimestampLink:     'a[role="link"][href*="/posts/"], a[role="link"][href*="/permalink/"], a[href*="?multi_permalinks"]',
  // Photo thumbnails inside the post.
  postPhoto:             'img[src*="scontent"]',

  // Login redirect / challenge signals (similar to LinkedIn but
  // with FB-specific labels).
  loginForm:             'form[id="login_form"], input[name="email"][type="text"], a[href*="/login"]',
  checkpointPage:        ':text("We don\'t recognize"), :text("verify your identity")',
  rateLimitNotice:       ':text("you\'re going too fast"), :text("temporarily blocked")',

  // "View more comments" expander on a post permalink page. Comet
  // hashes classes, so match on the role + visible label text.
  moreCommentsButton:    'div[role="button"]:has-text("more comment"), div[role="button"]:has-text("View more"), span:has-text("View more comments")',
};

function emit(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function die(error, details) {
  emit({ ok: false, error, ...(details ? { details } : {}) });
  process.exit(1);
}

function loadCookies() {
  if (!fs.existsSync(COOKIES_PATH)) {
    die('cookies missing', `expected file at ${COOKIES_PATH}`);
  }
  const raw = fs.readFileSync(COOKIES_PATH, 'utf-8');
  let cookies;
  try { cookies = JSON.parse(raw); }
  catch (e) { die('cookies malformed', `not valid JSON: ${e.message}`); }
  if (!Array.isArray(cookies)) die('cookies malformed', 'top level must be an array');

  return cookies.map((c) => {
    const out = { ...c };
    if (typeof out.expires === 'string') out.expires = Number(out.expires);
    if (out.expirationDate && !out.expires) out.expires = Math.floor(out.expirationDate);
    if (out.session === true) delete out.expires;
    if (!out.domain) out.domain = '.facebook.com';
    if (!out.path) out.path = '/';
    const ss = (() => {
      if (out.sameSite == null) return null;
      const v = String(out.sameSite).toLowerCase();
      switch (v) {
        case 'strict':         return 'Strict';
        case 'lax':            return 'Lax';
        case 'none':           return 'None';
        case 'no_restriction': return 'None';
        default:               return null;
      }
    })();
    if (ss) out.sameSite = ss;
    else delete out.sameSite;
    delete out.hostOnly;
    delete out.storeId;
    delete out.id;
    delete out.expirationDate;
    return out;
  });
}

async function newContext() {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
    ],
  });
  const ctx = await browser.newContext({
    viewport:   { width: 1366, height: 900 },
    userAgent:  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale:     'en-US',
    timezoneId: 'America/New_York',
  });
  await ctx.addCookies(loadCookies());
  return { browser, ctx };
}

let navSeq = 0;
async function snapshotNav(page, contextTag, navLabel) {
  try {
    fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
  } catch {}
  navSeq++;
  const filename = `nav-${contextTag}-${String(navSeq).padStart(2, '0')}-${navLabel}-${Date.now()}.png`;
  const absolutePath = `${SCREENSHOTS_DIR}/${filename}`;
  const repoRelativePath = `data/screenshots/${filename}`;
  try {
    // Viewport-only (not fullPage). Facebook's Comet UI pads pages
    // with massive empty regions when rendered headed, so fullPage
    // PNGs are mostly whitespace and run 2-10MB. Viewport-only is
    // ~200-500KB and shows what the user would actually see.
    await page.screenshot({ path: absolutePath, fullPage: false });
    return repoRelativePath;
  } catch {
    return null;
  }
}

async function gotoWithRetry(page, url) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      return;
    } catch (e) {
      lastErr = e;
      const isTimeout = e?.name === 'TimeoutError' || /Timeout/i.test(e?.message ?? '');
      if (!isTimeout || attempt === 1) throw e;
      await page.waitForTimeout(3_000);
    }
  }
  throw lastErr;
}

async function assertNotChallenged(page) {
  if (await page.locator(SELECTORS.loginForm).count() > 0) {
    die('auth_lost_mid_cycle', 'redirected to login form');
  }
  if (await page.locator(SELECTORS.checkpointPage).count() > 0) {
    die('auth_lost_mid_cycle', 'Facebook served an identity verification page');
  }
  if (await page.locator(SELECTORS.rateLimitNotice).count() > 0) {
    die('rate_limited');
  }
}

function urlLooksLikeAuthFail(url) {
  return /\/login|\/checkpoint|\/r\/sign/i.test(url);
}

// Best-effort permalink extraction from a post's timestamp link.
// Returns the canonical /groups/<id>/posts/<id>/ URL when possible.
function normalizePostUrl(href) {
  if (!href) return null;
  // Strip query string + fragment.
  const stripped = href.split('?')[0].split('#')[0];
  if (stripped.startsWith('http')) return stripped;
  return BASE + stripped;
}

function extractPostId(url) {
  if (!url) return null;
  const m = url.match(/\/posts\/(\d+)|\/permalink\/(\d+)|multi_permalinks=(\d+)/);
  return (m && (m[1] || m[2] || m[3])) || null;
}

// "1.2K" -> 1200, "3" -> 3, "1,024" -> 1024. Used for comment /
// reaction counts on both feed cards and permalink pages. Returns
// null when no count can be parsed (treat as unknown, not zero).
function parseCount(raw) {
  if (raw == null) return null;
  const s = String(raw).trim().replace(/,/g, '');
  const m = s.match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (Number.isNaN(n)) return null;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') n *= 1e3;
  else if (suffix === 'M') n *= 1e6;
  else if (suffix === 'B') n *= 1e9;
  return Math.round(n);
}

// Comet renders a post as concatenated text with no clean
// semantic separator: AuthorName, optional ContributorBadge,
// optional "· Follow", BodyText, AgeText, "LikeReplyShare",
// optional ReactionCount. innerText preserves block boundaries
// as newlines, which lets us split + filter UI noise to isolate
// the actual author + body.
function cleanFacebookPostText(raw) {
  if (!raw) return { author: null, body: '' };
  const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);

  const isNoise = (line) =>
    /^(Like|Reply|Share|Follow|Comment|See more|See translation|Sponsored|Edited)$/i.test(line) ||
    /^· Follow$/i.test(line) ||
    /^All-star contributor$/i.test(line) ||
    /^Rising contributor$/i.test(line) ||
    /^Top contributor$/i.test(line) ||
    /^Group expert$/i.test(line) ||
    /^Author$/i.test(line) ||
    /^Anonymous member$/i.test(line) ||
    /^Admin$/i.test(line) ||
    /^Moderator$/i.test(line) ||
    /^\d+\s*(s|m|h|d|w|y|mo)$/i.test(line) ||      // age "43w", "23h", "5m"
    /^(Yesterday|Today)\s+at\s+/i.test(line) ||
    /^\d+(\.\d+)?[KMB]?$/i.test(line) ||           // reaction counts "131", "1.2K"
    /^All comments$/i.test(line) ||
    /^Most relevant$/i.test(line) ||
    /^View\s+\d+/i.test(line) ||
    /^Hide\s+\d+/i.test(line);

  const meaningful = lines.filter((l) => !isNoise(l));
  const author = meaningful[0] || null;
  // Strip leading author from body lines just in case it bled
  // into the next line, then join.
  const bodyLines = meaningful.slice(1);
  const body = bodyLines.join(' ').replace(/\s+/g, ' ').trim();

  return { author, body };
}

// Coarse relative-age parse: "3h" / "23 hours ago" -> hours.
// Returns null when no recognizable unit is present.
function parseAgeHours(ageText) {
  if (!ageText) return null;
  const s = String(ageText).toLowerCase();
  const m = s.match(/(\d+)\s*(m|min|minute|h|hr|hour|d|day|w|week|y|year|mo|month)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  const unit = m[2];
  if (/^m(in|inute)?$/.test(unit)) return +(n / 60).toFixed(2);
  if (/^h/.test(unit)) return n;
  if (/^d/.test(unit)) return n * 24;
  if (/^w/.test(unit)) return n * 24 * 7;
  if (/^mo/.test(unit)) return n * 24 * 30;
  if (/^y/.test(unit)) return n * 24 * 365;
  return null;
}

// ─── Subcommand: auth-check ───────────────────────────────────

async function cmdAuthCheck() {
  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, BASE + '/');
    // Facebook's React shell hydrates after domcontentloaded;
    // wait for nav region or short timeout.
    await page.waitForSelector('div[role="banner"], nav, [aria-label="Facebook"]', { timeout: 10_000, state: 'attached' }).catch(() => {});
    await page.waitForTimeout(2_500);
    screenshots.push(await snapshotNav(page, 'auth-check', 'post-goto'));

    const finalUrl = page.url();
    if (urlLooksLikeAuthFail(finalUrl)) {
      emit({
        ok: false,
        error: 'not logged in',
        final_url: finalUrl,
        hint: 'Facebook redirected to login or checkpoint. Cookies are expired, partial, or exported from a different account. Re-export from a logged-in browser session on facebook.com.',
        screenshots: screenshots.filter(Boolean),
      });
      process.exit(2);
    }

    await assertNotChallenged(page);

    const profileBtn = page.locator(SELECTORS.loggedInAccountButton).first();
    if (await profileBtn.count() === 0) {
      // Tertiary fallback: presence of any reasonable nav.
      const navPresent = await page.locator('div[role="banner"], [aria-label="Facebook"], div[role="main"]').count() > 0;
      if (navPresent) {
        emit({
          ok: true,
          logged_in_as: '(no display name extracted; nav present)',
          final_url: finalUrl,
          warning: 'profile-button selectors stale; update SELECTORS.loggedInAccountButton in fb-groups.js when convenient',
          screenshots: screenshots.filter(Boolean),
        });
        return;
      }
      emit({
        ok: false,
        error: 'not logged in',
        final_url: finalUrl,
        hint: 'URL did not redirect to login but no nav or profile button found. Inspect the screenshot to see what FB actually rendered.',
        screenshots: screenshots.filter(Boolean),
      });
      process.exit(2);
    }

    // Display name. FB makes this annoying to extract reliably;
    // try the profile button's aria-label.
    const aria = await profileBtn.getAttribute('aria-label').catch(() => null);
    const displayName = aria ? aria.replace(/^Your profile,?\s*/i, '').trim() : '(name not extracted)';

    emit({ ok: true, logged_in_as: displayName, final_url: finalUrl, screenshots: screenshots.filter(Boolean) });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    const snap = await snapshotNav(page, 'auth-check', 'uncaught').catch(() => null);
    emit({ ok: false, error: 'auth_check_failed', details: e.message, screenshots: [...screenshots, snap].filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: read-group ───────────────────────────────────

async function cmdReadGroup(args) {
  const groupUrl = args.url;
  const count = parseInt(args.count || '50', 10);
  if (!groupUrl) die('missing_arg', 'read-group requires --url <group-url>');

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, groupUrl);
    await page.waitForSelector('div[role="banner"], nav', { timeout: 10_000, state: 'attached' }).catch(() => {});
    await page.waitForTimeout(2_500);
    screenshots.push(await snapshotNav(page, 'read-group', 'post-goto'));

    const finalUrl = page.url();
    if (urlLooksLikeAuthFail(finalUrl)) {
      emit({
        ok: false,
        error: 'auth_lost_mid_cycle',
        final_url: finalUrl,
        hint: 'Facebook redirected to login when loading this group. Cookies likely partially valid; refresh + restart.',
        screenshots: screenshots.filter(Boolean),
      });
      process.exit(2);
    }
    await assertNotChallenged(page);

    // Scroll + accumulate. Facebook uses virtual scrolling: it
    // unmounts posts that have scrolled out of view to save
    // memory. Final-state-only extraction sees only the 2-4
    // currently-visible posts even after extensive scrolling.
    //
    // Performance lesson from the previous version: per-article
    // Playwright API calls (15+ round-trips per post × 20
    // posts × 8 passes = ~2400 wire trips) make each pass take
    // ~2 minutes. Total cycle: ~50 min. Unacceptable.
    //
    // Fix: do ALL extraction inside a single page.evaluate()
    // per pass, returning plain JSON. One wire trip per pass
    // instead of thousands. Per-pass time drops from ~2 min
    // to <2s. Total cycle ~5 min for 3 groups.
    const accumulator = new Map();   // post_id -> post-record
    const unknownIdAccumulator = [];

    for (let pass = 0; pass <= 8; pass++) {
      // Run extraction in the browser context. This is the hot
      // path: one round-trip carries N article records back.
      const passResults = await page.evaluate(() => {
        function cleanFacebookPostText(raw) {
          if (!raw) return { author: null, body: '' };
          const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
          const isNoise = (line) =>
            /^(Like|Reply|Share|Follow|Comment|See more|See translation|Sponsored|Edited)$/i.test(line) ||
            /^· Follow$/i.test(line) ||
            /^All-star contributor$/i.test(line) ||
            /^Rising contributor$/i.test(line) ||
            /^Top contributor$/i.test(line) ||
            /^Group expert$/i.test(line) ||
            /^Author$/i.test(line) ||
            /^Anonymous member$/i.test(line) ||
            /^Admin$/i.test(line) ||
            /^Moderator$/i.test(line) ||
            /^\d+\s*(s|m|h|d|w|y|mo)$/i.test(line) ||
            /^(Yesterday|Today)\s+at\s+/i.test(line) ||
            /^\d+(\.\d+)?[KMB]?$/i.test(line) ||
            /^All comments$/i.test(line) ||
            /^Most relevant$/i.test(line) ||
            /^View\s+\d+/i.test(line) ||
            /^Hide\s+\d+/i.test(line);
          const meaningful = lines.filter((l) => !isNoise(l));
          const author = meaningful[0] || null;
          const body = meaningful.slice(1).join(' ').replace(/\s+/g, ' ').trim();
          return { author, body };
        }
        function extractPostId(url) {
          if (!url) return null;
          const m = url.match(/\/posts\/(\d+)|\/permalink\/(\d+)|multi_permalinks=(\d+)/);
          return (m && (m[1] || m[2] || m[3])) || null;
        }
        function normalizePostUrl(href) {
          if (!href) return null;
          const stripped = href.split('?')[0].split('#')[0];
          if (stripped.startsWith('http')) return stripped;
          return 'https://www.facebook.com' + stripped;
        }
        // Pull a "N comments" / "N shares" count from a post's
        // social bar. Comet labels these as buttons / links with
        // visible text or aria-label; we scan the article's text
        // for the pattern as the robust fallback. Returns raw
        // strings (Node side parses "1.2K" -> number).
        function rawCount(article, kind) {
          // kind: "comment" | "share"
          const re = new RegExp('([\\d.,]+)\\s*' + kind + 's?\\b', 'i');
          // Prefer an aria-label on the social bar (more stable).
          const labelled = Array.from(article.querySelectorAll('[aria-label]'))
            .map((el) => el.getAttribute('aria-label') || '')
            .find((l) => re.test(l));
          if (labelled) { const m = labelled.match(re); if (m) return m[1]; }
          const txt = article.innerText || '';
          const m2 = txt.match(re);
          return m2 ? m2[1] : null;
        }
        // Reactions count: the like/react bar exposes an
        // aria-label like "Like: 131 people" or a tooltip count.
        function rawReactions(article) {
          const labelled = Array.from(article.querySelectorAll('[aria-label]'))
            .map((el) => el.getAttribute('aria-label') || '')
            .find((l) => /([\d.,]+)\s+(reaction|people|like)/i.test(l));
          if (labelled) { const m = labelled.match(/([\d.,]+)/); if (m) return m[1]; }
          return null;
        }
        const articles = Array.from(document.querySelectorAll('div[role="article"]'));
        const out = [];
        for (const article of articles) {
          try {
            // Skip nested (comments).
            let p = article.parentElement;
            let isNested = false;
            while (p) {
              if (p.matches && p.matches('div[role="article"]')) { isNested = true; break; }
              p = p.parentElement;
            }
            if (isNested) continue;

            // Permalink lookup.
            const tlinks = Array.from(article.querySelectorAll('a[role="link"][href*="/posts/"], a[role="link"][href*="/permalink/"], a[href*="?multi_permalinks"]'));
            let permalinkHref = null;
            for (const tl of tlinks.slice(0, 5)) {
              const href = tl.getAttribute('href');
              if (href && (/\/posts\//.test(href) || /\/permalink\//.test(href) || /multi_permalinks=/.test(href))) {
                permalinkHref = href;
                break;
              }
            }
            const postUrl = normalizePostUrl(permalinkHref);
            const postId = extractPostId(postUrl);

            // Author via link selectors.
            const authorSelectors = [
              'a[role="link"][href*="/user/"]',
              'a[role="link"][href*="/profile.php"]',
              'a[role="link"][aria-label*="profile" i]',
              'h3 strong a', 'h2 strong a',
              'h3 a[role="link"]',
            ];
            let linkAuthor = null;
            for (const sel of authorSelectors) {
              const el = article.querySelector(sel);
              if (el) {
                const t = (el.textContent || '').trim().replace(/\s+/g, ' ');
                if (t) { linkAuthor = t; break; }
              }
            }

            const rawInnerText = article.innerText || '';
            const { author: cleanedAuthor, body: cleanedBody } = cleanFacebookPostText(rawInnerText);
            const author = linkAuthor || cleanedAuthor || null;
            let text = cleanedBody;
            if (author && text.startsWith(author)) text = text.slice(author.length).trim();
            text = text.slice(0, 2000);

            const photos = Array.from(article.querySelectorAll('img[src*="scontent"]'))
              .slice(0, 6)
              .map((img) => img.getAttribute('src'))
              .filter(Boolean);

            const ageEl = article.querySelector('a[role="link"][aria-label*="hour" i], a[role="link"][aria-label*="day" i], a[role="link"][aria-label*="minute" i]');
            const ageText = ageEl ? (ageEl.textContent || '').trim() : null;

            if (!postUrl && !text) continue;

            out.push({
              post_id: postId,
              post_url: postUrl,
              author: author || null,
              text,
              age_text: ageText || null,
              comments_raw: rawCount(article, 'comment'),
              shares_raw:   rawCount(article, 'share'),
              reactions_raw: rawReactions(article),
              photos,
            });
          } catch (e) {
            continue;
          }
        }
        return out;
      });

      // Accumulate on the Node side.
      for (const record of passResults) {
        if (record.post_id) {
          if (!accumulator.has(record.post_id)) accumulator.set(record.post_id, record);
        } else {
          const key = (record.text || '').slice(0, 120);
          if (key && !unknownIdAccumulator.some((r) => (r.text || '').slice(0, 120) === key)) {
            unknownIdAccumulator.push(record);
          }
        }
      }

      if (accumulator.size + unknownIdAccumulator.length >= count) break;
      if (pass === 8) break;
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 2));
      await page.waitForTimeout(1_500);
      screenshots.push(await snapshotNav(page, 'read-group', `after-scroll-${pass + 1}`));
    }

    // Normalize counts + age on the Node side.
    const posts = [...accumulator.values(), ...unknownIdAccumulator].slice(0, count).map((r) => ({
      post_id:         r.post_id,
      post_url:        r.post_url,
      author:          r.author,
      text:            r.text,
      age_text:        r.age_text,
      age_hours:       parseAgeHours(r.age_text),
      comments_count:  parseCount(r.comments_raw),
      shares_count:    parseCount(r.shares_raw),
      reactions_count: parseCount(r.reactions_raw),
      photos:          r.photos,
    }));

    emit({
      ok: true,
      group_url: groupUrl,
      posts,
      posts_count: posts.length,
      screenshots: screenshots.filter(Boolean),
    });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    const snap = await snapshotNav(page, 'read-group', 'uncaught').catch(() => null);
    emit({ ok: false, error: 'read_group_failed', details: e.message, screenshots: [...screenshots, snap].filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── Subcommand: read-post ────────────────────────────────────
// Open a single post permalink and return the post body plus its
// comment bodies. This is how the agent re-reviews a thread whose
// comment count went up: the new transaction signal usually lives
// in the comments (a WTB post answered "I have one", a WTS post
// answered "sold / still available", a part located in-thread).
// Strictly read-only.

async function cmdReadPost(args) {
  const postUrl = args.url;
  const maxComments = parseInt(args['max-comments'] || '40', 10);
  if (!postUrl) die('missing_arg', 'read-post requires --url <permalink>');

  const { browser, ctx } = await newContext();
  const page = await ctx.newPage();
  const screenshots = [];
  try {
    await gotoWithRetry(page, postUrl);
    await page.waitForSelector('div[role="banner"], nav', { timeout: 10_000, state: 'attached' }).catch(() => {});
    await page.waitForTimeout(3_500);
    // Best-effort: let comments hydrate before we extract. Comment/reply
    // articles carry aria-label "Comment by …" / "Reply by …". Harmless
    // timeout on a zero-comment post.
    await page.waitForSelector('div[role="article"][aria-label*="omment by" i], div[role="article"][aria-label*="eply by" i]', { timeout: 6_000, state: 'attached' }).catch(() => {});
    screenshots.push(await snapshotNav(page, 'read-post', 'post-goto'));

    const finalUrl = page.url();
    if (urlLooksLikeAuthFail(finalUrl)) {
      emit({
        ok: false,
        error: 'auth_lost_mid_cycle',
        final_url: finalUrl,
        hint: 'Facebook redirected to login when loading this post. Cookies likely partially valid; refresh + restart.',
        screenshots: screenshots.filter(Boolean),
      });
      process.exit(2);
    }
    await assertNotChallenged(page);

    // Best-effort: switch comment ordering to "All comments" and
    // expand a couple of "View more comments" lumps. Comments lazy-
    // load, so scroll + click a few times. Failures are non-fatal;
    // we extract whatever rendered.
    for (let i = 0; i < 4; i++) {
      const more = page.locator(SELECTORS.moreCommentsButton).first();
      if (await more.count() > 0) {
        await more.click({ timeout: 4_000 }).catch(() => {});
        await page.waitForTimeout(1_200);
      }
      await page.evaluate(() => window.scrollBy(0, window.innerHeight * 1.5)).catch(() => {});
      await page.waitForTimeout(1_000);
    }
    screenshots.push(await snapshotNav(page, 'read-post', 'after-expand'));

    const result = await page.evaluate(() => {
      function cleanLines(raw) {
        if (!raw) return [];
        return raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      }
      function extractPostId(url) {
        if (!url) return null;
        const m = url.match(/\/posts\/(\d+)|\/permalink\/(\d+)|multi_permalinks=(\d+)/);
        return (m && (m[1] || m[2] || m[3])) || null;
      }
      const isNoiseLine = (line) =>
        /^(Like|Reply|Share|Follow|Comment|See more|See translation|Sponsored|Edited|Active now|Author)$/i.test(line) ||
        /^· Follow$/i.test(line) ||
        /(contributor|Group expert|Admin|Moderator|Anonymous member)$/i.test(line) ||
        /^\d+\s*(s|m|h|d|w|y|mo)$/i.test(line) ||
        /^(Yesterday|Today)\s+at\s+/i.test(line) ||
        /^\d+(\.\d+)?[KMB]?$/i.test(line) ||
        /^(All comments|Most relevant|Newest|View|Hide)\b/i.test(line) ||
        /^Write a (public )?comment/i.test(line);

      const isCommentAL = (al) => /^(comment|reply) by /i.test(al || '');
      const allArticles = Array.from(document.querySelectorAll('div[role="article"]'));

      // COMMENTS. On a permalink, comments + replies are TOP-LEVEL
      // role="article" elements tagged with aria-label
      // "Comment by <name> …" / "Reply by <name> to <name>" — they are
      // NOT nested inside the post article (the old nested-article
      // assumption is what made read-post return empty). Author comes
      // from the aria-label; body from the cleaned innerText.
      const comments = [];
      for (const a of allArticles) {
        const al = a.getAttribute('aria-label') || '';
        if (!isCommentAL(al)) continue;
        const author = (al.match(/^(?:comment|reply) by (.+?)(?: \d| to | in |$)/i) || [])[1] || null;
        let lines = cleanLines(a.innerText || '').filter((l) => !isNoiseLine(l));
        if (author && lines[0] === author) lines = lines.slice(1);
        const body = lines.join(' ').replace(/\s+/g, ' ').replace(/^[·•·\s]+/, '').trim();
        if (body) comments.push({ author: author || null, text: body.slice(0, 1000) });
      }

      // OP BODY. The original post text is NOT inside a role="article"
      // on the permalink (Facebook renders it in the main story region,
      // and og:description/title meta come back null). Strategy: take
      // the largest dir="auto" text block that is NOT inside a comment
      // article, and reconcile against the document.title middle segment
      // ("<group> | <post text> | Facebook"), which reliably carries the
      // OP's opening (where the part is usually named). Prefer the DOM
      // block only when it confirms the title text — otherwise trust the
      // title, so we don't accidentally grab sidebar / About-group text.
      let domBest = '';
      for (const b of document.querySelectorAll('div[dir="auto"]')) {
        const art = b.closest('div[role="article"]');
        if (art && isCommentAL(art.getAttribute('aria-label') || '')) continue;
        const t = (b.innerText || '').replace(/\s+/g, ' ').trim();
        if (t.length > domBest.length && t.length < 4000) domBest = t;
      }
      const titleParts = (document.title || '').split('|').map((s) => s.trim()).filter(Boolean);
      const titleMid = titleParts.filter((p) => !/^facebook$/i.test(p)).slice(1).join(' ').trim();
      const key = titleMid ? titleMid.slice(0, 25).toLowerCase() : '';
      let opText = '';
      if (titleMid && domBest && domBest.toLowerCase().includes(key)) {
        opText = domBest.length >= titleMid.length ? domBest : titleMid;
      } else if (titleMid) {
        opText = titleMid;
      } else {
        opText = domBest;
      }

      // OP AUTHOR. First non-comment article's first meaningful line.
      let opAuthor = null;
      const opArt = allArticles.find((a) => !isCommentAL(a.getAttribute('aria-label') || '') && (a.innerText || '').trim().length > 0);
      if (opArt) {
        const l = cleanLines(opArt.innerText).filter((x) => !isNoiseLine(x));
        opAuthor = l[0] || null;
      }

      const photos = Array.from(document.querySelectorAll('img[src*="scontent"]')).slice(0, 8)
        .map((i) => i.getAttribute('src')).filter(Boolean);

      return {
        post_id: extractPostId(location.href),
        post: { author: opAuthor, text: (opText || '').slice(0, 4000), photos },
        comments,
      };
    });

    const comments = (result.comments || []).slice(0, maxComments);

    emit({
      ok: true,
      post_url: normalizePostUrl(finalUrl) || postUrl,
      post_id: result.post_id || extractPostId(postUrl),
      post: result.post || null,
      comments,
      comments_returned: comments.length,
      screenshots: screenshots.filter(Boolean),
    });
  } catch (e) {
    if (e.message && /process.exit/.test(e.message)) throw e;
    const snap = await snapshotNav(page, 'read-post', 'uncaught').catch(() => null);
    emit({ ok: false, error: 'read_post_failed', details: e.message, screenshots: [...screenshots, snap].filter(Boolean) });
    process.exit(1);
  } finally {
    await browser.close();
  }
}

// ─── CLI dispatch ─────────────────────────────────────────────

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) { out[a.slice(2, eq)] = a.slice(eq + 1); }
      else { out[a.slice(2)] = argv[i + 1]; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

async function main() {
  const [, , cmd, ...rest] = process.argv;
  const args = parseArgs(rest);
  switch (cmd) {
    case 'auth-check': await cmdAuthCheck(); break;
    case 'read-group': await cmdReadGroup(args); break;
    case 'read-post':  await cmdReadPost(args); break;
    default:
      emit({
        ok: false,
        error: 'unknown_command',
        usage: [
          'fb-groups.js auth-check',
          'fb-groups.js read-group --url <group-url> --count <N>',
          'fb-groups.js read-post --url <permalink> --max-comments <N>',
        ],
      });
      process.exit(1);
  }
}

main().catch((e) => die('uncaught', e.stack || e.message || String(e)));
