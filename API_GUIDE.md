# Machine Detect - API Guide

Outbound calling with Vonage Advanced Machine Detection (AMD). The service places
calls, decides in real time whether a **human** or an **answering machine** picked
up, and acts on that: transfer the live person to an agent, or leave a voicemail on
the machine. Everything the UI does is also a plain HTTP API, so you can drive it
from your own backend, a CRM, or a cron job without ever opening the console.

- **Base URL (live):** `https://neru-0286d49b-machine-detect-production.euw1.runtime.vonage.cloud`
- **Auth to this service:** none by default - it is your private instance. (Put it
  behind your own gateway/API key if you expose it publicly.)
- **Content type:** `application/json` for every endpoint except the voicemail
  upload (`/api/message`, which takes raw audio bytes).
- All examples below use `$BASE` for the base URL.

---

## 1. The two things to understand first

### Modes - what a call *does*
You pick one `mode` per call/run:

| Mode | What happens | Needs |
|------|--------------|-------|
| `detect` | Call one number. If a **machine** answers, immediately transfer the call to your `forward` number. If a **human** answers, play a short goodbye and hang up (no transfer). | `to`, `forward` |
| `detect_beep` | Same as `detect`, but waits for the **voicemail beep** before transferring. | `to`, `forward` |
| `drop` | Call a **whole list** of numbers with configurable concurrency. On a **machine**: wait for the beep, play a voicemail message, hang up, move to the next number. On a **human**: do whatever `humanAction` says (skip / forward to a phone / transfer to a SIP agent). | `numbers` (or `members`/`listId`) |

`detect` and `detect_beep` are single-number "transfer if machine" calls. `drop` is
the campaign engine: lists, concurrency, voicemail drop, and human routing.

### Runs and legs - what a call *is*
- Every call to `/api/call` creates a **run** and returns a `runId` (8 chars).
- Inside a run, each number dialled is a **leg** with its own `legId` (0-based) and
  final `outcome`.
- A `detect`/`detect_beep` call is just a run with a single leg.
- Poll `GET /api/run/:id` for live status and per-leg outcomes.

---

## 2. Setup (once)

The service needs a Vonage Voice application and is configured entirely by
environment variables - no secret ever lives in the code.

| Env var | What it is |
|---------|-----------|
| `VONAGE_APPLICATION_ID` | Your Vonage Voice application id (Dashboard > Applications). |
| `VONAGE_PRIVATE_KEY` or `VONAGE_PRIVATE_KEY_PATH` | The app's private key (PEM inline, or a file path; default `./private.key`). Used to sign the JWT for the Voice API. |
| `VONAGE_FROM` | A voice-enabled Vonage number on your account, used as caller id (digits only, no `+`). |
| `PUBLIC_BASE` | The public HTTPS URL this instance is reachable at (Vonage fetches webhooks and audio from here). |
| `VONAGE_SIGNATURE_SECRET` | *(optional)* Your app's signature secret; turns on webhook signature verification. |
| `SF_LOGIN_URL` / `SF_CLIENT_ID` / `SF_CLIENT_SECRET` | *(optional)* Salesforce Connected App (Client Credentials flow) for call lists + activity logging. |

The Vonage application must have the **Voice** capability enabled and its public key
set to match the private key above. Vonage bills the outbound call legs and AMD;
AMD is a chargeable feature.

> **Vonage can deploy and run this on your own VCR for you** - the whole thing is a
> single Node/Express app; hand us the application id + key and we host it.

---

## 3. The core endpoint: `POST /api/call`

One endpoint starts everything. The body differs by mode.

### 3a. Single call, transfer if machine (`detect` / `detect_beep`)

```bash
curl -X POST "$BASE/api/call" -H "Content-Type: application/json" -d '{
  "mode": "detect",
  "to": "447700900123",
  "forward": "447700900999",
  "from": "447418365296"
}'
```

