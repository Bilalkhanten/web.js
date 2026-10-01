'use strict';
// Tests run the real Anthropic SDK against local fake Claude and dev.to servers: nothing is spent or published.
const http = require('http');
const assert = require('assert');
const { spawn } = require('child_process');
const path = require('path');
const { run, configFromEnv } = require('../publish');
const content = require('../lib/content');

const BODY = (t) => `Intro about ${t}. ` + 'word '.repeat(400);
const seen = { claude: [], devto: [] };
const S = {
    // scripted server behaviour, reset per test
    articles: [],
    reviews: [],
    titles: [],
    jsonBroken: 0,
    refuse: false,
};
const reset = () => {
    seen.claude = [];
    seen.devto = [];
    Object.assign(S, {
        articles: [],
        reviews: [],
        titles: ['Understanding Python Generators'],
        jsonBroken: 0,
        refuse: false,
    });
};
const msg = (text, stop = 'end_turn') => ({
    id: 'm',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [{ type: 'text', text }],
    stop_reason: stop,
    stop_sequence: null,
    usage: { input_tokens: 1, output_tokens: 1 },
});

const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
        const send = (code, o) => {
            res.writeHead(code, { 'content-type': 'application/json' });
            res.end(JSON.stringify(o));
        };
        if (req.url.startsWith('/v1/messages')) {
            const body = JSON.parse(raw);
            seen.claude.push({ headers: req.headers, body });
            if (S.refuse) return send(200, msg('', 'refusal'));
            if (S.jsonBroken > 0) {
                S.jsonBroken--;
                return send(200, msg('Sorry, here is no JSON at all'));
            }
            if (/meticulous technical editor/.test(body.system)) {
                const r = S.reviews.shift() || {
                    verdict: 'approve',
                    problems: [],
                };
                return send(200, msg(JSON.stringify(r)));
            }
            const t = S.titles.shift() || 'Generics in Go Explained';
            return send(
                200,
                msg(
                    '```json\n' +
                        JSON.stringify({
                            title: t,
                            description: 'About ' + t,
                            tags: ['Cool Stuff!', 'tutorial', 'dev', 'x', 'y'],
                            body_markdown: BODY(t),
                        }) +
                        '\n```',
                ),
            );
        }
        if (req.url.startsWith('/api/articles/me/all')) {
            seen.devto.push({ get: true, headers: req.headers });
            return send(200, S.articles);
        }
        if (req.url === '/api/articles' && req.method === 'POST') {
            const body = JSON.parse(raw);
            seen.devto.push({ headers: req.headers, body });
            return send(201, { id: 7, url: 'https://dev.to/me/post-7' });
        }
        send(404, {});
    });
});

const cfgFor = (port, over = {}) =>
    configFromEnv({
        ANTHROPIC_API_KEY: 'ck',
        DEVTO_API_KEY: 'dk',
        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
        DEVTO_BASE_URL: `http://127.0.0.1:${port}`,
        PUBLISH_MODE: 'live',
        ...over,
    });
const quiet = { log: () => {} };
const posts = () => seen.devto.filter((d) => d.body);
const NOW = new Date(Date.UTC(2026, 9, 1, 6, 0)); // day-of-year 274 -> 274 % 4 = 2 -> "Cloud"
const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('pure helpers', async () => {
    assert.deepStrictEqual(
        content.pickArea(['A', 'B', 'C', 'D'], new Date(Date.UTC(2026, 0, 1))),
        'B',
    ); // day 1 -> 1 % 4
    const seenAreas = new Set(
        Array.from({ length: 8 }, (_, i) =>
            content.pickArea(
                ['A', 'B', 'C', 'D'],
                new Date(Date.UTC(2026, 5, 1 + i)),
            ),
        ),
    );
    assert.strictEqual(seenAreas.size, 4, 'every area comes up');
    assert(
        content.similar(
            'Understanding Python Generators',
            'Python generators understanding',
        ),
    );
    assert(
        !content.similar(
            'Intro to Docker networking',
            'Understanding Python Generators',
        ),
    );
    assert.deepStrictEqual(
        content.cleanTags(
            ['AI!', 'Machine Learning', 'ai', 'a b', 'x', 'y'],
            ['python'],
        ),
        ['ai', 'machinelearning', 'ab', 'python'],
    );
    assert(
        content.disclosureLine('').includes('written with AI assistance') &&
            content.disclosureLine('  custom words ').includes('custom words'),
    );
    assert.throws(
        () => configFromEnv({ PUBLISH_MODE: 'yolo' }),
        /PUBLISH_MODE/,
    );
    assert.strictEqual(
        configFromEnv({}).mode,
        'draft',
        'draft is the default mode',
    );
});

