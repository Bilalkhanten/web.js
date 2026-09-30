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
const { execFileSync } = require('child_process');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { Client, LocalAuth, Poll } = require('../index');

const TZ_OFFSET_MIN = Number(process.env.TZ_OFFSET_MIN ?? 300);
const DATA = path.resolve(
    process.env.BOT_DATA_DIR || path.join(__dirname, 'data'),
);
fs.mkdirSync(DATA, { recursive: true });
const REMINDERS = path.join(DATA, 'reminders.json');
const CONTACTS = path.join(DATA, 'contacts.json');
const EXPENSES = path.join(DATA, 'expenses.csv');
const SHOPPING = path.join(DATA, 'shopping.json');
const BIRTHDAYS = path.join(DATA, 'birthdays.json');
const TEMPLATES = path.join(DATA, 'templates.json');
const STATE = path.join(DATA, 'state.json');
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
        if (base.length < n) continue; // not enough words left for an n-word time
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

const isWeekend = (ms) =>
    [0, 6].includes(new Date(ms + TZ_OFFSET_MIN * 60000).getUTCDay());

/** Next occurrence of a repeating reminder that is still in the future. */
function nextDue(due, repeat, now) {
    let d = due;
    do {
        d += 86400000 * (repeat === 'weekly' ? 7 : 1);
        if (repeat === 'weekdays') while (isWeekend(d)) d += 86400000;
    } while (d <= now);
    return d;
}

async function fireDue() {
    const all = load();
    const now = Date.now();
    const due = all.filter((r) => r.due <= now);
    if (!due.length) return;
    // Repeating reminders are put back with their next time; everything else is removed.
    const again = due
        .filter((r) => r.repeat)
        .map((r) => ({ ...r, due: nextDue(r.due, r.repeat, now) }));
    save([...all.filter((r) => r.due > now), ...again]);
    for (const r of due) {
        // A stale message (bot was offline) is reported to you instead of sent late.
        if (now - r.due > STALE_MS) {
            await send(
                r.chat,
                `⚠️ Missed (bot was offline) - NOT sent${r.to ? ' to ' + r.toName : ''}: ${r.text}`,
            );
            continue;
        }
        if (r.to) {
            try {
                await client.sendMessage(r.to, r.text);
                await send(r.chat, `✅ Sent to ${r.toName}: ${r.text}`);
                console.log('sent scheduled message to', r.toName);
            } catch (e) {
                await send(
                    r.chat,
                    `❌ Could not send to ${r.toName}: ${e.message}`,
                );
            }
        } else {
            await send(r.chat, '⏰ Reminder: ' + r.text);
            console.log('fired reminder', r.text);
        }
    }
}

// Every message the bot sends to you starts with an invisible marker, so it can
// tell its own messages apart from your answers (both come from your account).
const MARK = '​';
const send = (chat, content) =>
    client.sendMessage(
        chat,
        typeof content === 'string' ? MARK + content : content,
    );

function addReminder(chat, when, text) {
    const all = load();
    all.push({ due: when, text, chat });
    save(all);
    return `✅ Okay, I'll remind you at ${fmt(when)}: ${text}`;
}

function addScheduled(chat, when, name, text) {
    const id = loadContacts()[name];
    if (!id)
        return `Unknown contact "${name}". Add it first: !contact add ${name} 923001234567`;
    const all = load();
    all.push({ due: when, text, chat, to: id, toName: name });
    save(all);
    return `✅ Scheduled for ${fmt(when)} to ${name}: ${text}\n(Use !reminders to review, !cancel <number> to undo)`;
}

function remindersText(chat) {
    const mine = load()
        .filter((r) => r.chat === chat)
        .sort((a, b) => a.due - b.due);
    return mine.length
        ? mine
              .map(
                  (r, i) =>
                      `${i + 1}. ${fmt(r.due)} ${r.repeat ? '🔁 ' : ''}${r.to ? '→ ' + r.toName + ': ' : '- '}${r.text}`,
              )
              .join('\n')
        : 'No pending reminders.';
}

function todayText() {
    const e = expensesToday();
    return e.length
        ? e.map((x) => `• ${x.amt} ${x.note}`).join('\n') +
              `\nTotal: ${e.reduce((s, x) => s + x.amt, 0)}`
        : 'No expenses logged today.';
}

