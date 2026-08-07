<div align="center">

# ⌵ Vonage Machine Detect

### Call → Detect → Act
**Implementation & Integration Guide**

*Outbound calling with Vonage Advanced Machine Detection — transfer live answers, drop voicemails on machines, pull lists from Salesforce, log every outcome, and listen in live.*

</div>

---

## Contents

1. [What it does](#1-what-it-does)
2. [How it works](#2-how-it-works)
3. [Vonage APIs & services used](#3-vonage-apis--services-used)
4. [What Vonage charges for](#4-what-vonage-charges-for)
5. [Recording or uploading a voicemail message](#5-recording-or-uploading-a-voicemail-message)
6. [Step 1 — Vonage setup](#6-step-1--vonage-setup)
7. [Step 2 — Deploy to VCR](#7-step-2--deploy-to-vcr)
8. [Step 3 — Salesforce setup (optional)](#8-step-3--salesforce-setup-optional)
9. [Using it from your own systems (API)](#9-using-it-from-your-own-systems-api)
10. [Configuration reference](#10-configuration-reference)
11. [Security notes](#11-security-notes)

> **Vonage can deploy and host this for you.** Everything below is what *you* would do to run it yourself, but your Vonage team can stand the whole solution up on your Vonage Cloud Runtime (VCR) account and hand you the URL. Ask your Vonage contact if you'd prefer that.

---

## 1. What it does

You place outbound calls. **Advanced Machine Detection (AMD)** decides whether a human or an answering machine picked up, and the app acts on that:

| Mode | On a **machine** | On a **human** |
|------|------------------|----------------|
| **Transfer (immediate)** | Transfers the call to your forward number as soon as a machine is detected | Leaves a short notice, ends — no transfer |
| **Transfer (after beep)** | Waits for the voicemail beep, then transfers | Same as above |
| **Voicemail drop** | Waits for the beep, plays your recorded/auto message, hangs up, and **dials the next number in the list** | Skips — no message left |

On top of that:

- **Salesforce lists** — pull a call list straight from a Salesforce Campaign; the numbers load automatically.
- **Salesforce logging** — every outcome writes an Activity back to the contact/lead: *"answering machine — message left"* or *"live conversation"*.
- **Live listen** — hear the far side of the call (greeting, machine, beep) from the browser, in real time.

---

## 2. How it works

```
                       ┌──────────────────────────── Vonage Cloud Runtime (VCR) ───────────────────────────┐
  Operator's browser   │                                                                                   │
  ┌───────────────┐    │   ┌────────────┐        Vonage Voice API          ┌──────────────┐                │
  │  Web console  │────┼──▶│  server.js │──── POST /v1/calls ─────────────▶│  Vonage      │──▶ PSTN callee │
  │  (this app)   │◀───┼───│            │◀─── event webhooks ──────────────│  Voice       │                │
  │  live listen  │◀═══╪═══│  WebSocket │◀═══ call audio (audio/l16) ══════│  platform    │                │
  └───────────────┘    │   └─────┬──────┘                                  └──────────────┘                │
                       │         │  advanced_machine_detection: human | machine                            │
                       │         │                                                                         │
                       │         ├── machine ─▶ PUT /v1/calls/{uuid}  transfer → connect(forward) | stream(voicemail)
                       │         └── human   ─▶ PUT /v1/calls/{uuid}  transfer → short notice, end          │
                       │         │                                                                         │
                       │         └── Salesforce REST ──▶ query Campaigns / members, create Task (log)      │
                       └───────────────────────────────────────────────────────────────────────────────────┘
```

1. **Place a call.** `POST /v1/calls` with `advanced_machine_detection: { behavior: "continue", mode, beep_timeout }`. The answered leg is bridged to a **WebSocket** (`audio/l16`, 16 kHz) so the call stays up while AMD listens *and* the audio can be streamed to the browser for live listen.
2. **AMD reports** `human` or `machine` (with a `beep_start` / `beep_timeout` sub-state) to the app's per-call **event webhook**.
3. **The app acts** with `PUT /v1/calls/{uuid}` → a `transfer` action:
   - transfer modes → `connect` to the forward number,
   - voicemail drop → `stream` the message audio (or a `talk` auto-message), then advance to the next number.
4. **Salesforce** (optional) supplies the list (Campaign members) and receives the outcome as a **Task** on each record.

Everything is a single Node/Express app (`server.js`) plus a Salesforce connector (`salesforce.js`) and a static console (`public/index.html`). No database — call state is in memory for the duration of each run.

---

## 3. Vonage APIs & services used

| API / service | Used for | Docs |
|---|---|---|
| **Voice API** — `POST /v1/calls` | Placing the outbound call | [developer.vonage.com/voice](https://developer.vonage.com/en/voice/voice-api/overview) |
| **Advanced Machine Detection** | Deciding human vs. machine, and detecting the beep | [AMD guide](https://developer.vonage.com/en/voice/voice-api/concepts/advanced-machine-detection) |
| **Voice API** — `PUT /v1/calls/{uuid}` (`transfer`) | Transferring to the forward number, streaming the voicemail | [Transfer a call](https://developer.vonage.com/en/voice/voice-api/code-snippets/connect-callers/transfer-a-call-inline-ncco) |
| **NCCO actions** — `connect`, `stream`, `talk` | Bridging, playing recorded audio, text-to-speech auto-message | [NCCO reference](https://developer.vonage.com/en/voice/voice-api/ncco-reference) |
| **WebSocket connect** — `audio/l16;rate=16000` | Keeping the leg alive & live-listen audio | [WebSockets](https://developer.vonage.com/en/voice/voice-api/concepts/websocket) |
| **Applications API** | The Voice application that holds your webhooks & keys | [Applications](https://developer.vonage.com/en/application/overview) |
| **Vonage Cloud Runtime (VCR)** | Hosting the app | [VCR docs](https://developer.vonage.com/en/vonage-cloud-runtime) |
| **Salesforce REST API** (optional) | Campaign lists + Task logging | [SF REST](https://developer.salesforce.com/docs/atlas.en-us.api_rest.meta/api_rest/) |

Authentication to the Voice API is a **JWT signed with your application's private key** (RS256), minted per request. Salesforce uses the **OAuth 2.0 Client Credentials** flow.

---

## 4. What Vonage charges for

> Rates depend on your account, country and number type. These are the **billable elements** to plan for — check your Vonage pricing for exact figures.

| Item | Chargeable? | Notes |
|---|---|---|
| **Advanced Machine Detection** | **Yes** | AMD is a **premium Voice feature billed per call** it runs on. This is in addition to the call minutes. Budget for it on **every** call you place. |
| **Outbound call minutes** | **Yes** | Standard per-minute voice termination to the number you dial, for the whole time the leg is up. |
| **Transfer / forward leg** | **Yes** | A transfer to the forward number is a **second outbound leg** — you pay its minutes too. A machine call that transfers therefore bills two legs. |
| **Voicemail drop (`stream`/`talk`)** | **Yes** | You keep paying call minutes while the message plays into the machine. `talk` text-to-speech may carry a small TTS charge depending on plan. |
| **WebSocket leg** | **Yes** | The audio bridge is a connected leg for the duration of the call; live-listen adds no *extra* Vonage charge beyond that leg already existing. |
| **Phone number rental** | **Yes** | Monthly rental for the Vonage number(s) used as caller ID. |
| **Inbound (if the callee rings back)** | **Yes** | If someone calls your number back, inbound minutes apply. |
| **Vonage Cloud Runtime (VCR)** | Usage-based | Hosting/compute per VCR pricing. |
| **Salesforce API calls** | **No (Vonage)** | Salesforce REST calls count against **your Salesforce** API limits, not Vonage. |

**Cost-planning rule of thumb:** a *voicemail drop* on a machine = 1 outbound leg + AMD + message playback. A *transfer* on a machine = 1 outbound leg + AMD + a 2nd (forward) leg. A *human answer* = 1 outbound leg + AMD.

---

## 5. Recording or uploading a voicemail message

Voicemail-drop mode leaves a message on each machine. You have three choices:

1. **Automatic message (default).** If you record nothing, the app speaks a built-in message via Vonage text-to-speech (`talk`). No setup needed — edit the `AUTO_MESSAGE` string in `server.js` to change the wording, or add your company name.
2. **Record in the browser.** Click **Record**, speak, click **Stop**. The browser captures your mic and encodes the exact format Vonage needs (16-bit PCM WAV, 16 kHz mono), then uploads it. A player appears so you can review it.
3. **Upload an audio file.** Click **Upload audio** and pick any common audio file (MP3, WAV, M4A, OGG…). The browser decodes it and re-encodes to the Vonage-compatible WAV automatically — you don't need to convert anything first.

The message is served at `GET /message.wav` and played into voicemail with the NCCO `stream` action. Use **"Use automatic message instead"** to clear a recording and fall back to the spoken auto-message.

> **Format note:** Vonage's `stream` action needs **linear PCM WAV** (8/16 kHz). Both the recorder and the uploader produce this for you, which is why arbitrary MP3s "just work" here.

---

## 6. Step 1 — Vonage setup

You need a **Vonage API account**, a **voice number**, and a **Voice application**.

### 6.1 Create the Voice application & keypair

Dashboard → **Applications** → **Create a new application**:

1. Name it (e.g. *Machine Detect*).
2. Enable **Voice**. Set:
   - **Answer URL:** `https://YOUR-INSTANCE/webhooks/answer` (GET)
   - **Event URL:** `https://YOUR-INSTANCE/webhooks/events` (POST)
   *(You'll get `YOUR-INSTANCE` after deploying in Step 2 — you can come back and fill these in, or set them now if you already know your VCR URL.)*
3. **Generate a public/private key pair.** Save the **private key** — you'll ship it with the app (or paste it into `VONAGE_PRIVATE_KEY`).

<details>
<summary>Or create it from the CLI</summary>

```bash
# generate a keypair
openssl genrsa -out private.key 2048
openssl rsa -in private.key -pubout -out public.key

# create the app with Voice + your webhooks + public key (Application API)
curl -X POST https://api.nexmo.com/v2/applications \
  -u "$API_KEY:$API_SECRET" \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Machine Detect",
    "capabilities": { "voice": { "webhooks": {
      "answer_url": { "address": "https://YOUR-INSTANCE/webhooks/answer", "http_method": "GET" },
      "event_url":  { "address": "https://YOUR-INSTANCE/webhooks/events", "http_method": "POST" }
    }}},
    "keys": { "public_key": "'"$(cat public.key)"'" }
  }'
```
</details>

### 6.2 Get a voice number

Dashboard → **Numbers** → **Buy numbers** → pick a **voice-capable** number. This is the **caller ID** (`VONAGE_FROM`). It does not need to be linked to this application — it's only used as the *from* on outbound calls.

### 6.3 Note your values

You'll need: **Application ID**, the **private key**, and your **voice number**.

---

## 7. Step 2 — Deploy to VCR

> Prerequisites: [Node.js 18+](https://nodejs.org), the [Vonage CLI](https://developer.vonage.com/en/vonage-cloud-runtime/getting-started/installation) (`vcr`), logged in to your Vonage account.

```bash
git clone https://github.com/2stars-io/vonage-machine-detect.git
cd vonage-machine-detect
npm install

# put your Vonage app private key next to the code (or use VONAGE_PRIVATE_KEY env)
cp /path/to/your/private.key ./private.key

# copy the config templates and fill in YOUR values
cp .env.example .env             # for local runs
cp vcr.yml.example vcr.yml       # for VCR deploy
#   -> set application-id, VONAGE_APPLICATION_ID, VONAGE_FROM, PUBLIC_BASE

vcr deploy
```

`vcr deploy` prints your instance **host address** — that's `PUBLIC_BASE`. Put it in `vcr.yml` (and the app's Answer/Event URLs from Step 6.1), then `vcr deploy` once more so everything points at the right place.

Open the host address in a browser — you should see the console. Health check: `GET /_/health` → `OK`.

> **Local run:** `npm start` with a filled-in `.env` and `PUBLIC_BASE` pointing at a tunnel (e.g. ngrok) if you want to test webhooks without VCR.

---

## 8. Step 3 — Salesforce setup (optional)

Skip this to run without Salesforce. To enable **call lists** and **activity logging**:

### 8.1 Create a Connected App (Client Credentials)

Salesforce **Setup** → **App Manager** → **New Connected App**:

1. Enable **OAuth Settings**.
2. Callback URL: any valid URL (e.g. `https://login.salesforce.com/services/oauth2/callback`) — the Client Credentials flow doesn't use it.
3. OAuth scopes: **Manage user data via APIs (`api`)**.
4. Enable **Client Credentials Flow**.
5. Save. Under **Manage → Edit Policies**, set a **Run-As user** for the Client Credentials flow (a user with permission to read Campaigns and create Tasks).
6. Copy the **Consumer Key** and **Consumer Secret**.

Your **login URL** is your My Domain, e.g. `https://your-domain.my.salesforce.com`.

### 8.2 Connect

Two ways:

- **In the UI:** open the console → **Salesforce (optional)** → paste the login URL, Consumer Key and Consumer Secret → **Connect**. (Kept in memory only.)
- **By environment:** set `SF_LOGIN_URL`, `SF_CLIENT_ID`, `SF_CLIENT_SECRET` in `vcr.yml` / `.env` and redeploy.

### 8.3 Lists & logging

- **Lists** = Salesforce **Campaigns**. Add the people you want to call as **Campaign Members** (Leads or Contacts with a phone/mobile). They'll appear in the console's campaign dropdown; picking one loads the numbers into voicemail-drop mode.
- **Logging** = a **Task** (Activity) is written on each member's record:
  - `Machine detect - answering machine, message left`
  - `Machine detect - live conversation`

  Tick **"Log results to Salesforce"** before starting the run.

> **Data model:** phone comes from `MobilePhone` (falling back to `Phone`) on the Lead/Contact; the Task's `WhoId` links it to that record. Want a custom object or field instead of Tasks? It's one function — `logActivity()` in `salesforce.js`.

---

## 9. Using it from your own systems (API)

The console is optional — every capability is an HTTP endpoint you can drive from your own dialer, CRM or back-office.

### 9.1 This app's endpoints

| Method & path | Body | Does |
|---|---|---|
| `POST /api/call` | see below | Places a call / starts a list |
| `POST /api/message` | raw WAV bytes (`audio/wav`) | Sets the voicemail message |
| `DELETE /api/message` | — | Reverts to the automatic message |
| `GET /api/sf/status` | — | Salesforce connection state |
| `POST /api/sf/connect` | `{loginUrl, clientId, clientSecret}` | Connect Salesforce at runtime |
| `GET /api/sf/lists` | — | Campaigns (call lists) |
| `GET /api/sf/list/:id` | — | Members `[{number, whoId, whoType, name}]` |
| `GET /api/log?since=` | — | Event timeline (for a dashboard) |
| `WS /socket/listen` | — | Live call audio (PCM 16 kHz) |

**Place a transfer call:**
```bash
curl -X POST https://YOUR-INSTANCE/api/call -H 'Content-Type: application/json' -d '{
  "mode": "detect",
  "to": "447700900461",
  "forward": "447700900123",
  "from": "447700900000"
}'
```

**Start a voicemail drop over a list, logging to Salesforce:**
```bash
curl -X POST https://YOUR-INSTANCE/api/call -H 'Content-Type: application/json' -d '{
  "mode": "drop",
  "logToSf": true,
  "members": [
    { "number": "447700900461", "whoId": "00Q...", "name": "Jane Doe" },
    { "number": "447700900462", "whoId": "00Q...", "name": "John Roe" }
  ]
}'
```
`mode` is `detect` | `detect_beep` | `drop`. For a plain list without Salesforce, send `"numbers": "447700900461\n447700900462"` instead of `members`.

### 9.2 Talking to Vonage directly (no this app)

If you'd rather build the flow into your own service, the core is three Vonage calls. Place the call with AMD:

```jsonc
POST https://api.nexmo.com/v1/calls          // Authorization: Bearer <app JWT>
{
  "to":   [{ "type": "phone", "number": "447700900461" }],
  "from": { "type": "phone", "number": "447700900000" },
  "advanced_machine_detection": { "behavior": "continue", "mode": "detect", "beep_timeout": 45 },
  "event_url": ["https://your-service/events"],
  "ncco": [{ "action": "talk", "text": "Please hold." }]
}
```

Then, when your **event webhook** receives `{"status":"machine"}` (or `"human"`), act on the live call:

```jsonc
PUT https://api.nexmo.com/v1/calls/{uuid}     // transfer to a colleague on machine
{ "action": "transfer", "destination": { "type": "ncco", "ncco": [
  { "action": "connect", "endpoint": [{ "type": "phone", "number": "447700900123" }] }
]}}
```

…or `stream` your voicemail message instead of `connect`. That's the whole pattern — this repo is a productised, Salesforce-connected wrapper around it.

---

## 10. Configuration reference

All configuration is environment variables (see `.env.example`). **Nothing is hard-coded.**

| Variable | Required | Purpose |
|---|---|---|
| `VONAGE_APPLICATION_ID` | ✅ | Your Voice application id |
| `VONAGE_FROM` | ✅ | Vonage voice number used as caller id (digits only) |
| `PUBLIC_BASE` | ✅ | This app's public HTTPS base URL |
| `VONAGE_PRIVATE_KEY` *or* `VONAGE_PRIVATE_KEY_PATH` | ✅ | App private key (PEM inline, or a file path; default `./private.key`) |
| `SF_LOGIN_URL` | optional | Salesforce My Domain URL |
| `SF_CLIENT_ID` | optional | Connected App Consumer Key |
| `SF_CLIENT_SECRET` | optional | Connected App Consumer Secret |

Change the spoken auto-message by editing `AUTO_MESSAGE` in `server.js`.

---

## 11. Security notes

- **No credentials or phone numbers are committed to this repository.** `.env`, `vcr.yml`, `private.key` and any `*.wav` are git-ignored. Configure your own via the `.example` templates.
- Salesforce credentials can be provided at **runtime** through the UI (kept in memory only) or via environment variables — your choice.
- The console has **no auth of its own** — it assumes it sits behind your VCR instance / your own access controls. Add authentication before exposing it publicly.
- Calls place real charges and ring real phones. Use test numbers while integrating.

---

<div align="center">

**Built on the Vonage Voice API.**
Want this hosted for you on your Vonage Cloud Runtime? Talk to your Vonage team.

</div>