| Field | Required | Meaning |
|-------|----------|---------|
| `mode` | yes | `detect` or `detect_beep`. |
| `to` | yes | Number to call. |
| `forward` | yes | Number to transfer to **when a machine answers**. |
| `from` | no | Caller id; defaults to `VONAGE_FROM`. |

**Response:** `{ "ok": true, "sid": "<runId>", "runId": "<runId>" }`

Behaviour: human answers -> short goodbye, no transfer. Machine answers -> the call
is bridged to `forward` (immediately for `detect`, after the beep for `detect_beep`).

### 3b. Voicemail-drop campaign (`drop`)

```bash
curl -X POST "$BASE/api/call" -H "Content-Type: application/json" -d '{
  "mode": "drop",
  "numbers": "447700900123\n447700900124\n447700900125",
  "concurrency": 5,
  "messageId": "a1b2c3d4",
  "humanAction": "sip",
  "sipUri": "sip:contact-center@example.sip.vonage.com",
  "sipHeaders": { "X-Agent-Skill": "sales", "X-CRM-Id": "{{whoId}}" },
  "resultWebhook": "https://your-app.example.com/hooks/md"
}'
```

| Field | Required | Meaning |
|-------|----------|---------|
| `mode` | yes | `drop`. |
| `numbers` | one of these | Newline/comma-separated numbers. CSV per line: `number[,name[,whoId]]`. |
| `members` | one of these | `[{number, name?, whoId?, attempt?, messageId?, messages?}]` - structured list (e.g. from Salesforce). The three optional fields pick the voicemail per record, see section 3c. |
| `listId` | one of these | Id of a **saved list** (see `/api/list`). |
| `concurrency` | no | Simultaneous calls, 1-10 (default 1). |
| `messageId` | no | Which uploaded voicemail to play: its **id or its exact name** (names are unique, case does not matter). `message` and `messageName` are accepted as aliases. Omit for the default/auto message. With per-record messages (3c) this is the **fallback**. Every other place that takes a message (`members[].messageId`, `members[].messages`, `attemptMessages`, `/api/records`, `busyMessageId`) accepts a name the same way. |
| `attemptMessages` | no | `{"1": "<messageId or name>", "2": "..."}` - run-wide message per attempt number, for records that have none of their own. |
| `humanAction` | no | `skip` (default) / `forward` / `sip` - what to do when a human answers. |
| `humanForward` | if `forward` | Phone number to bridge live answers to. |
| `sipUri` | if `sip` | SIP endpoint for live answers, e.g. Vonage Contact Center. |
| `sipHeaders` | no | `{header: value}` sent on the SIP INVITE. Values support templates (below). |
| `from` | no | Caller id: one number, or several (comma list / array) to spread the run across a **number pool**. |
| `resultWebhook` | no | HTTPS URL of **your** endpoint; one JSON `call_result` is POSTed per callout, plus a `run_completed` at the end (see section 8). Nothing is written to Salesforce. |
| `ringTimeout` | no | Seconds to ring the called party with no answer, then hang up (default 45, range 5-120). Your "ring for X then drop it". |
| `beepTimeout` | no | Seconds to wait for the voicemail beep before leaving a message (default 45, range 30-120). |
| `agentTimeout` | no | Seconds to ring the agent / forward number on a transfer before giving up (default 45, range 5-120). |
| `logToSf` | no | *(Optional, off by default.)* `true` to also write each outcome to Salesforce. Leave off to use the JSON webhook only. |
| `undetermined` | no | What to do when machine detection reaches **no verdict** and only its timer fires. `auto` (default) sends the call to a human whenever the run has somewhere to put one; `human` always does; `machine` keeps the old behaviour of treating it as an answering machine. See below. |
| `comfort` | no | Audio the caller hears **while detection runs**, instead of silence. `off` (default), `tone` (a quiet built-in room tone), or the id of a message you uploaded. `comfortUrl` takes a full HTTPS URL instead. |
| `amdMode` | no | How Vonage runs machine detection. `default` (the default): asynchronous - the call starts straight away while detection listens in the background, so the comfort sound plays from the moment of answer; the human/machine verdict still arrives on the event webhook. `detect`: synchronous - nothing plays until the verdict. Detection time is the same in both. In our tests `default` occasionally returned an early `beep_timeout` (about 0.35 s after answer) on voicemails; `detect` did not. |
| `comfortVia` | no | How the comfort sound is played. `hold` (default): as hold music in the call's conversation (needs `amdMode: default` to be heard). `stream`: streamed into the call from the answer event and stopped at the verdict - works with either `amdMode`, including `detect`. |