// ---- Poll menu (!menu) and the step-by-step questions it starts ----
const MENU = [
    ['⏰ Remind me', 'remind'],
    ['🔁 Repeat reminder', 'repeat'],
    ['📨 Schedule a message', 'schedule'],
    ['💬 Quick message', 'quick'],
    ['👥 Message a group', 'group'],
    ['🛒 Shopping list', 'shop'],
    ['🎂 Birthdays', 'birthdays'],
    ['📰 News & markets', 'news'],
    ['📋 My reminders', 'reminders'],
];
const menuPolls = new Map(); // poll message id -> chat it was sent in
const flowPolls = new Map(); // flow poll message id -> chat
const flows = new Map(); // chat -> { kind, step, data, expires, pollId }
const FLOW_MS = 10 * 60000;
const CANCEL_OPT = '✖ Cancel';
const OTHER_TIME = '🕒 Other time…';
const WRITE_OWN = '✍️ Write my own…';
const TIME_PROMPT =
    'When? For example: 6pm, 18:30, in 10m, tomorrow 7am\n(send "cancel" to stop)';
const TIME_CHOICES = {
    'In 1 hour': () => Date.now() + 3600000,
    'Tonight 9pm': () => parseWhen('9pm'),
    'Tomorrow 7am': () => parseWhen('7am', 1),
    'Tomorrow 9am': () => parseWhen('9am', 1),
};
const DAY_TIMES = {
    '7:00 am': '7am',
    '9:00 am': '9am',
    '12:00 pm': '12pm',
    '6:00 pm': '6pm',
    '9:00 pm': '9pm',
};
const FREQS = {
    'Every day': 'daily',
    'Every weekday (Mon-Fri)': 'weekdays',
    'Every week': 'weekly',
};
const FREQ_LABEL = {
    daily: 'every day',
    weekdays: 'every weekday',
    weekly: 'every week',
};
// Links sent by the "News & markets" option. Edit this list to change the sources.
const NEWS = {
    '📈 Stocks': [
        ['Yahoo Finance', 'https://finance.yahoo.com/'],
        ['Google Finance', 'https://www.google.com/finance/'],
        [
            'TradingView - most active US stocks',
            'https://www.tradingview.com/markets/stocks-usa/market-movers-active/',
        ],
    ],
    '🌍 World news': [
        ['BBC News - World', 'https://www.bbc.com/news/world'],
        ['Al Jazeera', 'https://www.aljazeera.com/news/'],
        ['DW - Top stories', 'https://www.dw.com/en/top-stories/s-9097'],
    ],
    '🤖 AI news': [
        [
            'MIT Technology Review - AI',
            'https://www.technologyreview.com/topic/artificial-intelligence/',
        ],
        ['Ars Technica - AI', 'https://arstechnica.com/ai/'],
        [
            'The Verge - AI',
            'https://www.theverge.com/ai-artificial-intelligence',
        ],
    ],
};
const newsText = (title) =>
    `${title}\n` + NEWS[title].map(([n, u]) => `• ${n}\n${u}`).join('\n');

const DEFAULT_TEMPLATES = [
    'Good morning ❤️',
    'On my way',
    'Call me when you are free',
    'I will be late',
    'Thank you 🙏',
];
const MONTHS = [
    'jan',
    'feb',
    'mar',
    'apr',
    'may',
    'jun',
    'jul',
    'aug',
    'sep',
    'oct',
    'nov',
    'dec',
];

const isGroupId = (id) => id.endsWith('@g.us');
function contactNames(groupsOnly) {
    const c = loadContacts();
    return Object.keys(c).filter((n) => isGroupId(c[n]) === groupsOnly);
}
const loadTemplates = () => readJson(TEMPLATES, DEFAULT_TEMPLATES);
const loadShopping = () => readJson(SHOPPING, []);
const saveShopping = (l) => fs.writeFileSync(SHOPPING, JSON.stringify(l));
const loadBirthdays = () => readJson(BIRTHDAYS, []);
const saveBirthdays = (l) =>
    fs.writeFileSync(BIRTHDAYS, JSON.stringify(l, null, 2));

