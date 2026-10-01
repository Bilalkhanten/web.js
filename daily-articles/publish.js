#!/usr/bin/env node
'use strict';
/**
 * Daily article publisher (standalone; not connected to the WhatsApp bot).
 *
 * Run once a day (Task Scheduler, cron or GitHub Actions). Each run:
 *   1. skips if you already published today (so a second run never double-posts),
 *   2. picks the area of the day (AI / Python / Cloud / Machine Learning),
 *   3. has Claude write one evergreen article that avoids your recent titles,
 *   4. has Claude review it as a fact-checking editor (approve / revise / reject),
 *   5. publishes to dev.to according to PUBLISH_MODE.
 *
 * PUBLISH_MODE:  draft (default) saves an unpublished draft on dev.to;
 *                live publishes only when the review approves (otherwise saves a draft);
 *                dry prints the article and publishes nothing.
 */

const fs = require('fs');
const path = require('path');
const { makeAsk, askJson, ConfigError } = require('./lib/claude');
const devto = require('./lib/devto');
const content = require('./lib/content');

// Load keys from daily-articles/.env if present (real environment variables win).
function loadEnvFile(file = path.join(__dirname, '.env')) {
    try {
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
            if (!m || line.trim().startsWith('#')) continue;
            let v = m[2];
            if (/^(".*"|'.*')$/.test(v)) v = v.slice(1, -1);
            if (!(m[1] in process.env)) process.env[m[1]] = v;
        }
    } catch {
        /* no .env file: fine */
    }
}

function configFromEnv(env) {
    const mode = (env.PUBLISH_MODE || 'draft').toLowerCase();
    if (!['draft', 'live', 'dry'].includes(mode))
        throw new ConfigError(
            `PUBLISH_MODE must be draft, live or dry (got "${mode}")`,
        );
    return {
        anthropicKey: env.ANTHROPIC_API_KEY,
        anthropicBaseUrl: env.ANTHROPIC_BASE_URL,
        devtoKey: env.DEVTO_API_KEY,
        devtoBaseUrl: env.DEVTO_BASE_URL || 'https://dev.to',
        model: env.ARTICLE_MODEL,
        mode,
        areas: (env.AREAS ? env.AREAS.split(',') : content.DEFAULT_AREAS)
            .map((a) => a.trim())
            .filter(Boolean),
        disclosure: env.ARTICLE_DISCLOSURE,
    };
}

const DRAFT_SYSTEM = (
    area,
) => `You write one article for a developer blog on dev.to.
Area of the day: ${area}.
Choose ONE specific, evergreen topic inside that area (a concept, technique, comparison or how-to that will still be
valid in a year) that is NOT similar to any of the recent titles you are given. Write 800-1100 words of Markdown for
intermediate developers: a short intro, "##" headings, concrete examples, short code blocks, and a brief summary.
Do not put the title in the body.
Strict rules:
- Never invent facts, statistics, quotes, benchmarks, links or sources.
- Do not describe recent events, new releases, prices or anything time-sensitive.
- Only mention library functions, APIs and options you are certain exist. Code must be correct and runnable, using the
  standard library or very well-known packages.
- Never claim personal experience or results. No medical, legal or financial advice.
Reply with ONLY a JSON object, no other text:
{"title": "max 90 characters", "description": "one sentence, max 150 characters",
 "tags": ["up to 4 lowercase single-word tags"], "body_markdown": "the article body"}`;

const REVIEW_SYSTEM = `You are a meticulous technical editor and fact-checker for a developer blog.
You receive an article draft. Check: factual accuracy, that function/API/library names and options really exist,
whether the code would run and do what the text says, invented or unverifiable statistics, quotes or sources,
time-sensitive claims, and misleading statements.
Decide:
- "approve": publishable as it is.
- "revise": fixable - return the complete corrected article body in "body_markdown".
- "reject": fundamentally unreliable or too weak to fix.
Be strict: when you are unsure whether something is true, remove or soften it ("revise") rather than approve.
Reply with ONLY a JSON object: {"verdict": "approve"|"revise"|"reject", "problems": ["short issue", ...],
 "body_markdown": "only when verdict is revise"}`;

async function writeDraft(ask, area, recentTitles, avoidTitle) {
    const prompt =
        `Recent titles (do not repeat or closely rephrase): ${recentTitles.slice(0, 40).join(' | ') || 'none'}` +
        (avoidTitle
            ? `\nAlso avoid this title, it is too similar to an existing one: ${avoidTitle}`
            : '');
    const d = await askJson(ask, DRAFT_SYSTEM(area), prompt);
    if (!d.title || !d.body_markdown || String(d.body_markdown).length < 1500)
        throw new Error('The draft came back incomplete');
    return {
        title: String(d.title).slice(0, 120),
        description: String(d.description || '').slice(0, 150),
        tags: content.cleanTags(
            d.tags,
            content.AREA_TAGS[area.toLowerCase()] || [],
        ),
        body_markdown: String(d.body_markdown).trim(),
    };
}

