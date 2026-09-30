# Personal WhatsApp bot

A small assistant built on whatsapp-web.js. It runs as a linked device on your own
WhatsApp account and obeys messages **you** send (from your own "Message yourself"
chat). Messages from anyone else are ignored.

| Command                           | What it does                                                                                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `!menu`                           | Sends a tap-to-choose poll: Remind me, Schedule a message, My reminders, Today's expenses, Help. Remind/Schedule then ask you step by step. Works only in your own "Message yourself" chat |
| `!help`                           | Lists commands                                                                                                                                                                             |
| `!ping`                           | Replies `pong`                                                                                                                                                                             |
| `!remind 6pm buy milk`            | Reminds you (`18:00`, `6:30pm`, `in 10m`, `tomorrow 7am`)                                                                                                                                  |
| `!reminders` / `!cancel 1`        | List / cancel pending reminders and scheduled messages                                                                                                                                     |
| `!contact add wife 923001234567`  | Save a name for a number (country code, no `+`)                                                                                                                                            |
| `!contacts`                       | List saved names                                                                                                                                                                           |
| `!schedule 7am wife Good morning` | Sends that message to a saved contact at that time                                                                                                                                         |
| `!spent 12 lunch` / `!today`      | Log an expense / show today's total                                                                                                                                                        |

Reminder times use UTC+5 by default. Change it with `TZ_OFFSET_MIN` (minutes from UTC).

## Setup on Windows

1. Install **Node.js** (LTS) from nodejs.org and **Git** from git-scm.com.
2. Open PowerShell and run:

    ```powershell
    git clone https://github.com/Bilalkhanten/web.js
    cd web.js
    git checkout claude/dreamy-gates-ef492d
    npm install
    cd bot
    npm install
    node bot.js
    ```

    `npm install` in the repo root downloads the Chromium that the bot uses, so you do
    not need Chrome or Opera.

3. A QR code appears in the terminal. On your phone: WhatsApp → **Linked devices** →
   **Link a device**, then scan it. Wait for `READY`.
4. Send `!ping` to yourself. The bot replies `pong`.

The login is saved in `bot/data/`, so you only scan once.

## Start automatically when you log in (Windows)

1. Press `Win+R`, type `shell:startup`, press Enter.
2. Right-click `bot\start-bot.bat` → **Show more options** → **Create shortcut**, and
   move the shortcut into the Startup folder that opened.
3. Optional: right-click the shortcut → Properties → Run: **Minimized**.

`start-bot.bat` restarts the bot if it crashes and writes a log to `bot\data\bot.log`.

## Notes

- The bot only works while the laptop is on, awake and online. Keep it from sleeping
  (Settings → System → Power → Sleep: Never while plugged in).
- If the bot was offline when a scheduled message was due, and it is more than 15
  minutes late, it is **not** sent. The bot tells you instead.
- Mac/Linux: run `node bot.js` (or use `pm2 start bot.js --name wa-bot && pm2 save && pm2 startup`).
- Extra options: `HEADLESS=false` shows the browser window, `BOT_CHROME_PATH` points at a
  specific Chrome/Chromium, `BOT_DATA_DIR` moves the data folder.
- This is an unofficial client. Keep message volume low and use it for personal use.