function addRepeating(chat, when, freq, text) {
    while (freq === 'weekdays' && isWeekend(when)) when += 86400000;
    const all = load();
    all.push({ due: when, text, chat, repeat: freq });
    save(all);
    return `✅ Okay, I'll remind you ${FREQ_LABEL[freq]} (first: ${fmt(when)}): ${text}\n(Use !reminders to review, !cancel <number> to stop it)`;
}

/** "15/03", "15-3", "15 March", "March 15" -> { day, month } (day first, like 15/03). */
function parseDayMonth(text) {
    const t = text.trim().toLowerCase();
    let day, month, m;
    if ((m = /^(\d{1,2})\s*[/\-. ]\s*(\d{1,2})$/.exec(t))) {
        day = Number(m[1]);
        month = Number(m[2]);
    } else if ((m = /^(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,})$/.exec(t))) {
        day = Number(m[1]);
        month = MONTHS.indexOf(m[2].slice(0, 3)) + 1;
    } else if ((m = /^([a-z]{3,})\s+(\d{1,2})(?:st|nd|rd|th)?$/.exec(t))) {
        day = Number(m[2]);
        month = MONTHS.indexOf(m[1].slice(0, 3)) + 1;
    }
    const maxDay = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
    return month >= 1 && month <= 12 && day >= 1 && day <= maxDay
        ? { day, month }
        : null;
}

function shopText(list) {
    return list.length
        ? '🛒 Shopping list:\n' +
              list.map((x, i) => `${i + 1}. ${x}`).join('\n')
        : '🛒 Your shopping list is empty.';
}

function birthdaysText() {
    const n = localNow();
    const y = n.getUTCFullYear();
    const startOfToday = Date.UTC(y, n.getUTCMonth(), n.getUTCDate());
    const rows = loadBirthdays()
        .map((b) => {
            let t = Date.UTC(y, b.month - 1, b.day);
            if (t < startOfToday) t = Date.UTC(y + 1, b.month - 1, b.day);
            return { ...b, days: Math.round((t - startOfToday) / 86400000) };
        })
        .sort((a, b) => a.days - b.days)
        .slice(0, 10);
    return rows.length
        ? '🎂 Upcoming birthdays:\n' +
              rows
                  .map(
                      (b) =>
                          `• ${b.day} ${MONTHS[b.month - 1]} - ${b.name} (${b.days === 0 ? 'today' : 'in ' + b.days + ' days'})`,
                  )
                  .join('\n')
        : '🎂 No birthdays saved yet.';
}

// Once a day (after 8am) remind you about today's and tomorrow's birthdays.
async function checkBirthdays() {
    const n = localNow();
    if (n.getUTCHours() < 8) return;
    const st = readJson(STATE, {});
    if (st.birthdays === today()) return;
    st.birthdays = today();
    fs.writeFileSync(STATE, JSON.stringify(st));
    const t = new Date(n.getTime() + 86400000);
    for (const b of loadBirthdays()) {
        if (b.month === n.getUTCMonth() + 1 && b.day === n.getUTCDate())
            await send(b.chat, `🎂 Today is ${b.name}'s birthday!`);
        else if (b.month === t.getUTCMonth() + 1 && b.day === t.getUTCDate())
            await send(b.chat, `🎂 Tomorrow is ${b.name}'s birthday.`);
    }
}

// The menu is only offered in your own "Message yourself" chat, so nobody else can vote on it.
async function isSelfChat(chat) {
    try {
        if ((await client.getContactById(chat)).isMe) return true;
    } catch {
        /* fall through to the id check */
    }
    return chat.split('@')[0] === client.info.wid.user;
}

async function sendMenu(chat) {
    const poll = await client.sendMessage(
        chat,
        new Poll(
            MARK + 'What do you want to do?',
            MENU.map((m) => m[0]),
        ),
    );
    menuPolls.set(poll.id._serialized, chat);
}

function typedTime(f, text) {
    const toks = text.split(/\s+/);
    const { when, used } = parseTimeTokens(toks);
    if (!when || used !== toks.length)
        return "I couldn't read that time. Try 6pm, 18:30, in 10m or tomorrow 7am.";
    f.data.when = when;
    return null;
}