**Undetermined detection.** Machine detection normally returns a verdict in 3-8
seconds. If it returns nothing at all, its beep timer eventually fires and the
platform reports a machine with sub-state `beep_timeout`. That is a timeout, not a
decision, and it looks identical when a real person answered and simply never
produced a voicemail beep. Treating it as a machine means playing a recording at a
live person, so by default those calls now go to an agent instead and a
`amd_undetermined` event is sent. Set `undetermined: "machine"` to restore the
previous behaviour.

**Comfort audio.** During detection the caller is held on an open but silent line
for a few seconds, which can feel like a dead call. Set `comfort` and they hear a
quiet tone instead, which stops the moment the agent is connected. It is off by
default, so nothing changes unless you ask for it.

**Response:** `{ "ok": true, "sid": "<runId>", "runId": "<runId>", "legs": <count>, "concurrency": <n> }`

**SIP header templates** - values in `sipHeaders` can interpolate per-call data so
your agent's screen pops the right record:
`{{whoId}}`, `{{number}}`, `{{name}}`, `{{runId}}`, `{{legId}}`.

### 3c. A different voicemail per record and per attempt

Each record (phone number) can have its own message for each **attempt number**:
the first call leaves message A, the second call message B, and so on. Anything
not covered falls back to the run's `messageId`, then to the default announcement,
so a record with no assignment behaves exactly as before.

**Where the attempt number comes from.** Either you send it (`members[].attempt`),
or the app counts it: a durable counter per record goes up every time the record
is dialled in a drop run (first call = attempt 1). `POST /api/record/:number/reset`
sets it back to 0. A record you never registered is counted too, so `attemptMessages`
works without any registration.

**Two ways to assign messages.**

1. Store them once, durably (survives restarts and redeploys):
```bash
curl -X POST "$BASE/api/records" -H "Content-Type: application/json" -d '{
  "records": [
    { "number": "447700900123", "messages": { "1": "a1b2c3d4", "2": "e5f6a7b8", "3": "Last try" } },
    { "number": "447700900124", "messages": { "1": "a1b2c3d4" } }
  ]
}'
# or as CSV: number, message for attempt 1, message for attempt 2, ...
curl -X POST "$BASE/api/records" -H "Content-Type: application/json" -d '{"csv": "447700900123,a1b2c3d4,e5f6a7b8\n447700900124,a1b2c3d4"}'
```
A message may be given by id or by its exact name. An unknown message is refused with
a 400 naming the record and attempt, so a typo can never silently play the fallback.
Then start runs as usual; nothing else changes in the call request.

2. Or send them with the call, per member:
```json
{ "mode": "drop", "members": [
  { "number": "447700900123", "attempt": 2, "messages": { "1": "a1b2c3d4", "2": "e5f6a7b8" } },
  { "number": "447700900124", "messageId": "e5f6a7b8" }
], "attemptMessages": { "1": "a1b2c3d4", "2": "e5f6a7b8" }, "messageId": "a1b2c3d4" }
```

**Resolution order** for a record on a given attempt:
1. `members[].messageId` in the call request (this call, whatever the attempt)
2. `members[].messages[attempt]` in the call request
3. the record's stored `messages[attempt]` (`/api/records`)
4. the run's `attemptMessages[attempt]`
5. the run's `messageId`, else the default announcement (the fallback)

