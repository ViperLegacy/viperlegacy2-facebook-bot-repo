# viperlegacy2-facebook-bot-repo

Agent code (playbook + Playwright wrapper + config) for the
**ViperLegacy Facebook parts bot**, a read-only clawborrator
worker_v1 agent.

Every hour it visits a rotating handful of the configured Dodge
Viper Facebook groups (round-robin, `scan_per_cycle` per cycle to
keep the Facebook footprint light), reads recent posts **and**
re-reads previously-seen posts whose comment count has changed, and
identifies parts being:

- **searched for** (someone wants a part/car),
- **sold** (someone is offering one), or
- **located** (someone points the community to where a part can be
  had, often surfacing in the comments of a thread),

across the Viper Facebook network. Every finding is indexed by
Viper **generation (1-5)** and by **year + part number / description**.

It NEVER posts, comments, reacts, or DMs. The wrapper exposes no
write verbs.

## How it decides

There is **no keyword filter**. The agent reads each post (and, for
threads whose comment count moved, the comment bodies) and judges
intent on the merits. The only config is which groups to visit and
a year→generation reference map.

## Repository pairing

This repo holds the AGENT CODE (`CLAUDE.md` + `specialists/` +
`config/`). The deployment shape (docker-compose, secrets, `.env`)
lives in the sibling repo **`viperlegacy2-facebook-bot-worker`**.
Same split as the `worker_v1-example-viper-parts-scraper` pair.

## Layout

```
CLAUDE.md                     the agent playbook (read top to bottom)
specialists/fb-groups.js      read-only Playwright wrapper (3 verbs)
config/groups.json            which FB groups to scrape + scan_per_cycle (operator-edited)
config/generations.json       year/slug -> Viper generation (1-5) map
data/state/seen.json          rolling dedup + comment-delta state
data/state/rotation.json      round-robin cursor (which groups scan next)
data/catalog.json             rolling findings index, by generation
data/cycles/<ts>.json         per-cycle audit output
data/screenshots/             per-navigation PNGs (audit)
```

## The wrapper CLI

```sh
# Verify the Facebook cookies still log in:
node specialists/fb-groups.js auth-check

# Scroll a group feed, extract posts + comment/reaction counts:
node specialists/fb-groups.js read-group --url "<group-url>" --count 50

# Open one post permalink, return the body + comment bodies
# (how the agent re-reviews a thread whose comment count changed):
node specialists/fb-groups.js read-post --url "<permalink>" --max-comments 40
```

In the container every call is prefixed with `xvfb-run -a` (headed
Chromium under a virtual display + stealth, to avoid the headless
fingerprint). Cookies load from `/secrets/facebook.cookies.json`
(read-only mount); override the path with `FB_COOKIES_PATH` for
local dev.

## Config

**`config/groups.json`** — `{name, url, active}[]`. The seed list is
placeholder Viper groups; replace with the real ViperLegacy network
group URLs. Edits land on the next cron fire (no restart).

**`config/generations.json`** — inclusive year ranges + chassis-slug
hints per generation (Gen1 1992-1995 … Gen5 2013-2017). The agent
uses it to tag each finding with a generation.

## Selector fragility

Facebook's Comet UI hashes class names, so `SELECTORS` in
`fb-groups.js` leans on `role`, `aria-label`, and `href` patterns.
They WILL break on a FB template change; they're centralized at the
top of the file for one-line fixes. On a stale-selector cycle the
agent commits, notifies `@clauderemote`, and returns rather than
fabricating.

## Deployment

See `viperlegacy2-facebook-bot-worker`. In brief: a single
`ladder99/clawborrator-worker-playwright` container clones this repo
at boot, runs the `CLAUDE.md` playbook, installs an hourly cron, and
reports findings to `@clauderemote` via the clawborrator hub.