// Each step is either a poll to tap (poll + tap) and/or a text answer (prompt + typed).
// tap() returns 'ok' (answer accepted), 'retype' (now type the answer) or 'ignore'.
const STEP = {
    who: {
        names: (f) => contactNames(f.kind === 'group'),
        poll(f) {
            const n = this.names(f);
            return n.length <= 11
                ? {
                      title:
                          f.kind === 'group'
                              ? 'Which group?'
                              : 'Who should get the message?',
                      options: [...n, CANCEL_OPT],
                  }
                : null;
        },
        prompt(f) {
            return `Type a saved name: ${this.names(f).join(', ')}\n(send "cancel" to stop)`;
        },
        tap(f, c) {
            if (!this.names(f).includes(c.toLowerCase())) return 'ignore';
            f.data.name = c.toLowerCase();
            return 'ok';
        },
        typed(f, t) {
            if (this.tap(f, t) === 'ok') return null;
            return `I don't know "${t}". Saved: ${this.names(f).join(', ')}`;
        },
    },
    time: {
        poll: () => ({
            title: 'When?',
            options: [...Object.keys(TIME_CHOICES), OTHER_TIME, CANCEL_OPT],
        }),
        prompt: () => TIME_PROMPT,
        tap(f, c) {
            if (c === OTHER_TIME) return 'retype';
            if (!TIME_CHOICES[c]) return 'ignore';
            f.data.when = TIME_CHOICES[c]();
            return 'ok';
        },
        typed: typedTime,
    },
    rtime: {
        poll: () => ({
            title: 'What time of day?',
            options: [...Object.keys(DAY_TIMES), OTHER_TIME, CANCEL_OPT],
        }),
        prompt: () => TIME_PROMPT,
        tap(f, c) {
            if (c === OTHER_TIME) return 'retype';
            if (!DAY_TIMES[c]) return 'ignore';
            f.data.when = parseWhen(DAY_TIMES[c]);
            return 'ok';
        },
        typed: typedTime,
    },
    freq: {
        poll: () => ({
            title: 'How often?',
            options: [...Object.keys(FREQS), CANCEL_OPT],
        }),
        prompt: () => 'Type daily, weekdays or weekly',
        tap(f, c) {
            if (!FREQS[c]) return 'ignore';
            f.data.freq = FREQS[c];
            return 'ok';
        },
        typed(f, t) {
            const k = ['daily', 'weekdays', 'weekly'].find(
                (x) => x === t.toLowerCase(),
            );
            if (!k) return 'Tap an option, or type daily, weekdays or weekly.';
            f.data.freq = k;
            return null;
        },
    },
    text: {
        prompt: (f) =>
            f.kind === 'remind' || f.kind === 'repeat'
                ? '✍️ What should I remind you about?'
                : f.data.name
                  ? `✍️ Write your message to ${f.data.name}:`
                  : '✍️ Write your message:',
        typed(f, t) {
            f.data.text = t;
            return null;
        },
    },
    template: {
        poll: () => ({
            title: 'Which message?',
            options: [...loadTemplates().slice(0, 9), WRITE_OWN, CANCEL_OPT],
        }),
        prompt: () => 'Pick a message',
        tap(f, c) {
            if (c === WRITE_OWN) f.data.custom = true;
            else if (loadTemplates().includes(c)) f.data.text = c;
            else return 'ignore';
            return 'ok';
        },
    },
    shopAction: {
        acts: {
            '➕ Add item': 'add',
            '📄 Show list': 'show',
            '✅ Remove item': 'remove',
            '🧹 Clear list': 'clear',
        },
        poll() {
            return {
                title: 'Shopping list',
                options: [...Object.keys(this.acts), CANCEL_OPT],
            };
        },
        prompt: () => 'Tap an option',
        tap(f, c) {
            if (!this.acts[c]) return 'ignore';
            f.data.action = this.acts[c];
            return 'ok';
        },
    },
    item: {
        prompt: () =>
            '✍️ Which item(s)? Separate several with commas.\n(send "cancel" to stop)',
        typed(f, t) {
            f.data.items = t
                .split(/[,\n]/)
                .map((x) => x.trim())
                .filter(Boolean);
            return f.data.items.length
                ? null
                : 'Please type at least one item.';
        },
    },
    shopRemove: {
        poll() {
            const items = loadShopping();
            return items.length <= 11
                ? {
                      title: 'Remove which item?',
                      options: [...items, CANCEL_OPT],
                  }
                : null;
        },
        prompt: () => 'Type the number or name of the item to remove',
        tap(f, c) {
            if (!loadShopping().includes(c)) return 'ignore';
            f.data.item = c;
            return 'ok';
        },
        typed(f, t) {
            const items = loadShopping();
            const hit = /^\d+$/.test(t)
                ? items[Number(t) - 1]
                : items.find((x) => x.toLowerCase() === t.toLowerCase());
            if (!hit) return "I couldn't find that item. " + shopText(items);
            f.data.item = hit;
            return null;
        },
    },
    shopConfirm: {
        poll: () => ({
            title: 'Clear the whole shopping list?',
            options: ['Yes, clear it', 'No, keep it', CANCEL_OPT],
        }),
        prompt: () => 'Tap Yes or No',
        tap(f, c) {
            if (c !== 'Yes, clear it' && c !== 'No, keep it') return 'ignore';
            f.data.confirm = c === 'Yes, clear it';
            return 'ok';
        },
    },
    newsPick: {
        poll: () => ({
            title: 'News & markets',
            options: [...Object.keys(NEWS), CANCEL_OPT],
        }),
        prompt: () => 'Tap an option',
        tap(f, c) {
            if (!NEWS[c]) return 'ignore';
            f.data.pick = c;
            return 'ok';
        },
    },
    bAction: {
        acts: { '➕ Add birthday': 'add', '📅 Upcoming': 'upcoming' },
        poll() {
            return {
                title: 'Birthdays',
                options: [...Object.keys(this.acts), CANCEL_OPT],
            };
        },
        prompt: () => 'Tap an option',
        tap(f, c) {
            if (!this.acts[c]) return 'ignore';
            f.data.action = this.acts[c];
            return 'ok';
        },
    },
    bname: {
        prompt: () => "✍️ Whose birthday? Type the person's name:",
        typed(f, t) {
            f.data.name = t;
            return null;
        },
    },
    bdate: {
        prompt: (f) =>
            `✍️ What date is ${f.data.name}'s birthday? For example 15/03 or 15 March (day first)`,
        typed(f, t) {
            const d = parseDayMonth(t);
            if (!d) return "I couldn't read that date. Try 15/03 or 15 March.";
            f.data.day = d.day;
            f.data.month = d.month;
            return null;
        },
    },
};