Every `call_result` carries `attempt`, `voicemailMessageId` (what was left) and
`messageSource` (which rule picked it, e.g. `record, attempt 2` or
`run message (fallback)`); the run log says the same in words.

| Call | What it does |
|------|--------------|
| `GET /api/records` | Every record: messages per attempt, attempt counter, last dialled. |
| `POST /api/records` `{records:[{number, messages, name?, attempts?}]}` or `{csv}` | Bulk set (replaces each listed record's message map; the counter is only changed when `attempts` is given). |
| `PUT /api/record/:number` `{messages, name?, attempts?}` | Set one record. |
| `POST /api/record/:number/reset` | Attempt counter back to 0 (next call is attempt 1). |
| `DELETE /api/record/:number` | Remove the record (back to run/default message). |

---

## 4. Components you can use

### Component: Voicemail messages
What plays when a machine answers in `drop` mode. Sources, in priority order:
1. The record's own message for this **attempt** (section 3c), if any.
2. A **named** message you uploaded (`messageId`).
3. The **default** uploaded message (no `messageId`).
4. Built-in **TTS** fallback (`AUTO_MESSAGE`) if nothing is uploaded - zero setup.

Audio must be **16-bit PCM WAV, 16 kHz mono** (what Vonage's `stream` action needs);
the UI encodes this client-side. Endpoints:

| Call | What it does |
|------|--------------|
| `POST /api/message?name=Spring%20Campaign` (raw WAV bytes) | Store a **named** message. Returns `{ id, name, bytes }`. Names are unique: uploading an existing name returns 409 unless you add `&replace=1`, which swaps the audio and keeps every reference by name working. |
| `POST /api/message` (raw WAV bytes) | Replace the unnamed **default** message. |
| `GET /api/messages` | List the default + all named messages. |
| `DELETE /api/message/:id` | Delete a named message. |
| `DELETE /api/message` | Revert the default back to the TTS auto-message. |
| `GET /message.wav`, `GET /message/:id.wav` | The audio itself (this is what Vonage fetches). |

```bash
# upload a named voicemail
curl -X POST "$BASE/api/message?name=Spring%20Campaign" \
  -H "Content-Type: audio/wav" --data-binary @voicemail.wav
```

### Component: Saved call lists
Reusable named lists so you don't repost numbers every run. A list is
`[{number, name?, whoId?}]`.

| Call | What it does |
|------|--------------|
| `POST /api/list` `{name, numbers}` or `{name, members}` | Save a list. Returns `{ id, name, count }`. |
| `GET /api/lists` | List all saved lists (id, name, count). |
| `GET /api/list/registry/:id` | Full members of one list. |
| `DELETE /api/list/:id` | Delete a list. |

Then start a run with `{ "mode": "drop", "listId": "<id>" }`.

### Component: Human action (drop mode)
When a real person answers during a drop, choose one:
- `skip` (default) - say a short "sorry to disturb you", hang up, no voicemail left.
- `forward` - bridge them to `humanForward` (a phone number).
- `sip` - transfer them to `sipUri` (a SIP agent / Vonage Contact Center), carrying
  your `sipHeaders`. This is the "connect live answers straight to my call centre"
  path.

### Component: Caller-number pool + concurrency
- `from` can be several numbers; the run round-robins across them so simultaneous
  calls don't all originate from one CLI.
- `concurrency` (1-10) sets how many legs dial at once. Legs are staggered ~350 ms to
  stay under account calls-per-second limits.

### Component: Result webhook (outcome push)
Set `resultWebhook` to receive a POST for **every** leg outcome and one final
`run_completed`. See section 8 for payloads. This is how an external system stays in
sync without polling.

### Component: Salesforce logging (optional)
With SF configured, lists can come from **Campaigns** and each outcome is written as
a **Task** on the Lead/Contact ("machine detected, message left" / "live
conversation"). Endpoints: `GET /api/sf/status`, `POST /api/sf/connect`,
`GET /api/sf/lists`, `GET /api/sf/list/:id`. Set `logToSf: true` on the run.

### Component: Live listen (audio monitoring)
Every answered leg is bridged to a WebSocket and rebroadcast, so a browser can
listen to a call in progress:
- `WS /socket/vonage` - Vonage streams call audio in (`audio/l16;rate=16000`).
- `WS /socket/listen` - browser listeners receive the frames.

### Component: Persistence + resume
Runs are saved to a durable store at every state change. If the instance restarts
mid-campaign, it rehydrates in-flight runs, asks Vonage the status of each dialled
leg (`GET /v1/calls/:uuid`), settles the finished ones, and resumes dialling the
numbers it never got to. In-flight calls are not lost on a redeploy.

### Component: Webhook signature verification
Set `VONAGE_SIGNATURE_SECRET` and every inbound Vonage event must carry a valid
signed JWT whose `payload_hash` matches the body; unsigned/forged events are dropped.

---

## 5. Reading results: `GET /api/run/:id`

```bash
curl "$BASE/api/run/<runId>"
```

```json
{
  "runId": "1a2b3c4d",
  "mode": "drop",
  "total": 3,
  "dialled": 3,
  "active": 0,
  "finished": true,
  "counts": { "machine_message_dropped": 2, "human_transferred": 1 },
  "legs": [
    { "legId": 0, "number": "447700900123", "name": null, "whoId": null,
      "callUuid": "…", "outcome": "machine_message_dropped", "finished": true }
  ]
}
```

Poll this until `finished: true`, or just consume the `resultWebhook`.

---

## 6. Outcome vocabulary

Each leg ends with one `outcome`:

| Outcome | Meaning |
|---------|---------|
| `machine_message_dropped` | Machine answered; voicemail left (drop mode). |
| `machine_transferred` | Machine answered; call transferred to `forward` (detect modes). |
| `human_transferred` | Human answered; transferred to a phone or SIP agent. |
| `human_skipped` | Human answered in drop mode with `humanAction=skip`. |
| `human` | Human answered in a detect-mode call (no transfer). |
| `no_answer` | Call completed with no detection (ring-out / not picked up). |
| `failed` | Vonage rejected the call, or it errored. |
| `transfer_failed` / `drop_failed` | The transfer/voicemail action was rejected. |

---

## 7. The Vonage APIs under the hood

You don't call these yourself - the service does - but this is what it's doing so
you can reason about cost and behaviour.

1. **Create call** - `POST https://api.nexmo.com/v1/calls` with
   `advanced_machine_detection: { behavior: "continue", mode, beep_timeout: 45 }`,
   a per-leg `event_url`, and an inline NCCO that `connect`s the leg to a WebSocket
   (keeps the leg alive while AMD runs and feeds live listen).
   `beep_timeout` (30-120 s) is **mandatory** on AMD in every mode.
2. **AMD event** - Vonage POSTs to the `event_url` with `status: "human"` or
   `status: "machine"` (and `sub_state: "beep_start"` at the beep).
3. **Act** - the service PUTs `POST https://api.nexmo.com/v1/calls/:uuid`
   `{ action: "transfer", destination: { type: "ncco", ncco: [...] } }`:
   - machine + drop -> `stream` the voicemail WAV,
   - machine + detect -> `connect` to the `forward` phone,
   - human + sip -> `connect` to the `sip` endpoint with headers,
   - human + forward -> `connect` to the `humanForward` phone.

Auth is a short-lived RS256 JWT signed with your app private key.

---

## 8. Outcome webhook payloads (`resultWebhook`)

One `call_result` per callout (full field reference in `Machine-Detect-Webhook-JSON.md`).

Timing fields, on `call_result` and on every per-leg event (`machine_detected`, `human_connected`, `amd_undetermined`), ISO 8601 UTC with milliseconds, taken from Vonage's own event timestamps:
- `startedAt` - the call was placed (Vonage `started` event)
- `answeredAt` - the called party picked up; detection starts here (`answered` event)
- `detectionEndedAt` - Vonage sent the human/machine verdict
- `detectionMs` - answer to verdict in ms (unchanged); `amdMode` - the mode used for the call

```json
{
  "event": "call_result",
  "runId": "1a2b3c4d",
  "legId": 12,
  "callUuid": "63f61863-4a51-4f6a-bba5-3f6e9a9c1e77",
  "mode": "drop",
  "number": "447700900123",
  "name": "Jane Doe",
  "whoId": "00Q5g000004AbCdEAA",
  "from": "447418365296",
  "answeredBy": "human",
  "action": "transferred_to_agent",
  "transferredTo": { "type": "sip", "destination": "sip:contact-center@example.sip.vonage.com" },
  "voicemailMessageId": null,
  "attempt": 2,
  "messageSource": null,
  "outcome": "human_transferred",
  "detail": null,
  "detectionMs": 3123,
  "startedAt": "2026-10-26T17:48:48.644Z",
  "answeredAt": "2026-10-26T17:48:50.092Z",
  "detectionEndedAt": "2026-10-26T17:48:53.377Z",
  "amdMode": "default",
  "timeouts": { "ringSec": 45, "beepSec": 45, "agentSec": 30 },
  "at": "2026-08-26T10:15:20.100Z"
}
```

Once at the end of a run:
```json
{
  "event": "run_completed",
  "runId": "1a2b3c4d",
  "mode": "drop",
  "total": 3,
  "counts": { "machine_message_dropped": 2, "human_transferred": 1 },
  "at": "2026-08-18T09:14:00.000Z"
}
```

---

## 9. Take the code with you

The whole app is portable - no VCR required to run it elsewhere.

| Call | What it does |
|------|--------------|
| `GET /api/source` | Returns every source file as JSON (`{ repo, files:[{path, content}] }`). |
| `GET /code/raw/:file` | One raw source file (e.g. `server.js`, `public__index.html`). |
| `GET /code` | In-browser source + API reference page. |

Public repo: `https://github.com/Omriak10/vonage-machine-detect`
(and `https://github.com/2stars-io/vonage-machine-detect`). Secrets are never in the
repo - config is env only (`.env.example` / `vcr.yml.example` are placeholders).

---

## 10. Endpoint quick reference

| Method | Path | Purpose |
|--------|------|---------|
| `POST` | `/api/call` | Start a call / drop run (all modes). |
| `GET` | `/api/run/:id` | Run status + per-leg outcomes. |
| `POST` | `/api/message[?name=]` | Upload voicemail (named or default). |
| `GET` | `/api/messages` | List voicemail messages. |
| `DELETE` | `/api/message/:id`, `/api/message` | Delete named / revert default. |
| `POST` | `/api/list` | Save a reusable call list. |
| `GET` | `/api/lists`, `/api/list/registry/:id` | List / read saved lists. |
| `DELETE` | `/api/list/:id` | Delete a list. |
| `GET` | `/api/records` | Per-record messages by attempt + attempt counters. |
| `POST` | `/api/records` | Bulk set per-record messages (`records` or `csv`). |
| `PUT` | `/api/record/:number` | Set one record's messages by attempt. |
| `POST` | `/api/record/:number/reset` | Attempt counter back to 0. |
| `DELETE` | `/api/record/:number` | Remove a record's assignment. |
| `GET` | `/api/sf/status`, `/api/sf/lists`, `/api/sf/list/:id` | Salesforce status / campaigns / members. |
| `POST` | `/api/sf/connect` | Configure Salesforce at runtime. |
| `GET` | `/api/log?since=` | Event timeline (for the UI). |
| `GET` | `/api/config` | Configured caller number. |
| `POST` | `/webhooks/events` | Vonage Voice event webhook (internal). |
| `GET` | `/api/source`, `/code/raw/:file`, `/code` | Take-the-code endpoints. |
| `WS` | `/socket/vonage`, `/socket/listen` | Live-listen audio bridge. |
