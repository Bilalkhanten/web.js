# daily-articles

A standalone publisher (not connected to the WhatsApp bot, and it shares no code with it). Once a day it writes
**one article** on **AI, Python, Cloud or Machine Learning** with Claude, has a second Claude pass **review it as a
fact-checking editor**, and publishes it to **dev.to**. It needs no input from you while it runs.

## What one run does

1. Skips if you already published an article today (so running twice never double-posts).
2. Picks the area of the day (rotates AI → Python → Cloud → Machine Learning).
3. Claude writes one evergreen article (800-1100 words) that avoids your recent titles. Near-duplicate topics are rejected.
4. A reviewer pass checks facts, API names, code, and invented statistics. Verdict: **approve**, **revise**
   (the corrected text is used and re-checked once) or **reject**.
5. Publishes according to `PUBLISH_MODE`.

## Safety settings (please read)

| `PUBLISH_MODE`    | What happens                                                                |
| ----------------- | --------------------------------------------------------------------------- |
| `draft` (default) | Saves an **unpublished draft** on dev.to every day. Nothing becomes public. |
| `live`            | Publishes only if the review **approved**; otherwise saves a draft.         |
| `dry`             | Prints the article, publishes nothing, needs no dev.to key.                 |

- **Start in `draft` mode** for the first week or two and read the drafts at dev.to/dashboard. Switch to `live` once
  you trust the quality.
- **Every article ends with an AI-assistance disclosure line.** You can change its wording (`ARTICLE_DISCLOSURE`) but it
  cannot be turned off. dev.to's rules expect AI-assisted posts to be disclosed and to add real value; low-effort or
  spammy automated posting can get an account restricted.
- **One article per day, at most.**
- AI can still be wrong, and an unattended publisher puts your name on whatever passes the automatic review. Check
  your dev.to dashboard now and then, and use the kill switch below if quality slips.
- **Kill switch:** set `PUBLISH_MODE=draft` (or disable the scheduled task / workflow).
- A failed run (missing key, API error) exits with an error so schedulers report it.

## Setup

1. **Claude API key:** console.anthropic.com → API keys. Expect roughly 10-30 cents per article (two or three model
   calls); that is an estimate, so check your usage.
2. **dev.to API key:** dev.to/settings/extensions → "DEV Community API Keys".
3. Install: `cd daily-articles`, `npm install` (Node 18+).
4. Copy `.env.example` to `.env`, fill in the two keys (never share them or commit `.env`), keep `PUBLISH_MODE=draft`.
5. Try it: `node publish.js` (or `PUBLISH_MODE=dry` first to just read an article). Tests: `npm test`.

## Running it every day

**Option A - GitHub Actions (cloud, laptop can be off).** Copy `github-workflow.yml` to
`.github/workflows/daily-article.yml` in the repository that contains this folder, add the two secrets and the
`PUBLISH_MODE` variable (instructions are at the top of that file). To keep it fully separate from this repository,
move the `daily-articles` folder into its own new repository and use that one. Scheduled workflows run only from a
repository's default branch.

**Option B - Windows Task Scheduler (laptop must be on at some point that day).** In PowerShell:

```powershell
$action = New-ScheduledTaskAction -Execute "node.exe" -Argument "publish.js" -WorkingDirectory "C:\Users\DELL\web.js\daily-articles"
$trigger = New-ScheduledTaskTrigger -Daily -At 9:00AM
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "DailyArticle" -Action $action -Trigger $trigger -Settings $settings
```

`-StartWhenAvailable` runs a missed job when the laptop is next on; the "already published today" check prevents a
double post. Logs of each run are appended to `published-log.jsonl`.

## Options

`AREAS` (comma list, default `AI,Python,Cloud,Machine Learning`), `ARTICLE_MODEL` (default `claude-opus-5-5`),
`ARTICLE_DISCLOSURE`. Keys can also be real environment variables instead of `.env`.