const scheduleDone = (chat, d) => addScheduled(chat, d.when, d.name, d.text);
const FLOWS = {
    remind: {
        steps: () => ['time', 'text'],
        done: (chat, d) => addReminder(chat, d.when, d.text),
    },
    repeat: {
        steps: () => ['rtime', 'freq', 'text'],
        done: (chat, d) => addRepeating(chat, d.when, d.freq, d.text),
    },
    schedule: { steps: () => ['who', 'time', 'text'], done: scheduleDone },
    group: { steps: () => ['who', 'time', 'text'], done: scheduleDone },
    quick: {
        steps: (d) => [
            'template',
            ...(d.custom ? ['text'] : []),
            'who',
            'time',
        ],
        done: scheduleDone,
    },
    shop: {
        steps(d) {
            const n = loadShopping().length;
            if (d.action === 'add') return ['shopAction', 'item'];
            if (d.action === 'remove' && n) return ['shopAction', 'shopRemove'];
            if (d.action === 'clear' && n) return ['shopAction', 'shopConfirm'];
            return ['shopAction'];
        },
        done(chat, d) {
            const list = loadShopping();
            if (d.action === 'add') {
                const have = new Set(list.map((x) => x.toLowerCase()));
                const added = [];
                for (const i of d.items)
                    if (!have.has(i.toLowerCase())) {
                        list.push(i);
                        have.add(i.toLowerCase());
                        added.push(i);
                    }
                saveShopping(list);
                return `🛒 Added: ${added.join(', ') || '(already on the list)'}\n\n${shopText(list)}`;
            }
            if (d.action === 'remove' && d.item !== undefined) {
                saveShopping(list.filter((x) => x !== d.item));
                return `✅ Removed: ${d.item}\n\n${shopText(loadShopping())}`;
            }
            if (d.action === 'clear' && d.confirm !== undefined) {
                if (!d.confirm) return 'Okay, kept the list.';
                saveShopping([]);
                return '🧹 Shopping list cleared.';
            }
            return shopText(list);
        },
    },
    news: {
        steps: () => ['newsPick'],
        done: (chat, d) => newsText(d.pick),
    },
    birthdays: {
        steps: (d) =>
            d.action === 'add' ? ['bAction', 'bname', 'bdate'] : ['bAction'],
        done(chat, d) {
            if (d.action !== 'add') return birthdaysText();
            const all = loadBirthdays();
            all.push({ name: d.name, day: d.day, month: d.month, chat });
            saveBirthdays(all);
            return `🎂 Saved: ${d.name} - ${d.day} ${MONTHS[d.month - 1]}. I'll remind you the day before and on the day.`;
        },
    },
};