async function review(ask, draft) {
    const r = await askJson(
        ask,
        REVIEW_SYSTEM,
        `Title: ${draft.title}\n\n${draft.body_markdown}`,
        { effort: 'high' },
    );
    return {
        verdict: ['approve', 'revise', 'reject'].includes(r.verdict)
            ? r.verdict
            : 'reject',
        problems: Array.isArray(r.problems) ? r.problems.map(String) : [],
        body: typeof r.body_markdown === 'string' ? r.body_markdown.trim() : '',
    };
}

/** One full run. Returns { status, ... }; throws on real failures. */
async function run(cfg, { now = new Date(), log = console.log } = {}) {
    const ask = makeAsk(cfg);
    if (cfg.mode !== 'dry' && !cfg.devtoKey)
        throw new ConfigError('DEVTO_API_KEY is not set');
    if (!cfg.anthropicKey)
        throw new ConfigError('ANTHROPIC_API_KEY is not set');

    // 1. History: recent titles to avoid, and "already published today?" so a second run never double-posts.
    let recent = [];
    if (cfg.devtoKey) {
        const mine = await devto.myArticles(cfg);
        recent = mine.map((a) => a.title).filter(Boolean);
        const today = now.toISOString().slice(0, 10);
        const already = mine.some(
            (a) =>
                (a.published_timestamp || a.published_at || '').slice(0, 10) ===
                    today && a.published !== false,
        );
        if (cfg.mode === 'live' && already) {
            log('Already published an article today; nothing to do.');
            return { status: 'skipped' };
        }
    }

    // 2-3. Area of the day and the draft (one retry if the title duplicates an existing article).
    const area = content.pickArea(cfg.areas, now);
    log(`Area of the day: ${area}`);
    let draft = await writeDraft(ask, area, recent);
    const dup = recent.find((t) => content.similar(t, draft.title));
    if (dup) {
        log(
            `Draft "${draft.title}" is too similar to "${dup}"; writing another.`,
        );
        draft = await writeDraft(ask, area, recent, draft.title);
        if (recent.some((t) => content.similar(t, draft.title)))
            throw new Error(
                'Could not find a topic that differs from your recent articles',
            );
    }

    // 4. Review pass: approve / revise (then re-check once) / reject.
    let verdict = await review(ask, draft);
    log(
        `Review: ${verdict.verdict}${verdict.problems.length ? ' - ' + verdict.problems.join('; ') : ''}`,
    );
    let approved = verdict.verdict === 'approve';
    if (verdict.verdict === 'revise' && verdict.body) {
        draft = { ...draft, body_markdown: verdict.body };
        verdict = await review(ask, draft);
        log(`Second review: ${verdict.verdict}`);
        approved = verdict.verdict === 'approve';
    }

    const article = {
        ...draft,
        body_markdown:
            draft.body_markdown + content.disclosureLine(cfg.disclosure),
    };
    const publishLive = cfg.mode === 'live' && approved;

    // 5. Publish according to the mode.
    if (cfg.mode === 'dry') {
        log(
            `--- DRY RUN (nothing published) ---\n${article.title}\nTags: ${article.tags.join(', ')}\n\n${article.body_markdown}`,
        );
        return { status: 'dry', title: article.title, approved };
    }
    const res = await devto.createArticle(cfg, article, publishLive);
    const status = publishLive ? 'published' : 'drafted';
    log(
        publishLive
            ? `Published: ${res.url}`
            : `Saved as an unpublished draft (${cfg.mode === 'live' ? 'the review did not approve it' : 'draft mode'}): ${res.url}`,
    );
    return { status, title: article.title, url: res.url, approved, area };
}

async function main() {
    loadEnvFile();
    let cfg;
    try {
        cfg = configFromEnv(process.env);
        const result = await run(cfg);
        const entry = { at: new Date().toISOString(), ...result };
        try {
            fs.appendFileSync(
                path.join(__dirname, 'published-log.jsonl'),
                JSON.stringify(entry) + '\n',
            );
        } catch {
            /* log file is optional */
        }
    } catch (e) {
        console.error(`FAILED: ${e && e.message ? e.message : e}`);
        process.exitCode = 1; // makes schedulers (and GitHub Actions) report a failed run
    }
}

if (require.main === module) main();

module.exports = { run, configFromEnv, loadEnvFile, review, writeDraft };
