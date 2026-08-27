# Machine Detect — results to your own endpoint (JSON)

Instead of writing to your Salesforce org, the service **POSTs a JSON result to an
endpoint you host**. You give us the URL, we send the results — nothing touches
your Salesforce.

- **You provide the endpoint.** Pass it as `resultWebhook` when you start a call/run
  (or set it as a default). It must be an HTTPS URL that accepts `POST`.
- **One JSON per callout.** Every call produces exactly one `call_result` when it
  reaches a final state. (One call = one member = one voice call, so "per callout"
  and "per member" are the same thing here.)
- **Plus a batch summary.** When a whole run finishes, we send one `run_completed`
  with the totals.
- **No Salesforce write.** We only POST to your endpoint. (The direct-to-Salesforce
  logging is a separate option and stays off unless you ask for it.)

Your endpoint should reply `2xx` quickly; we don't retry, and we time out our POST
after 5 seconds so a slow endpoint never holds up dialling.

---

## `call_result` — one per callout

Sent the moment a call reaches its final state.

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
  "answeredBy": "machine",
  "action": "voicemail_left",
  "transferredTo": null,
  "voicemailMessageId": "a1b2c3d4",
  "outcome": "machine_message_dropped",
  "detail": null,
  "timeouts": { "ringSec": 45, "beepSec": 45, "agentSec": 30 },
  "at": "2026-08-26T10:15:03.421Z"
}
```

### Fields

| Field | Meaning |
|-------|---------|
| `event` | `call_result` for a single call, `run_completed` for the batch summary. |
| `runId` / `legId` | The batch id and the position of this call within it. |
| `callUuid` | Vonage's call id — use it to reconcile with your Vonage CDRs. |
| `mode` | `detect` / `detect_beep` (transfer-if-machine) or `drop` (voicemail campaign). |
| `number`, `name`, `whoId` | The person called. `name`/`whoId` are whatever you passed in for that member (e.g. your Salesforce record id), echoed back — we never invent them. |
| `from` | The caller id the call went out from. |
| **`answeredBy`** | **`human`**, **`machine`**, or **`none`** (no answer / failed). |
| **`action`** | What we did: `voicemail_left`, `transferred_to_agent`, `transferred`, `skipped`, `live_conversation`, `no_answer`, `failed`. |
| `transferredTo` | If transferred, `{ "type": "sip"\|"phone", "destination": "..." }`; else `null`. |
| `voicemailMessageId` | The message played, if a voicemail was left; else `null`. |
| `outcome` | The full internal status, for reference/debugging. |
| `detail` | Extra text on a failure (e.g. the Vonage error); else `null`. |
| `timeouts` | The timeout settings this call used (see below). |
| `at` | ISO-8601 timestamp. |

---

## Examples by scenario

**Human answered → transferred to your agent / contact centre (SIP)**
```json
{
  "event": "call_result", "runId": "1a2b3c4d", "legId": 3,
  "callUuid": "…", "mode": "drop",
  "number": "447700900124", "name": "Sam Patel", "whoId": "00Q5g000004AbCzEAA",
  "from": "447418365296",
  "answeredBy": "human",
  "action": "transferred_to_agent",
  "transferredTo": { "type": "sip", "destination": "sip:contact-center@example.sip.vonage.com" },
  "voicemailMessageId": null,
  "outcome": "human_transferred",
  "detail": null,
  "timeouts": { "ringSec": 45, "beepSec": 45, "agentSec": 30 },
  "at": "2026-08-26T10:15:20.100Z"
}
```

**No answer (rang for `ringSec` then hung up)**
```json
{
  "event": "call_result", "runId": "1a2b3c4d", "legId": 7,
  "callUuid": "…", "mode": "drop",
  "number": "447700900125", "name": null, "whoId": null,
  "from": "447418365296",
  "answeredBy": "none",
  "action": "no_answer",
  "transferredTo": null,
  "voicemailMessageId": null,
  "outcome": "no_answer",
  "detail": null,
  "timeouts": { "ringSec": 45, "beepSec": 45, "agentSec": 30 },
  "at": "2026-08-26T10:15:47.900Z"
}
```

**Human answered, agent path off (a person picked up, no voicemail left)**
```json
{
  "event": "call_result", "runId": "1a2b3c4d", "legId": 9,
  "callUuid": "…", "mode": "drop",
  "number": "447700900126", "name": "Priya Shah", "whoId": null,
  "from": "447418365296",
  "answeredBy": "human",
  "action": "skipped",
  "transferredTo": null,
  "voicemailMessageId": null,
  "outcome": "human_skipped",
  "detail": null,
  "timeouts": { "ringSec": 45, "beepSec": 45, "agentSec": 30 },
  "at": "2026-08-26T10:16:02.500Z"
}
```

---

## `run_completed` — one per batch

Sent once, after the last call in a run settles.

```json
{
  "event": "run_completed",
  "runId": "1a2b3c4d",
  "mode": "drop",
  "total": 250,
  "counts": {
    "machine_message_dropped": 180,
    "human_transferred": 42,
    "no_answer": 25,
    "failed": 3
  },
  "at": "2026-08-26T10:32:00.000Z"
}
```

---

## Timeout settings (per call/run)

All optional, all in **seconds**, sent on the request that starts the run and echoed
back in every `call_result.timeouts`.

| Setting | Default | What it does |
|---------|---------|--------------|
| `ringTimeout` | 45 | Ring the person this long with no answer, then **hang up** (→ `no_answer`). This is your "if it's been ringing X seconds, drop it". Range 5–120. |
| `beepTimeout` | 45 | On a machine, how long to wait for the voicemail beep before leaving the message. Range 30–120. |
| `agentTimeout` | 45 | When a human is transferred, ring the agent / forward number this long before giving up. Range 5–120. |

**On silence after answer** (a person picks up but says nothing):
- **Agent free →** the call connects to your agent, who hears the silence and handles
  it — no automated action, by design.
- **Agent busy →** we leave the voicemail message and hang up; and if the call is
  never answered, `ringTimeout` above hangs it up after your chosen number of seconds.