const stepsOf = (f) => FLOWS[f.kind].steps(f.data);
const curDef = (f) => STEP[stepsOf(f)[f.step]];

async function sendFlowPoll(chat, f, title, options) {
    const poll = await client.sendMessage(
        chat,
        new Poll(MARK + title, options),
    );
    f.pollId = poll.id._serialized;
    flowPolls.set(f.pollId, chat);
}

// Asks the question for the flow's current step (a poll to tap, or a text prompt).
async function askStep(chat, f) {
    const def = curDef(f);
    const p = def.poll && def.poll(f);
    if (p) return sendFlowPoll(chat, f, p.title, p.options);
    return send(chat, def.prompt(f));
}

async function startFlow(chat, kind) {
    const problem =
        (kind === 'schedule' || kind === 'quick') && !contactNames(false).length
            ? 'No saved contacts yet. Save one first: !contact add wife 923001234567'
            : kind === 'group' && !contactNames(true).length
              ? 'No saved groups yet. Save one first: !group add family <exact group name>'
              : null;
    if (problem) {
        await send(chat, problem);
        return sendMenu(chat);
    }
    const f = { kind, step: 0, data: {}, expires: Date.now() + FLOW_MS };
    flows.set(chat, f);
    return askStep(chat, f);
}

async function cancelFlow(chat) {
    flows.delete(chat);
    await send(chat, 'Okay, cancelled.');
    return sendMenu(chat);
}

// Called once the current step has its answer: ask the next question, or finish.
async function advance(chat, f) {
    f.step++;
    f.pollId = null;
    f.expires = Date.now() + FLOW_MS;
    if (f.step < stepsOf(f).length) return askStep(chat, f);
    flows.delete(chat);
    await send(chat, FLOWS[f.kind].done(chat, f.data));
    return sendMenu(chat);
}

// Returns true if the text was an answer to a pending question.
async function handleFlowAnswer(chat, body) {
    const f = flows.get(chat);
    if (!f || !body) return false;
    if (Date.now() > f.expires) {
        flows.delete(chat);
        return false;
    }
    if (/^(cancel|stop)$/i.test(body)) {
        await cancelFlow(chat);
        return true;
    }
    const def = curDef(f);
    let error = null;
    if (def.typed) {
        error = def.typed(f, body);
    } else {
        // Poll-only step: accept the option's text typed out.
        const opt = ((def.poll && def.poll(f)) || { options: [] }).options.find(
            (o) => o.toLowerCase() === body.toLowerCase(),
        );
        if (!opt || def.tap(f, opt) !== 'ok')
            error = 'Please tap one of the options above (or send "cancel").';
    }
    if (error) {
        await send(chat, error);
        return true;
    }
    await advance(chat, f);
    return true;
}

// A tap on one of the flow's own polls.
async function handleFlowVote(chat, f, choice) {
    if (choice === CANCEL_OPT) {
        f.pollId = null;
        return cancelFlow(chat);
    }
    const def = curDef(f);
    const result = def.tap ? def.tap(f, choice) : 'ignore';
    if (result === 'ignore') return;
    f.pollId = null;
    if (result === 'retype') return send(chat, def.prompt(f));
    return advance(chat, f);
}

