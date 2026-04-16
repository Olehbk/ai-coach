# AI Coach

An AI-powered personal workout coach that tracks your training history, generates progressive weekly plans, and delivers them to you automatically. Talk to your coach in plain English from the terminal, log workouts conversationally, and receive a new plan every Sunday — tailored to how last week actually went.

---

## Features

### Conversational CLI Coach
Talk to your coach in plain English. Describe a workout you just finished and the coach will automatically parse it, confirm what it understood, and save it to your history — no forms, no manual entry.

```
You: Just did bench press 4x8 at 85kg, then incline dumbbell 3x10 at 28kg. Felt solid, RPE around 7.

Coach: Great upper body session. Bench press at 85kg for 4×8 is strong work at RPE 7 —
       you have room to push 87.5kg next week. Logged both exercises.
```

### Automatic Weekly Plan Generation
Every Sunday at 8am, the coach analyses your past week and generates a fully structured 7-day training plan using Claude. The plan accounts for progressive overload — if your RPE was low, it increases intensity; if you were pushing too hard, it dials back and adds recovery.

### Performance Analysis
Before generating each new plan, the coach reviews your recent sessions and produces a concise analysis covering session count, overall intensity, standout performances, signs of fatigue, and a key focus for the coming week.

### Apple Health Integration
Connect the [Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1478805326) iOS app to push workouts from Apple Health directly into AI Coach via webhook. Strength, cardio, mobility — all mapped automatically with duration, calories, and heart rate.

### Slack & Email Delivery
Receive your weekly plan and performance analysis delivered to a Slack channel or your inbox, formatted with all exercises, sets, reps, rest times, and coach notes.

### REST API
A full HTTP API for logging sessions programmatically — useful for integrating with other tools, scripts, or health platforms.

---

## APIs & Services Required

### Anthropic (required)
All coaching intelligence is powered by Claude. You need an Anthropic API key.

- Sign up at [console.anthropic.com](https://console.anthropic.com)
- Create an API key under **API Keys**
- Usage is billed per token — typical weekly cycle costs a few cents

### Slack (optional — for Slack delivery)
Used to post your weekly plan and analysis to a channel.

1. Go to [api.slack.com/apps](https://api.slack.com/apps) and create a new app
2. Under **OAuth & Permissions**, add the `chat:write` bot scope
3. Install the app to your workspace and copy the **Bot User OAuth Token** (`xoxb-...`)
4. Invite the bot to your chosen channel and copy the **Channel ID** from the channel settings

### SMTP / Gmail (optional — for email delivery)
Used to send your weekly plan as an HTML email.

- For Gmail: enable 2-factor authentication, then generate an **App Password** at [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords)
- Use `smtp.gmail.com` on port `587` with your Gmail address and the app password

### Apple Health (optional — for automatic workout sync)
Uses the free **Health Auto Export** iOS app to push workouts to the webhook.

1. Install [Health Auto Export](https://apps.apple.com/app/health-auto-export-json-csv/id1478805326) on your iPhone
2. Open the app → **Automations** → **Webhook**
3. Point it to `http://YOUR_SERVER_IP:3000/webhook/apple-health`
4. During local development, expose your port with [ngrok](https://ngrok.com): `ngrok http 3000`

---

## Setup

### Prerequisites
- Node.js 18+
- npm

### Install

```bash
git clone https://github.com/Olehbk/ai-coach.git
cd ai-coach
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your values:

```bash
cp .env.example .env
```

```env
# Required
ANTHROPIC_API_KEY=sk-ant-...

# Slack (if using Slack delivery)
SLACK_BOT_TOKEN=xoxb-...
SLACK_CHANNEL_ID=C0XXXXXXX

# Email (if using email delivery)
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=you@gmail.com
SMTP_PASS=your-app-password
EMAIL_TO=you@gmail.com

# Your profile
USER_GOAL=Build strength and muscle
FITNESS_LEVEL=intermediate        # beginner / intermediate / advanced
AVAILABLE_DAYS=4                  # training days per week

# Delivery method
DELIVERY_METHOD=slack             # "slack" or "email"

# Server port
PORT=3000
```

---

## Usage

### CLI — Talk to your coach

```bash
npm run coach
```

Once running, type freely or use commands:

| Command | Description |
|---|---|
| `/plan` | Display the current week's plan |
| `/generate` | Analyse last week and generate a new plan immediately |
| `/history` | Show your last 14 days of logged sessions |
| `/help` | List all commands |
| `/quit` | Exit |

**Logging a workout** — just describe it naturally:
```
You: Did squats 4x5 at 120kg, Romanian deadlifts 3x10 at 80kg, leg press 3x15. RPE 8.
```

The coach will confirm what it understood and save it automatically.

### Server — API + webhook + scheduler

```bash
npm start
```

Starts the Express server, mounts the Apple Health webhook, and kicks off the Sunday morning cron job.

---

## REST API

### Log a session manually

```http
POST /api/sessions
Content-Type: application/json

{
  "id": "unique-id",
  "date": "2026-04-14",
  "type": "strength",
  "exercises": [
    { "name": "Bench Press", "sets": 4, "reps": 8, "weight": 85, "rpe": 7 }
  ],
  "notes": "Felt strong",
  "source": "manual"
}
```

### List all sessions

```http
GET /api/sessions
```

### Recent sessions

```http
GET /api/sessions/recent?days=7
```

### Apple Health webhook

```http
POST /webhook/apple-health
```

Accepts the payload format from Health Auto Export. Automatically maps Apple workout types to `strength`, `cardio`, `mobility`, or `other`.

### Health check

```http
GET /health
```

---

## How the Weekly Cycle Works

1. **Analyse** — Claude reviews the past 7 days of sessions, noting volume, intensity (RPE), and recovery signals
2. **Plan** — Claude generates a 7-day plan applying progressive overload rules: increase load if RPE < 7, reduce if RPE > 8 consistently
3. **Save** — The plan is stored in the local SQLite database so the CLI can display it with `/plan`
4. **Deliver** — The plan and analysis are sent to your configured Slack channel or email inbox

The cycle runs automatically every Sunday at 8am. You can also trigger it manually at any time with `/generate` in the CLI, or override the schedule with the `CRON_SCHEDULE` env var (standard cron syntax).

---

## Tech Stack

- **Runtime:** Node.js + TypeScript
- **AI:** [Anthropic SDK](https://github.com/anthropics/anthropic-sdk-node) (Claude Sonnet)
- **Database:** SQLite via [better-sqlite3](https://github.com/WiseLibs/better-sqlite3)
- **Validation:** [Zod](https://zod.dev)
- **Server:** [Express](https://expressjs.com)
- **Scheduler:** [node-cron](https://github.com/node-cron/node-cron)
- **Notifications:** [@slack/web-api](https://github.com/slackapi/node-slack-sdk) + [nodemailer](https://nodemailer.com)
