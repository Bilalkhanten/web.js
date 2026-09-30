/**
 * Personal WhatsApp assistant bot built on whatsapp-web.js.
 *
 * Send commands from your own "Message yourself" chat (see !help). Only messages
 * sent from the linked account itself are obeyed; everyone else is ignored.
 *
 * Config (environment variables, all optional):
 *   TZ_OFFSET_MIN   Minutes from UTC for reminder times (default 300 = UTC+5)
 *   HEADLESS        "false" shows the browser window (default: hidden)
 *   BOT_CHROME_PATH Path to a Chrome/Chromium executable (default: bundled Chromium)
 *   BOT_CHROME_ARGS Extra browser flags, space separated
 *   BOT_DATA_DIR    Where login session, reminders and expenses are stored (default ./data)
 */
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth } = require('../index');

const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN ?? 300);
const DATA = path.resolve(
    process.env.BOT_DATA_DIR || path.join(__dirname, 'data'),
);
fs.mkdirSync(DATA, { recursive: true });
const REMINDERS = path.join(DATA, 'reminders.json');
const CONTACTS = path.join(DATA, 'contacts.json');
const EXPENSES = path.join(DATA, 'expenses.csv');
const STALE_MS = 15 * 60000; // never send messages that are more than this late

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA, 'auth') }),
    puppeteer: {
        headless: process.env.HEADLESS !== 'false',
        executablePath: process.env.BOT_CHROME_PATH || undefined,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            ...(process.env.BOT_CHROME_ARGS || '').split(' ').filter(Boolean),
        ],
    },
});

const readJson = (file, fallback) => {
    try {
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return fallback;
    }
};
const load = () => readJson(REMINDERS, []);
const save = (r) => fs.writeFileSync(REMINDERS, JSON.stringify(r, null, 2));
const loadContacts = () => readJson(CONTACTS, {});
const localNow = () => new Date(Date.now() + TZ_OFFSET_MIN * 60000);
const fmt = (ms) =>
    new Date(ms + TZ_OFFSET_MIN * 60000)
        .toISOString()
        .replace('T', ' ')
        .slice(0, 16);
const today = () => localNow().toISOString().slice(0, 10);

/** Due time (UTC ms) for "18:00", "6pm", "6:30pm", "in 10m", "in 2h". */
function parseWhen(t, dayOffset = 0) {
    let m = /^in\s+(\d+)\s*(m|min|h|hr)s?$/i.exec(t);
    if (m) {
        const unit = m[2][0].toLowerCase() === 'h' ? 3600000 : 60000;
        return Date.now() + Number(m[1]) * unit;
    }
    m = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(t);
    if (!m) return null;
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (m[3]) h = (h % 12) + (m[3].toLowerCase() === 'pm' ? 12 : 0);
    if (h > 23 || min > 59) return null;
    const n = localNow();
    let due =
        Date.UTC(
            n.getUTCFullYear(),
            n.getUTCMonth(),
            n.getUTCDate() + dayOffset,
            h,
            min,
        ) -
        TZ_OFFSET_MIN * 60000;
    if (dayOffset === 0 && due <= Date.now()) due += 86400000; // already passed today -> tomorrow
    return due;
}

/** Reads a time from the start of a token list: "tomorrow 7am", "in 10m", "18:00", "6pm". */
function parseTimeTokens(toks) {
    const off = (toks[0] || '').toLowerCase() === 'tomorrow' ? 1 : 0;
    const base = toks.slice(off);
    for (const n of [2, 1]) {
        const when = parseWhen(base.slice(0, n).join(' '), off);
        if (when) return { when, used: off + n };
    }
    return { when: null, used: 0 };
}

function expensesToday() {
    let txt = '';
    try {
        txt = fs.readFileSync(EXPENSES, 'utf8');
    } catch {
        /* no expenses yet */
    }
    return txt
        .split('\n')
        .filter(Boolean)
        .map((l) => {
            const m = /^([^,]+),([^,]+),"(.*)"$/.exec(l);
            return m && { d: m[1], amt: Number(m[2]), note: m[3] };
        })
        .filter((x) => x && x.d === today());
}

async function fireDue() {
    const all = load();
    const now = Date.now();
    const due = all.filter((r) => r.due <= now);
    if (!due.length) return;
    save(all.filter((r) => r.due > now));
    for (const r of due) {
        // A stale message (bot was offline) is reported to you instead of sent late.
        if (now - r.due > STALE_MS) {
            await client.sendMessage(
                r.chat,
                `⚠️ Missed (bot was offline) - NOT sent${r.to ? ' to ' + r.toName : ''}: ${r.text}`,
            );
            continue;
        }
        if (r.to) {
            try {
                await client.sendMessage(r.to, r.text);
                await client.sendMessage(
                    r.chat,
                    `✅ Sent to ${r.toName}: ${r.text}`,
                );
                console.log('sent scheduled message to', r.toName);
            } catch (e) {
                await client.sendMessage(
                    r.chat,
                    `❌ Could not send to ${r.toName}: ${e.message}`,
                );
            }
        } else {
            await client.sendMessage(r.chat, '⏰ Reminder: ' + r.text);
            console.log('fired reminder', r.text);
        }
    }
}

const HELP = [
    'Commands:',
    '!ping - check the bot is alive',
    '!remind 18:00 buy milk  (also: 6pm, 6:30pm, in 10m, in 2h, tomorrow 7am)',
    '!reminders - list pending reminders and scheduled messages',
    '!cancel <number> - cancel an item from that list',
    '!contact add wife 923001234567 - save a name (number with country code, no +)',
    '!contacts - list saved names',
    '!schedule 7am wife Good morning  (also: tomorrow 7am, in 2h)',
    '!spent 12 lunch - log an expense',
    "!today - today's expenses and total",
    '!help - this list',
].join('\n');