async function handleVote(vote) {
    const pollId = vote.parentMessage?.id?._serialized;
    if (!vote.selectedOptions.length) return;
    const choice = vote.selectedOptions[0].name;
    const flowChat = flowPolls.get(pollId);
    if (flowChat) {
        const f = flows.get(flowChat);
        if (f && f.pollId === pollId)
            return handleFlowVote(flowChat, f, choice);
        return; // an old or already-answered flow poll
    }
    const chat = menuPolls.get(pollId);
    if (!chat) return;
    const key = (MENU.find((m) => m[0] === choice) || [])[1];
    flows.delete(chat);
    if (FLOWS[key]) return startFlow(chat, key);
    if (key !== 'reminders') return;
    await send(chat, remindersText(chat));
    return sendMenu(chat);
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
    '!group add family Our Family Group - save a WhatsApp group you are in',
    '!groups - list saved groups',
    '!template add Good night - add a quick message for the menu',
    '!templates - list quick messages',
    '!news - links to stocks, world news and AI news',
    '!spent 12 lunch - log an expense',
    "!today - today's expenses and total",
    '!menu - show a tap-to-choose menu (poll) in this chat',
    '!help - this list',
].join('\n');

async function handle(msg) {
    const body = (msg.body || '').trim();
    if (body.startsWith(MARK)) return; // the bot's own message
    const chat = msg.fromMe ? msg.to : msg.from;
    if (!body.startsWith('!')) {
        await handleFlowAnswer(chat, body);
        return;
    }
    flows.delete(chat); // typing a command abandons any pending question
    const [cmd, ...rest] = body.split(/\s+/);
    const arg = rest.join(' ');
    const say = (t) => send(chat, t);

    switch (cmd.toLowerCase()) {
        case '!ping':
            return say('pong');
        case '!help':
            return say(HELP);
        case '!menu':
            if (!(await isSelfChat(chat)))
                return say(
                    'The menu only works in your own "Message yourself" chat.',
                );
            return sendMenu(chat);
        case '!remind': {
            const toks = arg.split(/\s+/);
            const { when, used } = parseTimeTokens(toks);
            const text = toks.slice(used).join(' ');
            if (!when || !text)
                return say(
                    'Usage: !remind 18:00 buy milk  |  !remind in 10m call mom',
                );
            return say(addReminder(chat, when, text));
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
            return say(addScheduled(chat, when, name, text));
        }
        case '!group': {
            const m = /^add\s+(\S+)\s+(.+)$/i.exec(arg);
            if (!m)
                return say(
                    'Usage: !group add family Our Family Group (the name of the WhatsApp group)',
                );
            const groups = (await client.getChats()).filter((c) => c.isGroup);
            const want = m[2].trim().toLowerCase();
            let hits = groups.filter((g) => g.name.toLowerCase() === want);
            if (!hits.length)
                hits = groups.filter((g) =>
                    g.name.toLowerCase().includes(want),
                );
            if (hits.length !== 1)
                return say(
                    hits.length
                        ? `More than one group matches: ${hits
                              .slice(0, 5)
                              .map((g) => g.name)
                              .join(' | ')}. Type the exact name.`
                        : `No group found named "${m[2].trim()}".`,
                );
            const c = loadContacts();
            c[m[1].toLowerCase()] = hits[0].id._serialized;
            fs.writeFileSync(CONTACTS, JSON.stringify(c, null, 2));
            return say(
                `✅ Saved group ${m[1].toLowerCase()} -> ${hits[0].name}`,
            );
        }
        case '!news':
            return say(Object.keys(NEWS).map(newsText).join('\n\n'));
        case '!groups': {
            const g = contactNames(true);
            return say(
                g.length
                    ? g.map((n) => `• ${n}`).join('\n')
                    : 'No groups. Use: !group add family <group name>',
            );
        }
        case '!template': {
            const m = /^(add|remove)\s+(.+)$/i.exec(arg);
            if (!m)
                return say(
                    'Usage: !template add Good night  |  !template remove 2',
                );
            const list = loadTemplates().slice();
            if (m[1].toLowerCase() === 'add') {
                const text = m[2].trim().slice(0, 90);
                if (!list.includes(text)) list.push(text);
                fs.writeFileSync(TEMPLATES, JSON.stringify(list, null, 2));
                return say('✅ Added quick message: ' + text);
            }
            const gone = list.splice(Number(m[2]) - 1, 1)[0];
            if (!gone)
                return say('Usage: !template remove <number> (see !templates)');
            fs.writeFileSync(TEMPLATES, JSON.stringify(list, null, 2));
            return say('Removed: ' + gone);
        }
        case '!templates':
            return say(
                loadTemplates()
                    .map((t, i) => `${i + 1}. ${t}`)
                    .join('\n'),
            );
        case '!reminders':
            return say(remindersText(chat));
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
        case '!today':
            return say(todayText());
        default:
            return say('Unknown command. Send !help');
    }
}