test('live: writes, reviews, publishes with disclosure and area tag', async (port) => {
    S.articles = [
        {
            title: 'Old post about Rust',
            published: true,
            published_at: '2026-09-20T05:00:00Z',
        },
    ];
    const r = await run(cfgFor(port), { now: NOW, ...quiet });
    assert.strictEqual(r.status, 'published');
    assert.strictEqual(r.area, 'Cloud');
    assert.strictEqual(
        seen.claude.length,
        2,
        'one draft call + one review call',
    );
    const [draftReq, reviewReq] = seen.claude;
    assert.strictEqual(draftReq.headers['x-api-key'], 'ck');
    assert.strictEqual(draftReq.body.model, 'claude-opus-5-5');
    assert.strictEqual(draftReq.body.fallbacks, 'default');
    assert(
        String(draftReq.headers['anthropic-beta']).includes(
            'server-side-fallback-2026-07-01',
        ),
    );
    assert(/Area of the day: Cloud/.test(draftReq.body.system));
    assert(
        /Old post about Rust/.test(draftReq.body.messages[0].content),
        'recent titles are passed to avoid repeats',
    );
    assert.strictEqual(reviewReq.body.output_config.effort, 'high');
    const p = posts()[0];
    assert.strictEqual(p.headers['api-key'], 'dk');
    assert.strictEqual(p.body.article.published, true);
    assert(/written with AI assistance/.test(p.body.article.body_markdown));
    assert(
        p.body.article.tags.includes('cloud') &&
            p.body.article.tags.length <= 4,
    );
    assert.deepStrictEqual(
        p.body.article.tags,
        ['coolstuff', 'tutorial', 'dev', 'cloud'],
        'model tags first, area tag guaranteed within 4',
    );
});

test('draft mode (default) never publishes', async (port) => {
    const r = await run(cfgFor(port, { PUBLISH_MODE: 'draft' }), {
        now: NOW,
        ...quiet,
    });
    assert.strictEqual(r.status, 'drafted');
    assert.strictEqual(posts()[0].body.article.published, false);
});

test('already published today: skips without calling Claude', async (port) => {
    S.articles = [
        {
            title: 'Today post',
            published: true,
            published_at: '2026-10-01T01:00:00Z',
        },
    ];
    const r = await run(cfgFor(port), { now: NOW, ...quiet });
    assert.strictEqual(r.status, 'skipped');
    assert.strictEqual(seen.claude.length, 0);
    assert.strictEqual(posts().length, 0);
});

test('review rejects: live mode only saves a draft', async (port) => {
    S.reviews = [{ verdict: 'reject', problems: ['invented statistic'] }];
    const r = await run(cfgFor(port), { now: NOW, ...quiet });
    assert.strictEqual(r.status, 'drafted');
    assert.strictEqual(posts()[0].body.article.published, false);
});

test('review asks for a revision: corrected body is used and re-checked', async (port) => {
    S.reviews = [
        {
            verdict: 'revise',
            problems: ['wrong function name'],
            body_markdown: 'FIXED BODY ' + 'word '.repeat(400),
        },
        { verdict: 'approve', problems: [] },
    ];
    const r = await run(cfgFor(port), { now: NOW, ...quiet });
    assert.strictEqual(r.status, 'published');
    assert.strictEqual(seen.claude.length, 3);
    assert(
        /Article body|FIXED BODY/.test(posts()[0].body.article.body_markdown) &&
            posts()[0].body.article.body_markdown.startsWith('FIXED BODY'),
    );
    assert(
        /FIXED BODY/.test(seen.claude[2].body.messages[0].content),
        'second review sees the corrected text',
    );
    seen.claude = [];
    seen.devto = [];
    S.titles = ['Another Cloud Topic Entirely'];
    S.reviews = [
        { verdict: 'revise', problems: [], body_markdown: 'x '.repeat(900) },
        { verdict: 'reject', problems: ['still wrong'] },
    ];
    const r2 = await run(cfgFor(port), { now: NOW, ...quiet });
    assert.strictEqual(
        r2.status,
        'drafted',
        'a revision that still fails is not published',
    );
});