async function handle(msg) {
    const body = (msg.body || '').trim();
    if (!body.startsWith('!')) return;
    const [cmd, ...rest] = body.split(/\s+/);
    const arg = rest.join(' ');
    const chat = msg.fromMe ? msg.to : msg.from;
    const say = (t) => client.sendMessage(chat, t);

    switch (cmd.toLowerCase()) {
        case '!ping':
            return say('pong');
        case '!help':
            return say(HELP);
        case '!remind': {
            const toks = arg.split(/\s+/);
            const { when, used } = parseTimeTokens(toks);
            const text = toks.slice(used).join(' ');
            if (!when || !text)
                return say(
                    'Usage: !remind 18:00 buy milk  |  !remind in 10m call mom',
                );
            const all = load();
            all.push({ due: when, text, chat });
            save(all);
            return say(`✅ Okay, I'll remind you at ${fmt(when)}: ${text}`);
        }
        case '!contact': {
            const m = /^add\s+(\S+)\s+\+?(\d{8,15})$/i.exec(arg);
            if (!m) return say('Usage: !contact add wife 923001234567');
            const id = await client.getNumberId(m[2]);
            if (!id)
                return say(
                    `❌ ${m[2]} is not on WhatsApp. Check the number (country code, no +, no spaces).`,
                );
            const c = loadContacts();
            c[m[1].toLowerCase()] = id._serialized;
            fs.writeFileSync(CONTACTS, JSON.stringify(c, null, 2));
            return say(`✅ Saved ${m[1].toLowerCase()} -> ${m[2]}`);
        }
        case '!contacts': {
            const c = loadContacts();
            const names = Object.keys(c);
            return say(
                names.length
                    ? names
                          .map((n) => `• ${n} (${c[n].split('@')[0]})`)
                          .join('\n')
                    : 'No contacts. Use: !contact add wife 923001234567',
            );
        }
        case '!schedule': {
            const toks = arg.split(/\s+/);
            const { when, used } = parseTimeTokens(toks);
            const name = (toks[used] || '').toLowerCase();
            const text = toks.slice(used + 1).join(' ');
            if (!when || !name || !text)
                return say('Usage: !schedule 7am wife Good morning');
            const id = loadContacts()[name];
            if (!id)
                return say(
                    `Unknown contact "${name}". Add it first: !contact add ${name} 923001234567`,
                );
            const all = load();
            all.push({ due: when, text, chat, to: id, toName: name });
            save(all);
            return say(
                `✅ Scheduled for ${fmt(when)} to ${name}: ${text}\n(Use !reminders to review, !cancel <number> to undo)`,
            );
        }
        case '!reminders': {
            const mine = load()
                .filter((r) => r.chat === chat)
                .sort((a, b) => a.due - b.due);
            return say(
                mine.length
                    ? mine
                          .map(
                              (r, i) =>
                                  `${i + 1}. ${fmt(r.due)} ${r.to ? '→ ' + r.toName + ': ' : '- '}${r.text}`,
                          )
                          .join('\n')
                    : 'No pending reminders.',
            );
        }
        case '!cancel': {
            const all = load();
            const mine = all
                .filter((r) => r.chat === chat)
                .sort((a, b) => a.due - b.due);
            const target = mine[Number(arg) - 1];
            if (!target) return say('Usage: !cancel <number> (see !reminders)');
            save(
                all.filter(
                    (r) =>
                        r !==
                        all.find(
                            (y) =>
                                y.due === target.due &&
                                y.text === target.text &&
                                y.chat === target.chat,
                        ),
                ),
            );
            return say('Cancelled: ' + target.text);
        }
        case '!spent': {
            const m = /^(\d+(?:\.\d+)?)\s*(.*)$/.exec(arg);
            if (!m) return say('Usage: !spent 12 lunch');
            fs.appendFileSync(
                EXPENSES,
                `${today()},${m[1]},"${m[2].replace(/"/g, "'")}"\n`,
            );
            const total = expensesToday().reduce((s, e) => s + e.amt, 0);
            return say(`💸 Logged ${m[1]} ${m[2]}\nToday's total: ${total}`);
        }
        case '!today': {
            const e = expensesToday();
            return say(
                e.length
                    ? e.map((x) => `• ${x.amt} ${x.note}`).join('\n') +
                          `\nTotal: ${e.reduce((s, x) => s + x.amt, 0)}`
                    : 'No expenses logged today.',
            );
        }
        default:
            return say('Unknown command. Send !help');
    }
}

client.on('qr', (qr) => {
    console.log('Scan this QR with WhatsApp > Linked devices > Link a device:');
    qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => console.log('AUTHENTICATED'));
client.on('auth_failure', (m) => console.log('AUTH FAILURE', m));
client.on('disconnected', (r) => console.log('DISCONNECTED', r));
client.on('ready', () => {
    console.log('READY, logged in as', client.info.wid.user);
    setInterval(
        () => fireDue().catch((e) => console.log('fireDue error', e.message)),
        10000,
    );
});
// Only obey messages sent from YOUR OWN account; ignore everyone else.
client.on('message_create', (msg) => {
    if (msg.fromMe)
        handle(msg).catch((e) => console.log('handler error', e.message));
});

process.on('uncaughtException', (e) =>
    console.log('UNCAUGHT', (e && e.stack) || e),
);
process.on('unhandledRejection', (e) =>
    console.log('UNHANDLED', (e && e.stack) || e),
);

client.initialize().catch((e) => {
    console.error('INIT ERROR', e.message);
    process.exit(1);
});