// Give up and let start-bot.bat restart us if we are not ready 5 minutes after starting
// (unless a QR scan is needed, which takes as long as you need).
const START_TIMEOUT_MS = 5 * 60000;
const stuckTimer = setTimeout(() => {
    console.log('Not ready after 5 minutes, exiting so the bot restarts');
    process.exit(1);
}, START_TIMEOUT_MS);

// A browser left over from a previous run can hold the saved login and break the next start.
function killStaleBrowsers() {
    if (process.platform !== 'win32') return;
    const script =
        'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\'" | ' +
        'Where-Object { $_.CommandLine -and $_.CommandLine.Contains($env:BOT_AUTH) } | ' +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }';
    try {
        execFileSync(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', script],
            {
                env: { ...process.env, BOT_AUTH: path.join(DATA, 'auth') },
                timeout: 20000,
                stdio: 'ignore',
            },
        );
    } catch (e) {
        console.log('could not clean up old browsers:', e.message);
    }
}

client.on('loading_screen', (percent, msg) =>
    console.log('LOADING', percent, msg),
);
client.on('change_state', (state) => console.log('STATE', state));
client.on('qr', (qr) => {
    clearTimeout(stuckTimer);
    console.log('Scan this QR with WhatsApp > Linked devices > Link a device:');
    qrcode.generate(qr, { small: true });
});
client.on('authenticated', () => console.log('AUTHENTICATED'));
client.on('auth_failure', (m) => console.log('AUTH FAILURE', m));
client.on('disconnected', (r) => console.log('DISCONNECTED', r));
client.on('ready', () => {
    clearTimeout(stuckTimer);
    console.log('READY, logged in as', client.info.wid.user);
    // If the hidden browser dies (e.g. Windows is shutting down), exit so start-bot.bat restarts us.
    client.pupBrowser?.on('disconnected', () => {
        console.log('Browser closed, exiting so the bot restarts');
        process.exit(1);
    });
    setInterval(() => {
        fireDue().catch((e) => console.log('fireDue error', e.message));
        checkBirthdays().catch((e) =>
            console.log('birthday check error', e.message),
        );
    }, 10000);
    // Health check: if WhatsApp's page stops answering or is not connected for
    // 3 minutes in a row, exit so start-bot.bat restarts the bot.
    let bad = 0;
    setInterval(async () => {
        try {
            const state = await client.getState();
            bad = state === 'CONNECTED' ? 0 : bad + 1;
            if (bad) console.log('health check: state is', state);
        } catch (e) {
            bad++;
            console.log('health check failed:', e.message);
        }
        if (bad >= 3) {
            console.log('Unhealthy for 3 checks, exiting so the bot restarts');
            process.exit(1);
        }
    }, 60000);
});
client.on('vote_update', (vote) => {
    handleVote(vote).catch((e) => console.log('vote error', e.message));
});
// Only obey messages sent from YOUR OWN account; ignore everyone else.
client.on('message_create', (msg) => {
    // Log that a message was seen (text only for commands) to help diagnose "no reply" problems.
    const body = msg.body || '';
    console.log(
        'MSG seen, fromMe:',
        msg.fromMe,
        'type:',
        msg.type,
        body.startsWith('!') ? 'cmd: ' + body.slice(0, 30) : '',
    );
    if (msg.fromMe)
        handle(msg).catch((e) => console.log('handler error', e.message));
});

process.on('uncaughtException', (e) =>
    console.log('UNCAUGHT', (e && e.stack) || e),
);
process.on('unhandledRejection', (e) =>
    console.log('UNHANDLED', (e && e.stack) || e),
);

killStaleBrowsers();
console.log('starting browser...');
client.initialize().catch((e) => {
    console.error('INIT ERROR', e.message);
    process.exit(1);
});
