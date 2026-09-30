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

async function fireDue() {
    const all = load();
    const now = Date.now();
    const due = all.filter((r) => r.due <= now);
    if (!due.length) return;
    save(all.filter((r) => r.due > now));
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
                      `${i + 1}. ${fmt(r.due)} ${r.to ? '→ ' + r.toName + ': ' : '- '}${r.text}`,
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
    ['📨 Schedule a message', 'schedule'],
    ['📋 My reminders', 'reminders'],
    ["💸 Today's expenses", 'today'],
    ['❓ Help', 'help'],
];
const menuPolls = new Map(); // poll message id -> chat it was sent in
const flows = new Map(); // chat -> { kind, step, data, expires }
const FLOW_MS = 10 * 60000;
const FLOW_STEPS = {
    remind: ['time', 'text'],
    schedule: ['who', 'time', 'text'],
};

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

const CANCEL_OPT = '✖ Cancel';
const OTHER_TIME = '🕒 Other time…';
const TIME_CHOICES = {
    'In 1 hour': () => Date.now() + 3600000,
    'Tonight 9pm': () => parseWhen('9pm'),
    'Tomorrow 7am': () => parseWhen('7am', 1),
    'Tomorrow 9am': () => parseWhen('9am', 1),
};
const TIME_PROMPT =
    'When? For example: 6pm, 18:30, in 10m, tomorrow 7am\n(send "cancel" to stop)';
const flowPolls = new Map(); // flow poll message id -> chat

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
    const step = FLOW_STEPS[f.kind][f.step];
    if (step === 'who') {
        const names = Object.keys(loadContacts());
        if (names.length <= 11)
            return sendFlowPoll(chat, f, 'Who should get the message?', [
                ...names,
                CANCEL_OPT,
            ]);
        return send(
            chat,
            `Who should get the message? Type a saved name: ${names.join(', ')}\n(send "cancel" to stop)`,
        );
    }
    if (step === 'time')
        return sendFlowPoll(chat, f, 'When?', [
            ...Object.keys(TIME_CHOICES),
            OTHER_TIME,
            CANCEL_OPT,
        ]);
    return send(
        chat,
        f.kind === 'remind'
            ? '✍️ What should I remind you about?'
            : `✍️ Write your message to ${f.data.name}:`,
    );
}

async function startFlow(chat, kind) {
    if (kind === 'schedule' && !Object.keys(loadContacts()).length) {
        await send(
            chat,
            'No saved contacts yet. Save one first: !contact add wife 923001234567',
        );
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
    f.typedTime = false;
    f.expires = Date.now() + FLOW_MS;
    if (f.step < FLOW_STEPS[f.kind].length) return askStep(chat, f);
    flows.delete(chat);
    await send(
        chat,
        f.kind === 'remind'
            ? addReminder(chat, f.data.when, f.data.text)
            : addScheduled(chat, f.data.when, f.data.name, f.data.text),
    );
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
    const step = FLOW_STEPS[f.kind][f.step];
    if (step === 'time') {
        const toks = body.split(/\s+/);
        const { when, used } = parseTimeTokens(toks);
        if (!when || used !== toks.length) {
            await send(
                chat,
                "I couldn't read that time. Try 6pm, 18:30, in 10m or tomorrow 7am.",
            );
            return true;
        }
        f.data.when = when;
    } else if (step === 'who') {
        const name = body.toLowerCase();
        if (!loadContacts()[name]) {
            await send(
                chat,
                `I don't know "${body}". Saved: ${Object.keys(loadContacts()).join(', ')}`,
            );
            return true;
        }
        f.data.name = name;
    } else {
        f.data.text = body;
    }
    await advance(chat, f);
    return true;
}

// A tap on one of the flow's own polls (who / when).
async function handleFlowVote(chat, f, choice) {
    if (choice === CANCEL_OPT) {
        f.pollId = null;
        return cancelFlow(chat);
    }
    const step = FLOW_STEPS[f.kind][f.step];
    if (step === 'who') {
        const name = choice.toLowerCase();
        if (!loadContacts()[name]) return;
        f.pollId = null;
        f.data.name = name;
        return advance(chat, f);
    }
    if (step !== 'time') return;
    f.pollId = null;
    if (choice === OTHER_TIME) {
        f.typedTime = true;
        return send(chat, TIME_PROMPT);
    }
    if (!TIME_CHOICES[choice]) return;
    f.data.when = TIME_CHOICES[choice]();
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
    if (key === 'remind' || key === 'schedule') return startFlow(chat, key);
    if (key === 'reminders') await send(chat, remindersText(chat));
    else if (key === 'today') await send(chat, todayText());
    else if (key === 'help') await send(chat, HELP);
    else return;
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
    setInterval(
        () => fireDue().catch((e) => console.log('fireDue error', e.message)),
        10000,
    );
});
client.on('vote_update', (vote) => {
    handleVote(vote).catch((e) => console.log('vote error', e.message));
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

killStaleBrowsers();
console.log('starting browser...');
client.initialize().catch((e) => {
    console.error('INIT ERROR', e.message);
    process.exit(1);
});