test('duplicate topic: writes another, or fails if it is still a duplicate', async (port) => {
    S.articles = [
        {
            title: 'Understanding Python Generators',
            published: true,
            published_at: '2026-09-01T00:00:00Z',
        },
    ];
    S.titles = [
        'Python Generators Understanding',
        'Kubernetes Probes in Plain English',
    ];
    const r = await run(cfgFor(port), { now: NOW, ...quiet });
    assert.strictEqual(r.title, 'Kubernetes Probes in Plain English');
    assert(
        /too similar to an existing one: Python Generators Understanding/.test(
            seen.claude[1].body.messages[0].content,
        ),
    );
    reset();
    S.articles = [
        {
            title: 'Understanding Python Generators',
            published: true,
            published_at: '2026-09-01T00:00:00Z',
        },
    ];
    S.titles = [
        'Python Generators Understanding',
        'Generators Python Understanding',
    ];
    await assert.rejects(
        () => run(cfgFor(port), { now: NOW, ...quiet }),
        /differs from your recent articles/,
    );
    assert.strictEqual(posts().length, 0);
});

test('dry mode prints and publishes nothing (and needs no dev.to key)', async (port) => {
    const out = [];
    const r = await run(
        cfgFor(port, { PUBLISH_MODE: 'dry', DEVTO_API_KEY: '' }),
        { now: NOW, log: (s) => out.push(s) },
    );
    assert.strictEqual(r.status, 'dry');
    assert.strictEqual(seen.devto.length, 0);
    assert(out.join('\n').includes('DRY RUN'));
});

test('failures: missing keys, refusal, broken JSON', async (port) => {
    await assert.rejects(
        () =>
            run(cfgFor(port, { ANTHROPIC_API_KEY: '' }), {
                now: NOW,
                ...quiet,
            }),
        /ANTHROPIC_API_KEY is not set/,
    );
    await assert.rejects(
        () => run(cfgFor(port, { DEVTO_API_KEY: '' }), { now: NOW, ...quiet }),
        /DEVTO_API_KEY is not set/,
    );
    S.refuse = true;
    await assert.rejects(
        () => run(cfgFor(port), { now: NOW, ...quiet }),
        /declined/,
    );
    S.refuse = false;
    S.jsonBroken = 1;
    const ok = await run(cfgFor(port), { now: NOW, ...quiet });
    assert.strictEqual(
        ok.status,
        'published',
        'one broken JSON reply is retried',
    );
    reset();
    S.jsonBroken = 5;
    await assert.rejects(() => run(cfgFor(port), { now: NOW, ...quiet }));
    assert.strictEqual(posts().length, 0, 'nothing published after a failure');
});

test('command line: exit code 0 on success, 1 on failure', async (port) => {
    const exec = (env) =>
        new Promise((resolve) => {
            const c = spawn(
                process.execPath,
                [path.join(__dirname, '..', 'publish.js')],
                {
                    env: {
                        PATH: process.env.PATH,
                        ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
                        DEVTO_BASE_URL: `http://127.0.0.1:${port}`,
                        ...env,
                    },
                    cwd: path.join(__dirname, '..'),
                },
            );
            let out = '';
            c.stdout.on('data', (d) => (out += d));
            c.stderr.on('data', (d) => (out += d));
            c.on('close', (code) => resolve({ code, out }));
        });
    const ok = await exec({
        ANTHROPIC_API_KEY: 'ck',
        DEVTO_API_KEY: 'dk',
        PUBLISH_MODE: 'live',
    });
    assert.strictEqual(ok.code, 0, ok.out);
    assert(/Published: https:\/\/dev\.to\/me\/post-7/.test(ok.out));
    const bad = await exec({ DEVTO_API_KEY: 'dk', PUBLISH_MODE: 'live' });
    assert.strictEqual(bad.code, 1);
    assert(/FAILED: .*ANTHROPIC_API_KEY/.test(bad.out));
    require('fs').rmSync(path.join(__dirname, '..', 'published-log.jsonl'), {
        force: true,
    });
});

server.listen(0, '127.0.0.1', async () => {
    const port = server.address().port;
    let failed = 0;
    for (const [name, fn] of tests) {
        reset();
        try {
            await fn(port);
            console.log('ok  -', name);
        } catch (e) {
            failed++;
            console.log(
                'FAIL-',
                name,
                '\n     ',
                String(e.message).slice(0, 400),
            );
        }
    }
    console.log(
        failed
            ? `${failed} test(s) FAILED`
            : `ALL ${tests.length} TESTS PASSED`,
    );
    server.close();
    process.exit(failed ? 1 : 0);
});
