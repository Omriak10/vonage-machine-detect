// Machine Detect - outbound calls + Vonage Advanced Machine Detection (VCR).
//
// Modes:
//   detect       - transfer to the forward number as soon as a machine answers
//   detect_beep  - same, but transfer after the voicemail beep
//   drop         - dial a LIST of numbers with configurable concurrency; when a
//                  machine answers, play a (named) voicemail message after the
//                  beep and move on. When a HUMAN answers: skip (default),
//                  transfer to a phone number, or transfer to a SIP endpoint
//                  (e.g. Vonage Contact Center) with custom headers.
//
// Live listen: every call leg is bridged to a websocket (audio/l16, 16 kHz),
// rebroadcast to any browser listening on /socket/listen.
//
//   GET  /                    - console UI
//   POST /api/call            - start a call / a run (see below)
//   GET  /api/run/:id         - run status + per-leg outcomes
//   POST /api/message         - upload a voicemail message (?name= to store as
//                               a named message; without name = the default)
//   GET  /api/messages        - list named messages
//   DELETE /api/message/:id   - delete a named message
//   GET  /message.wav         - default message (fetched by Vonage)
//   GET  /message/:id.wav     - named message (fetched by Vonage)
//   GET  /api/log?since=      - event timeline for the UI
//   POST /webhooks/events     - Voice API event webhook (per-leg event_url)
//   WS   /socket/vonage       - call audio in from Vonage
//   WS   /socket/listen       - browser listeners
//
// POST /api/call body:
//   mode           detect | detect_beep | drop
//   to, forward    transfer modes: single number + forward-on-machine number
//   numbers        drop: newline/comma-separated list, or:
//   members        drop: [{number, whoId?, name?}] (e.g. from /api/sf/list/:id)
//   messageId      drop: which named message to play (default: default/auto)
//   concurrency    drop: simultaneous calls, 1-10 (default 1)
//   humanAction    drop: skip (default) | forward | sip
//   humanForward   drop + humanAction=forward: phone number for live answers
//   sipUri         drop + humanAction=sip: sip:...@... endpoint (e.g. VCC)
//   sipHeaders     drop + humanAction=sip: {header: value} - values support
//                  {{whoId}} {{number}} {{name}} {{runId}} {{legId}} templates
//   resultWebhook  optional https URL - every call outcome is POSTed there
//   from, logToSf  as before
const express = require('express');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { WebSocketServer } = require('ws');
const sfdc = require('./salesforce');
const store = require('./store');

const app = express();
app.use(express.json({ limit: '1mb' }));

const PORT = process.env.NERU_APP_PORT || process.env.PORT || 3000;
// --- all deployment-specific values come from the environment (see .env.example) ---
const APP_ID = process.env.VONAGE_APPLICATION_ID || '';        // your Vonage Voice application id
const HOST = (process.env.PUBLIC_BASE || `http://localhost:${PORT}`).replace(/\/$/, ''); // this app's public https base
const WS_HOST = HOST.replace(/^http/, 'ws');
const DEFAULT_FROM = process.env.VONAGE_FROM || '';            // a Vonage voice number on your account (caller id)
// optional: set your application's signature secret to verify event webhooks
const SIGNATURE_SECRET = process.env.VONAGE_SIGNATURE_SECRET || '';
// private key: env var (PEM) or a file path, default ./private.key
const PRIVATE_KEY = process.env.VONAGE_PRIVATE_KEY
  ? process.env.VONAGE_PRIVATE_KEY.replace(/\\n/g, '\n')
  : fs.readFileSync(process.env.VONAGE_PRIVATE_KEY_PATH || path.join(__dirname, 'private.key'), 'utf8');

const appJwt = () => jwt.sign(
  { application_id: APP_ID, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900, jti: crypto.randomUUID() },
  PRIVATE_KEY, { algorithm: 'RS256' });

const api = async (method, url, body) => {
  const r = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + appJwt() },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { status: r.status, data };
};

// ---------------------------------------------------------------- state
const runs = {};    // runId -> run (see header). Persisted to a durable store
                    // (store.js) so a restart/crash resumes in-flight runs
                    // instead of losing them.
let shuttingDown = false;
const persist = (run) => { if (run) store.save(run); };
const log = [];
const addLog = (sid, msg, kind = 'info') => {
  log.push({ t: Date.now(), sid, msg, kind });
  if (log.length > 600) log.splice(0, log.length - 600);
  console.log(`[${sid}] ${msg}`);
};
const clean = (n) => String(n || '').replace(/[^\d]/g, '');

// ------------------------------------------------- voicemail message registry
// Named messages (per campaign / call category) + one unnamed default.
// Persisted to the instance's tmp dir so a process restart keeps them.
const MSG_DIR = os.tmpdir();
const MSG_INDEX = path.join(MSG_DIR, 'md-messages.json');
const MSG_PATH = path.join(MSG_DIR, 'drop-message.wav'); // runtime-uploaded default (ephemeral: tmp, lost on redeploy)
// A default announcement BUNDLED with the app: it ships inside the deploy
// artifact, so it is ALWAYS present after a restart or redeploy (unlike the
// tmp copy above). Drop a WAV at assets/default-message.wav (or point
// DEFAULT_MSG_PATH at one) and it becomes the default voicemail message. The
// English TTS further down is then only a genuine last resort if even this is
// absent - so a redeploy can never silently revert to the English announcement.
const BUNDLED_MSG = process.env.DEFAULT_MSG_PATH || path.join(__dirname, 'assets', 'default-message.wav');
let dropMessage = fs.existsSync(MSG_PATH) ? fs.readFileSync(MSG_PATH)
  : (fs.existsSync(BUNDLED_MSG) ? fs.readFileSync(BUNDLED_MSG) : null);
if (dropMessage && !fs.existsSync(MSG_PATH)) console.log('[msg] loaded bundled default announcement from', BUNDLED_MSG, `(${dropMessage.length} bytes)`);
let messages = {};  // id -> { name, bytes, file }
try {
  if (fs.existsSync(MSG_INDEX)) {
    const idx = JSON.parse(fs.readFileSync(MSG_INDEX, 'utf8'));
    for (const [id, m] of Object.entries(idx)) {
      if (fs.existsSync(m.file)) messages[id] = m;
    }
  }
} catch {}
const saveMsgIndex = () => { try { fs.writeFileSync(MSG_INDEX, JSON.stringify(messages)); } catch {} };

// Last-resort spoken message, used ONLY if no recorded default is bundled or
// uploaded. Both the text and its language are env-configurable so this can
// never be an unexpected English announcement.
const AUTO_MESSAGE = process.env.AUTO_MESSAGE
  || ("Hello, this is an automated message from Vonage. We tried to reach you but could not connect. "
  + "Please call us back at your earliest convenience. Thank you, and have a great day.");
const AUTO_LANG = process.env.AUTO_MESSAGE_LANG || 'en-US';

// ---- durable default announcement (survives restart AND redeploy) -----------
// The runtime upload above lands in tmp (wiped on redeploy). To let the CUSTOMER
// set the default themselves via the console and have it STICK, we mirror it to
// VCR instance state (Redis-backed, persists across redeploys). Loaded on boot.
const DEFAULT_KEY = 'md-default-message-b64';
let _state; // undefined = not tried, null = unavailable
function vcrState() {
  if (_state !== undefined) return _state;
  try { const { vcr } = require('@vonage/vcr-sdk'); _state = vcr.getInstanceState(); }
  catch (e) { console.log('[state] durable store unavailable (' + e.message + ') - default is tmp/bundled only'); _state = null; }
  return _state;
}
async function saveDurableDefault(buf) {
  const s = vcrState(); if (!s) return false;
  try { await s.set(DEFAULT_KEY, buf.toString('base64')); console.log('[state] durable default announcement saved (' + buf.length + ' bytes)'); return true; }
  catch (e) { console.error('[state] save default failed:', e.message); return false; }
}
async function deleteDurableDefault() {
  const s = vcrState(); if (!s) return;
  try { await s.delete(DEFAULT_KEY); } catch (e) { console.error('[state] delete default failed:', e.message); }
}
async function loadDurableDefault() {
  const s = vcrState(); if (!s) return;
  try {
    const b64 = await s.get(DEFAULT_KEY);
    if (b64) { dropMessage = Buffer.from(b64, 'base64'); console.log('[state] loaded durable default announcement (' + dropMessage.length + ' bytes)'); }
  } catch (e) { console.error('[state] load default failed:', e.message); }
}
loadDurableDefault(); // fire-and-forget on boot; overrides tmp/bundled once ready

// ---------------------------------------------- saved call-list registry
// Reusable named lists (one per campaign / call category), persisted so they
// survive a restart. A list is [{number, whoId?, name?}]. Sources: paste, CSV
// upload, Salesforce campaign, or the API.
const LIST_INDEX = path.join(MSG_DIR, 'md-lists.json');
let lists = {};   // id -> { name, members:[...], createdAt }
try { if (fs.existsSync(LIST_INDEX)) lists = JSON.parse(fs.readFileSync(LIST_INDEX, 'utf8')) || {}; } catch {}
const saveListIndex = () => { try { fs.writeFileSync(LIST_INDEX, JSON.stringify(lists)); } catch {} };
// parse pasted text or CSV into members. CSV: number[,name[,whoId]] per line;
// "// name" trailing comment (from the SF-loaded textarea) is stripped.
function parseMembers(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const l = line.replace(/\/\/.*$/, '').trim();
    if (!l) return null;
    const parts = l.split(/[,;\t]/).map((s) => s.trim());
    const number = clean(parts[0]);
    if (number.length < 7) return null;
    return { number, name: parts[1] || undefined, whoId: parts[2] || undefined };
  }).filter(Boolean);
}

// the NCCO played into a voicemail for a given run
function dropNcco(run) {
  if (run.messageId && messages[run.messageId]) {
    return [{ action: 'stream', streamUrl: [HOST + '/message/' + run.messageId + '.wav'] }];
  }
  if (dropMessage) return [{ action: 'stream', streamUrl: [HOST + '/message.wav'] }];
  return [{ action: 'talk', text: AUTO_MESSAGE, language: AUTO_LANG, style: 2 }];
}
const msgLabel = (run) => run.messageId && messages[run.messageId]
  ? `message "${messages[run.messageId].name}"` : (dropMessage ? 'default recorded message' : 'automatic message');

// how long the dropped message plays, so we can hang up the moment it ends
// instead of waiting for the voicemail's max-length timeout.
function wavSeconds(buf) {
  try {
    if (buf && buf.length > 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
      let byteRate = 0, dataLen = 0, o = 12;
      while (o + 8 <= buf.length) {
        const id = buf.toString('ascii', o, o + 4);
        const sz = buf.readUInt32LE(o + 4);
        if (id === 'fmt ') byteRate = buf.readUInt32LE(o + 8 + 8);
        else if (id === 'data') { dataLen = sz; break; }
        o += 8 + sz + (sz & 1);
      }
      if (byteRate > 0 && dataLen > 0) return dataLen / byteRate;
    }
  } catch (e) {}
  if (buf && buf.length) return buf.length / 32000; // assume 16-bit/16kHz mono
  return 0;
}
function messageDurationMs(run) {
  let sec = 0;
  if (run.messageId && messages[run.messageId]) { try { sec = wavSeconds(fs.readFileSync(messages[run.messageId].file)); } catch (e) {} }
  else if (dropMessage) sec = wavSeconds(dropMessage);
  else sec = String(AUTO_MESSAGE).split(/\s+/).length / 2.6 + 1.5; // TTS estimate
  if (!sec || sec < 1) sec = 8; // safety floor
  return Math.round(sec * 1000);
}

// ---------------------------------------------------------------- calling
// A run dials members as legs. Transfer modes are a run with a single member.
function tmpl(v, run, legId, m) {
  return String(v)
    .replace(/\{\{\s*whoId\s*\}\}/g, m.whoId || '')
    .replace(/\{\{\s*number\s*\}\}/g, m.number || '')
    .replace(/\{\{\s*name\s*\}\}/g, m.name || '')
    .replace(/\{\{\s*runId\s*\}\}/g, run.id)
    .replace(/\{\{\s*legId\s*\}\}/g, String(legId));
}

// Bridge a second party (agent phone / SIP) to the caller by DIALLING THEM
// INTO THE CALLER'S CONVERSATION - not by transferring the caller's leg.
// Transferring an AMD-held leg into a `connect` produced a bridge with no
// working media (the far end answered then dropped after ~4-5s, on mobile and
// SIP alike). Adding both parties to one conversation lets it mix the audio
// properly, so both sides can actually hear each other.
async function bridgeIntoConversation(run, leg, endpoint) {
  return api('POST', 'https://api.nexmo.com/v1/calls', {
    to: [endpoint],
    from: { type: 'phone', number: leg.from || run.from },
    ringing_timer: run.agentTimeout || 45,
    ncco: [{ action: 'conversation', name: leg.conv, startOnEnter: true, endOnExit: true }],
  });
}

async function placeLeg(runId, legId) {
  const run = runs[runId];
  const m = run.list[legId];
  // caller id: one number for the whole run, or round-robin across a pool.
  // Concurrency places many simultaneous calls; with a single number they all
  // go out from it, with a pool they spread across the numbers.
  const fromNum = run.fromPool[legId % run.fromPool.length];
  const leg = { m, from: fromNum, uuid: null, transferred: false, done: false, outcome: null };
  run.legs[legId] = leg; // active slot was reserved by launchNext
  // `detect_beep` hunts for the voicemail beep and so leans towards "machine" -
  // it can misread a live person's "hello" as a machine. Only use it for pure
  // voicemail-drop runs. When the run forwards a human to an agent/SIP (or is a
  // transfer mode), use plain `detect`, which classifies live people accurately
  // and faster; machines are still detected (we drop after the fallback delay).
  const wantsHuman = run.mode !== 'drop' || run.humanAction === 'forward' || run.humanAction === 'sip';
  const amd = {
    behavior: 'continue',
    mode: wantsHuman ? 'detect' : 'detect_beep',
    beep_timeout: run.beepTimeout || 30, // Vonage waits up to this for the beep, then fires beep_timeout (min 30)
  };
  run.amdMode = amd.mode; // so the event handler knows whether to wait for beep events
  const { status, data } = await api('POST', 'https://api.nexmo.com/v1/calls', {
    to: [{ type: 'phone', number: m.number }],
    from: { type: 'phone', number: fromNum },
    advanced_machine_detection: amd,
    ringing_timer: run.ringTimeout || 45, // ring this long with no answer, then hang up (unanswered)
    event_url: [HOST + '/webhooks/events?sid=' + runId + '&leg=' + legId],
    ncco: [
      // Hold the caller in a CONVERSATION (not a peer-bridge to the websocket)
      // while AMD runs. A peer `connect` to the websocket monopolised the
      // caller's single media bridge: a one-way stream (voicemail drop) still
      // played, but a later two-way `connect` (forward to an agent / SIP) came
      // out MUTED. A conversation handles multi-party media, so the transfer
      // bridges with clean audio. The live-listen websocket is joined to the
      // same conversation below as a muted, listen-only participant.
      { action: 'conversation', name: 'md-' + runId + '-' + legId, endOnExit: true },
    ],
  });
  if (status >= 300 || !data.uuid) {
    addLog(runId, `call to ${m.number} FAILED: ` + JSON.stringify(data).slice(0, 250), 'bad');
    finishLeg(runId, legId, 'failed', JSON.stringify(data).slice(0, 200));
    return false;
  }
  leg.uuid = data.uuid;
  leg.startedAt = Date.now();
  // live-listen: join a websocket to the same conversation as a MUTED
  // (listen-only) participant, so browsers can listen without touching the
  // caller's media path. Fire-and-forget - a failure never affects the call.
  leg.conv = 'md-' + runId + '-' + legId;
  api('POST', 'https://api.nexmo.com/v1/calls', {
    to: [{ type: 'websocket', uri: WS_HOST + '/socket/vonage?sid=' + runId, 'content-type': 'audio/l16;rate=16000' }],
    from: { type: 'phone', number: fromNum },
    ncco: [{ action: 'conversation', name: leg.conv, startOnEnter: false, endOnExit: false, canSpeak: [] }],
  }).then((r) => { if (r && r.data && r.data.uuid) leg.wsUuid = r.data.uuid; }).catch(() => {});
  // safety net: if Vonage never sends a terminal event (missed webhook, etc.)
  // finalize the leg anyway so a call result is ALWAYS sent.
  const wdMs = ((run.ringTimeout || 45) + (run.beepTimeout || 45) + 120) * 1000;
  leg.watchdog = setTimeout(() => {
    if (leg.finished) return;
    addLog(runId, `leg ${legId + 1} - no terminal event within ${Math.round(wdMs / 1000)}s; finalizing so a result is sent`, 'warn');
    finishLeg(runId, legId, leg.outcome || 'no_answer', 'watchdog: no terminal event received');
  }, wdMs);
  persist(run);                       // durable: this number's call uuid is now known
  const who = m.name ? ` (${m.name})` : '';
  addLog(runId, run.mode === 'drop'
    ? `[${legId + 1}/${run.list.length}] calling ${m.number}${who} from ${fromNum}`
    : `calling ${m.number}${who} from ${fromNum} (AMD ${amd.mode}) - on machine, forward to ${run.forward}`);
  return true;
}

// a leg reached a terminal outcome: record it, push it, refill the dialler
function finishLeg(runId, legId, outcome, detail) {
  const run = runs[runId];
  const leg = run.legs[legId];
  if (!leg || leg.finished) return;
  for (const t of ['dropTimer', 'hangTimer', 'watchdog']) { if (leg[t]) { clearTimeout(leg[t]); leg[t] = null; } }
  if (leg.wsUuid) { api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.wsUuid, { action: 'hangup' }).catch(() => {}); leg.wsUuid = null; }
  leg.finished = true; leg.done = true; leg.outcome = outcome;
  run.active = Math.max(0, run.active - 1);
  run.counts[outcome] = (run.counts[outcome] || 0) + 1;
  persist(run);                       // durable: this leg is now settled
  pushResult(run, legId, outcome, detail);
  launchNext(runId);
}

function launchNext(runId) {
  const run = runs[runId];
  if (run.mode !== 'drop') { maybeFinishRun(runId); return; }
  let batch = 0;
  while (!shuttingDown && run.active < run.concurrency && run.nextIdx < run.list.length) {
    const legId = run.nextIdx++;
    run.active++; // reserve the slot now; finishLeg releases it
    setTimeout(() => placeLeg(runId, legId), 350 * batch++); // stagger to stay under account CPS
  }
  persist(run);                       // durable: nextIdx advanced -> resume point
  maybeFinishRun(runId);
}

function maybeFinishRun(runId) {
  const run = runs[runId];
  if (run.finished || run.active > 0 || run.nextIdx < run.list.length) return;
  // any legs still not terminal? (events may still be in flight)
  if (Object.values(run.legs).some((l) => !l.finished)) return;
  run.finished = true;
  const c = run.counts;
  if (run.mode === 'drop') {
    addLog(runId, `run finished - ${c.machine_message_dropped || 0} dropped, ${(c.human_transferred || 0)} transferred, `
      + `${c.human_skipped || 0} humans skipped, ${c.no_answer || 0} no answer, ${c.failed || 0} failed of ${run.list.length}`, 'good');
  }
  persist(run);
  pushResult(run, null, 'run_completed', null);
  // keep the finished run on disk for /api/run/:id history; prune old ones lazily
  setTimeout(() => { if (runs[runId] && runs[runId].finished) { store.remove(runId); } }, 6 * 60 * 60 * 1000);
}

// Map an internal outcome to the plain "what happened" fields the client consumes.
function outcomeMeta(outcome) {
  const o = String(outcome || '');
  if (o === 'machine_message_dropped') return { answeredBy: 'machine', action: 'voicemail_left' };
  if (o === 'machine_transferred')     return { answeredBy: 'machine', action: 'transferred' };
  if (o === 'machine')                 return { answeredBy: 'machine', action: 'no_message' };
  if (o === 'human_transferred')       return { answeredBy: 'human',   action: 'transferred_to_agent' };
  if (o === 'human_skipped')           return { answeredBy: 'human',   action: 'skipped' };
  if (o === 'human')                   return { answeredBy: 'human',   action: 'live_conversation' };
  if (o === 'no_answer')               return { answeredBy: 'none',    action: 'no_answer' };
  if (o === 'failed' || o.startsWith('failed')) return { answeredBy: 'none', action: 'failed' };
  if (o.endsWith('_failed'))           return { answeredBy: null,      action: 'action_failed' };
  return { answeredBy: null, action: o || 'completed' };
}

// POST a webhook body with a few retries so a transient blip doesn't silently
// lose a call result (reported bug: the result was "not always sent").
async function postWebhook(url, body, runId, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(6000) });
      if (r.ok) return true;
      addLog(runId, `${label} webhook HTTP ${r.status} (attempt ${attempt}/3)`, attempt === 3 ? 'bad' : 'warn');
    } catch (e) {
      addLog(runId, `${label} webhook error: ${e.message} (attempt ${attempt}/3)`, attempt === 3 ? 'bad' : 'warn');
    }
    await new Promise((res) => setTimeout(res, 400 * attempt));
  }
  return false;
}

// immediate "answering machine detected" hook - fired the moment AMD says
// machine, BEFORE and separate from the final result, so the CRM knows ASAP.
function pushDetection(run, legId) {
  if (!run.resultWebhook) return;
  const leg = run.legs[legId]; if (!leg) return;
  postWebhook(run.resultWebhook, {
    event: 'machine_detected',
    runId: run.id, legId, callUuid: leg.uuid, mode: run.mode,
    number: leg.m.number, name: leg.m.name || null, whoId: leg.m.whoId || null,
    from: leg.from || run.from, answeredBy: 'machine', action: 'detected',
    at: new Date().toISOString(),
  }, run.id, 'detection');
}

// fire-and-forget: POST ONE clean JSON per callout to the client's endpoint
// (nothing is written to Salesforce unless logToSf is separately enabled).
function pushResult(run, legId, outcome, detail) {
  if (!run.resultWebhook) return;
  const leg = legId != null ? run.legs[legId] : null;
  let body;
  if (leg) {
    const meta = outcomeMeta(outcome);
    const agent = run.humanAction === 'sip' ? { type: 'sip', destination: run.sipUri || null }
      : run.humanAction === 'forward' ? { type: 'phone', destination: run.humanForward || null }
      : (run.mode !== 'drop' && run.forward) ? { type: 'phone', destination: run.forward } : null;
    body = {
      event: 'call_result',
      runId: run.id, legId, callUuid: leg.uuid, mode: run.mode,
      number: leg.m.number, name: leg.m.name || null, whoId: leg.m.whoId || null,
      from: leg.from || run.from,
      answeredBy: meta.answeredBy,              // human | machine | none
      action: meta.action,                      // voicemail_left | transferred_to_agent | skipped | live_conversation | no_answer | failed
      transferredTo: (String(meta.action).startsWith('transferred') && agent) ? agent : null,
      voicemailMessageId: outcome === 'machine_message_dropped' ? (run.messageId || 'default') : null,
      outcome,                                  // full internal status, for reference
      detail: detail || null,
      timeouts: { ringSec: run.ringTimeout, beepSec: run.beepTimeout, agentSec: run.agentTimeout },
      at: new Date().toISOString(),
    };
  } else {
    body = {
      event: 'run_completed', runId: run.id, mode: run.mode,
      total: run.list.length, counts: run.counts, at: new Date().toISOString(),
    };
  }
  postWebhook(run.resultWebhook, body, run.id, legId != null ? 'result' : 'run');
}

// fire-and-forget Salesforce activity log for a leg's member
function logSf(runId, legId, kind, detail) {
  const run = runs[runId];
  const m = run && run.legs[legId] && run.legs[legId].m;
  if (!run || !run.logToSf || !m || !m.whoId) return;
  sfdc.logActivity(m.whoId, kind, detail)
    .then((r) => { if (r && r.id) addLog(runId, `logged to Salesforce (${String(kind).replace(/_/g, ' ')}) on ${m.name || m.whoId}`, 'info'); })
    .catch((e) => addLog(runId, 'Salesforce log failed: ' + e.message, 'bad'));
}

// ---------------------------------------------------------------- routes
app.get('/_/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/call', async (req, res) => {
  const b = req.body || {};
  const mode = ['detect', 'detect_beep', 'drop'].includes(b.mode) ? b.mode : 'detect';
  // caller id can be one number or several (comma-separated, or an array) to
  // spread a run's calls across a number pool. Defaults to VONAGE_FROM.
  const fromPool = (Array.isArray(b.from) ? b.from : String(b.from || '').split(','))
    .map(clean).filter((n) => n.length >= 7);
  if (!fromPool.length && DEFAULT_FROM) fromPool.push(clean(DEFAULT_FROM));
  const from = fromPool[0] || DEFAULT_FROM;
  const logToSf = !!b.logToSf && sfdc.isConfigured();
  const runId = crypto.randomUUID().slice(0, 8);
  const resultWebhook = /^https?:\/\//.test(String(b.resultWebhook || '')) ? String(b.resultWebhook) : null;

  // ---- configurable timeouts (seconds). All optional, with safe defaults ----
  const num = (v, def, lo, hi) => { const n = parseInt(v, 10); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def; };
  const ringTimeout = num(b.ringTimeout, 45, 5, 120);   // ring the called party this long, then hang up (no answer)
  const beepTimeout = num(b.beepTimeout, 30, 30, 120);  // AMD: Vonage waits up to this for the beep, then emits beep_timeout (min 30)
  const agentTimeout = num(b.agentTimeout, 45, 5, 120); // ring the agent/forward this long on transfer, then give up
  const dropDelay = num(b.dropDelay, 12, 2, 30);        // drop mode: if no beep event, leave the message this long after machine detection
  const minGreeting = num(b.minGreeting, 3, 0, 20);     // drop mode: ignore any "beep" within this many secs of answer (false-beep guard)

  const toMember = (x) => (typeof x === 'string'
    ? { number: clean(x) }
    : { number: clean(x.number), whoId: x.whoId, name: x.name });

  const run = {
    id: runId, mode, from, fromPool, logToSf, resultWebhook,
    ringTimeout, beepTimeout, agentTimeout, dropDelay, minGreeting,
    legs: {}, nextIdx: 0, active: 0, counts: {}, finished: false,
    createdAt: Date.now(),
  };
  if (shuttingDown) return res.status(503).json({ error: 'service is restarting - retry shortly' });

  if (mode === 'drop') {
    let list = [];
    if (b.listId) {                                   // a saved list
      const saved = lists[b.listId];
      if (!saved) return res.status(400).json({ error: `unknown listId "${b.listId}" - see GET /api/lists` });
      list = saved.members.map(toMember).filter((m) => m.number.length >= 7);
    } else if (Array.isArray(b.members) && b.members.length) {
      list = b.members.map(toMember).filter((m) => m.number.length >= 7);
    } else {
      list = parseMembers(b.numbers).map(toMember).filter((m) => m.number.length >= 7);
    }
    if (!list.length) return res.status(400).json({ error: 'enter at least one valid number in the list' });
    run.list = list;
    run.concurrency = Math.max(1, Math.min(10, parseInt(b.concurrency, 10) || 1));
    run.messageId = b.messageId && messages[b.messageId] ? String(b.messageId) : null;
    if (b.messageId && !run.messageId && b.messageId !== 'default') {
      return res.status(400).json({ error: `unknown messageId "${b.messageId}" - see GET /api/messages` });
    }
    // what to do when a HUMAN answers
    run.humanAction = ['skip', 'forward', 'sip'].includes(b.humanAction) ? b.humanAction : 'skip';
    if (run.humanAction === 'forward') {
      run.humanForward = clean(b.humanForward);
      if (run.humanForward.length < 7) return res.status(400).json({ error: 'humanForward number required for humanAction=forward' });
    }
    if (run.humanAction === 'sip') {
      run.sipUri = String(b.sipUri || '').trim();
      if (!/^sips?:/.test(run.sipUri)) return res.status(400).json({ error: 'sipUri (sip:...) required for humanAction=sip' });
      run.sipHeaders = (b.sipHeaders && typeof b.sipHeaders === 'object' && !Array.isArray(b.sipHeaders)) ? b.sipHeaders : {};
    }
    runs[runId] = run;
    persist(run);
    addLog(runId, `drop run started - ${list.length} number${list.length === 1 ? '' : 's'}, concurrency ${run.concurrency} from ${fromPool.length === 1 ? fromPool[0] : fromPool.length + ' numbers'}, ${msgLabel(run)}`
      + (run.humanAction === 'sip' ? `, humans -> SIP agent` : run.humanAction === 'forward' ? `, humans -> ${run.humanForward}` : ', humans skipped')
      + (logToSf ? ', logging to Salesforce' : '') + (resultWebhook ? ', pushing results' : ''));
    launchNext(runId);
    return res.json({ ok: true, sid: runId, runId, legs: list.length, concurrency: run.concurrency });
  }

  // transfer modes - a single-member run
  const to = clean(b.to), forward = clean(b.forward);
  if (to.length < 7) return res.status(400).json({ error: 'enter a valid number to call' });
  if (forward.length < 7) return res.status(400).json({ error: 'enter a valid forward number' });
  run.list = [b.member ? toMember(b.member) : { number: to }];
  run.forward = forward;
  run.concurrency = 1;
  runs[runId] = run;
  run.nextIdx = 1;
  run.active = 1;
  persist(run);
  const ok = await placeLeg(runId, 0);
  if (!ok) return res.status(502).json({ error: 'Vonage rejected the call - see the log', sid: runId });
  res.json({ ok: true, sid: runId, runId });
});

// run status - per-leg outcomes for polling from the client's system
app.get('/api/run/:id', (req, res) => {
  const run = runs[req.params.id];
  if (!run) return res.status(404).json({ error: 'unknown run' });
  res.json({
    runId: run.id, mode: run.mode, total: run.list.length, dialled: run.nextIdx,
    active: run.active, finished: run.finished, counts: run.counts,
    legs: Object.entries(run.legs).map(([id, l]) => ({
      legId: Number(id), number: l.m.number, name: l.m.name || null, whoId: l.m.whoId || null,
      callUuid: l.uuid, outcome: l.outcome, finished: !!l.finished,
    })),
  });
});

// ------------------------------------------------- voicemail message routes
// POST ?name=  -> stored as a NAMED message (returns its id)
// POST         -> replaces the unnamed default (back-compat)
app.post('/api/message', express.raw({ type: '*/*', limit: '15mb' }), (req, res) => {
  if (!req.body || req.body.length < 1000) return res.status(400).json({ error: 'empty recording' });
  const name = String(req.query.name || '').trim();
  if (name) {
    const id = crypto.randomUUID().slice(0, 8);
    const file = path.join(MSG_DIR, `md-msg-${id}.wav`);
    try { fs.writeFileSync(file, req.body); } catch (e) { return res.status(500).json({ error: e.message }); }
    messages[id] = { name, bytes: req.body.length, file };
    saveMsgIndex();
    addLog('msg', `named message "${name}" saved (${Math.round(req.body.length / 1024)} KB) - id ${id}`, 'good');
    return res.json({ ok: true, id, name, bytes: req.body.length });
  }
  dropMessage = req.body;
  try { fs.writeFileSync(MSG_PATH, dropMessage); } catch {}
  addLog('msg', `default message saved (${Math.round(dropMessage.length / 1024)} KB)`, 'good');
  // persist durably so it survives a restart / redeploy (customer self-serve).
  // Free-plan KV quota is 1 MB; base64 of a short (<~20s) WAV fits comfortably.
  saveDurableDefault(dropMessage).then((ok) => {
    if (ok) addLog('msg', 'default announcement stored durably - it will survive restarts and redeploys', 'good');
    else addLog('msg', 'note: durable store unavailable, default kept in tmp only (lost on redeploy)', 'warn');
  });
  res.json({ ok: true, id: 'default', bytes: dropMessage.length, durable: !!vcrState() });
});
// ------------------------------------------------- saved call lists
// Save a reusable list. Body: { name, numbers } (paste/CSV text) or
// { name, members:[{number,name?,whoId?}] }. Returns its id.
app.post('/api/list', (req, res) => {
  const b = req.body || {};
  const name = String(b.name || '').trim();
  if (!name) return res.status(400).json({ error: 'name required' });
  let members = [];
  if (Array.isArray(b.members)) members = b.members.map((m) => ({ number: clean(m.number), name: m.name, whoId: m.whoId })).filter((m) => m.number.length >= 7);
  else members = parseMembers(b.numbers);
  if (!members.length) return res.status(400).json({ error: 'no valid numbers - one per line, CSV number[,name[,whoId]]' });
  const id = crypto.randomUUID().slice(0, 8);
  lists[id] = { name, members, createdAt: Date.now() };
  saveListIndex();
  addLog('list', `saved list "${name}" (${members.length} numbers) - id ${id}`, 'good');
  res.json({ ok: true, id, name, count: members.length });
});
app.get('/api/lists', (req, res) => res.json({
  lists: Object.entries(lists).map(([id, l]) => ({ id, name: l.name, count: l.members.length, createdAt: l.createdAt })),
}));
app.get('/api/list/registry/:id', (req, res) => {
  const l = lists[req.params.id];
  if (!l) return res.status(404).json({ error: 'unknown list id' });
  res.json({ id: req.params.id, name: l.name, members: l.members });
});
app.delete('/api/list/:id', (req, res) => {
  if (!lists[req.params.id]) return res.status(404).json({ error: 'unknown list id' });
  const nm = lists[req.params.id].name;
  delete lists[req.params.id]; saveListIndex();
  addLog('list', `deleted list "${nm}"`);
  res.json({ ok: true });
});

app.get('/api/messages', (req, res) => res.json({
  default: { recorded: !!dropMessage, bytes: dropMessage ? dropMessage.length : 0, auto: AUTO_MESSAGE },
  messages: Object.entries(messages).map(([id, m]) => ({ id, name: m.name, bytes: m.bytes })),
}));
app.get('/api/message', (req, res) => res.json({ recorded: !!dropMessage, bytes: dropMessage ? dropMessage.length : 0, auto: AUTO_MESSAGE }));
app.delete('/api/message/:id', (req, res) => {
  const m = messages[req.params.id];
  if (!m) return res.status(404).json({ error: 'unknown message id' });
  try { fs.existsSync(m.file) && fs.unlinkSync(m.file); } catch {}
  delete messages[req.params.id];
  saveMsgIndex();
  addLog('msg', `named message "${m.name}" deleted`);
  res.json({ ok: true });
});
app.delete('/api/message', (req, res) => {
  try { fs.existsSync(MSG_PATH) && fs.unlinkSync(MSG_PATH); } catch {}
  deleteDurableDefault();
  // fall back to the bundled announcement if one ships with the app, else TTS
  dropMessage = fs.existsSync(BUNDLED_MSG) ? fs.readFileSync(BUNDLED_MSG) : null;
  addLog('msg', dropMessage ? 'reverted to the bundled default announcement' : 'reverted to automatic message', 'info');
  res.json({ ok: true });
});
app.get('/message.wav', (req, res) => {
  if (!dropMessage) return res.status(404).end();
  res.set('Content-Type', 'audio/wav').send(dropMessage);
});
app.get('/message/:id.wav', (req, res) => {
  const m = messages[req.params.id];
  if (!m || !fs.existsSync(m.file)) return res.status(404).end();
  res.set('Content-Type', 'audio/wav').send(fs.readFileSync(m.file));
});

// ------------------------------------------------------- event webhook
// Optional spoofing protection: set VONAGE_SIGNATURE_SECRET (your application's
// signature secret) and every event must carry a valid signed JWT whose
// payload_hash matches the body.
function eventSignatureOk(req) {
  if (!SIGNATURE_SECRET) return true; // verification off
  try {
    const tok = (req.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const payload = jwt.verify(tok, SIGNATURE_SECRET, { algorithms: ['HS256'] });
    const hash = crypto.createHash('sha256').update(JSON.stringify(req.body)).digest('hex');
    return !payload.payload_hash || payload.payload_hash === hash;
  } catch { return false; }
}

// per-leg event webhook - the whole detect/act brain lives here
app.post('/webhooks/events', async (req, res) => {
  res.status(200).end();
  const runId = req.query.sid || '?';
  const legId = Number(req.query.leg || 0);
  const ev = req.body || {};
  const run = runs[runId];
  const leg = run && run.legs[legId];
  const status = ev.status, sub = ev.sub_state;

  if (!eventSignatureOk(req)) { addLog(runId, 'event with BAD signature ignored', 'bad'); return; }
  if (status && !['machine', 'human'].includes(status)) addLog(runId, `leg ${legId + 1} status: ${status}`);
  if (!run || !leg) return;
  if (status === 'answered' && !leg.answeredAt) leg.answeredAt = Date.now();

  // ANY terminal status frees the leg - a failed/busy/unanswered call never
  // sends 'completed', and treating only 'completed' as terminal stalls a slot.
  const TERMINAL = ['completed', 'failed', 'rejected', 'busy', 'unanswered', 'timeout', 'cancelled'];
  if (TERMINAL.includes(status)) {
    for (const t of ['dropTimer', 'hangTimer', 'watchdog']) { if (leg[t]) { clearTimeout(leg[t]); leg[t] = null; } }
    if (!leg.done && status === 'completed') addLog(runId, `leg ${legId + 1} - ended before detection`);
    finishLeg(runId, legId, leg.outcome || (status === 'completed' ? (leg.done ? 'completed' : 'no_answer') : status));
    return;
  }
  if (leg.done) return;

  if (status === 'human') {
    leg.done = true;
    if (run.mode === 'drop' && run.humanAction === 'sip') {
      // HUMAN -> live agent on a SIP endpoint (e.g. Vonage Contact Center),
      // custom headers carry agent id / CRM record id for the screen pop.
      const headers = {};
      for (const [k, v] of Object.entries(run.sipHeaders || {})) headers[k] = tmpl(v, run, legId, leg.m);
      addLog(runId, `HUMAN detected - connecting SIP agent (${run.sipUri}) into the call`, 'good');
      const r = await bridgeIntoConversation(run, leg, { type: 'sip', uri: run.sipUri, headers });
      if (r.status < 300) {
        leg.outcome = 'human_transferred'; leg.agentUuid = r.data && r.data.uuid;
        if (leg.watchdog) { clearTimeout(leg.watchdog); leg.watchdog = null; } // bridged call can outlast the watchdog; it will 'completed' naturally
        addLog(runId, `leg ${legId + 1} - SIP agent connected into the call`, 'good');
        logSf(runId, legId, 'live', 'A person answered; call connected to a live agent.');
      } else {
        leg.outcome = 'transfer_failed';
        addLog(runId, `leg ${legId + 1} SIP connect FAILED: ` + JSON.stringify(r.data).slice(0, 200), 'bad');
        await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, { action: 'hangup' }).catch(() => {});
      }
      return; // 'completed' fires when the conversation ends
    }
    if (run.mode === 'drop' && run.humanAction === 'forward') {
      addLog(runId, `HUMAN detected - connecting ${run.humanForward} into the call`, 'good');
      const r = await bridgeIntoConversation(run, leg, { type: 'phone', number: run.humanForward });
      if (r.status < 300) {
        leg.outcome = 'human_transferred'; leg.agentUuid = r.data && r.data.uuid;
        if (leg.watchdog) { clearTimeout(leg.watchdog); leg.watchdog = null; } // bridged call can outlast the watchdog; it will 'completed' naturally
        addLog(runId, `leg ${legId + 1} - ${run.humanForward} connected into the call`, 'good');
        logSf(runId, legId, 'live', `A person answered; call connected to ${run.humanForward}.`);
      } else {
        leg.outcome = 'transfer_failed';
        addLog(runId, `leg ${legId + 1} connect FAILED: ` + JSON.stringify(r.data).slice(0, 200), 'bad');
        await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, { action: 'hangup' }).catch(() => {});
      }
      return;
    }
    // default: humans are the point in transfer modes / skipped in drop mode
    addLog(runId, 'HUMAN detected - live conversation' + (run.mode === 'drop' ? ' (skipping, no message left)' : ''), 'good');
    leg.outcome = run.mode === 'drop' ? 'human_skipped' : 'human';
    logSf(runId, legId, 'live', 'A live conversation happened - a person answered' + (run.mode === 'drop' ? ' (no voicemail left).' : '.'));
    await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, {
      action: 'transfer',
      destination: { type: 'ncco', ncco: [
        { action: 'talk', text: 'Sorry to disturb you. Goodbye.', language: 'en-US' },
      ] },
    });
    return;
  }

  if (status === 'machine') {
    addLog(runId, `leg ${legId + 1} MACHINE detected` + (sub ? ` (${sub})` : ''), 'warn');
    // (A) notify the CRM the MOMENT a machine is detected - once, and separate
    // from the "message left" hook that follows. Andrew/David wanted the info ASAP.
    if (!leg.machineNotified) {
      leg.machineNotified = true;
      logSf(runId, legId, 'machine_detected', 'Answering machine detected.');
      pushDetection(run, legId);
    }
    const atBeep = sub === 'beep_start' || sub === 'beep_timeout';

    if (run.mode === 'drop') {
      if (leg.transferred) return;
      // Leave the voicemail message, then hang up as soon as it finishes. The
      // ideal moment is right after the beep, but carrier voicemails are
      // unreliable: some never send a beep, some fire a FALSE beep at t=0 (a
      // greeting artefact). So we drop on a beep only once past a minimum
      // greeting window, and if no beep arrives we drop anyway after a delay.
      const doDrop = async () => {
        if (leg.transferred) return;
        leg.transferred = true; leg.done = true;
        if (leg.dropTimer) { clearTimeout(leg.dropTimer); leg.dropTimer = null; }
        const r = await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, {
          action: 'transfer',
          destination: { type: 'ncco', ncco: dropNcco(run) },
        });
        if (r.status < 300) {
          leg.outcome = 'machine_message_dropped';
          addLog(runId, `leg ${legId + 1} - ${msgLabel(run)} left on the voicemail`, 'good');
          logSf(runId, legId, 'machine_message_left', 'Voicemail message left.');
          // (B) hang up the moment the message ends instead of waiting for the
          // voicemail's max-length timeout (which kept the leg open too long).
          const durMs = messageDurationMs(run);
          leg.hangTimer = setTimeout(() => {
            api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, { action: 'hangup' }).catch(() => {});
            addLog(runId, `leg ${legId + 1} - message finished (~${Math.round(durMs / 1000)}s), hanging up`, 'info');
          }, durMs + 1500);
        } else {
          leg.outcome = 'drop_failed';
          addLog(runId, `leg ${legId + 1} drop FAILED: ` + JSON.stringify(r.data).slice(0, 200), 'bad');
        }
      };
      // (C) ignore a beep that arrives before the greeting could plausibly finish
      // - that "beep" is an artefact, and dropping then plays into the greeting
      // (before recording starts) and leaves a blank message.
      const MIN_GREETING = (run.minGreeting || 3) * 1000;
      const since = Date.now() - (leg.answeredAt || leg.startedAt || Date.now());
      if (atBeep && since >= MIN_GREETING) { await doDrop(); return; } // real beep OR Vonage's beep_timeout -> drop the message now, right after the beep
      if (atBeep) addLog(runId, `leg ${legId + 1} - ignoring an early beep at ${(since / 1000).toFixed(1)}s (likely a greeting artefact)`, 'warn');
      // bare 'machine' (no beep yet). In detect_beep mode Vonage still owes us a
      // beep_start or beep_timeout event, so WAIT for it - dropping too early
      // plays the message into the greeting, before the recording starts, and
      // leaves a blank voicemail. Only fall back if that event never arrives.
      if (!leg.dropTimer) {
        const waitMs = run.amdMode === 'detect_beep'
          ? ((run.beepTimeout || 30) + 8) * 1000  // let beep_start / beep_timeout arrive first
          : (run.dropDelay || 12) * 1000;         // detect mode gets no beep events -> short hold then drop
        addLog(runId, `leg ${legId + 1} - machine detected; leaving the message on the beep` + (run.amdMode === 'detect_beep' ? ` (or after ${waitMs / 1000}s if Vonage reports no beep)` : ` in ${waitMs / 1000}s`));
        leg.dropTimer = setTimeout(() => { doDrop().catch(() => {}); }, waitMs);
      }
      return; // 'completed' fires when we hang up after the message
    }

    // transfer modes: act on the FIRST machine signal - do NOT wait for a beep.
    // Carrier voicemails often never present a clean beep, so waiting left the
    // call sitting silently bridged to the live-listen socket, which the
    // voicemail then recorded as a BLANK message and we logged as "no answer".
    if (leg.transferred) return;
    leg.transferred = true; leg.done = true;
    if (!run.forward) {
      // no agent to transfer to and no message to leave -> hang up immediately
      // so we never record a blank voicemail; report it honestly as a machine.
      await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, { action: 'hangup' }).catch(() => {});
      leg.outcome = 'machine';
      addLog(runId, `leg ${legId + 1} - answering machine, no forward set; hung up (no blank voicemail left)`, 'warn');
      logSf(runId, legId, 'machine', 'Answering machine / voicemail reached - no message left.');
      return;
    }
    const r = await bridgeIntoConversation(run, leg, { type: 'phone', number: run.forward });
    if (r.status < 300) {
      leg.outcome = 'machine_transferred'; leg.agentUuid = r.data && r.data.uuid;
        if (leg.watchdog) { clearTimeout(leg.watchdog); leg.watchdog = null; } // bridged call can outlast the watchdog; it will 'completed' naturally
      addLog(runId, `connected ${run.forward} into the call`, 'good');
      logSf(runId, legId, 'machine', `Answering machine detected; call connected to ${run.forward}.`);
    } else {
      leg.outcome = 'transfer_failed';
      await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, { action: 'hangup' }).catch(() => {}); // don't leave a blank voicemail
      addLog(runId, 'connect FAILED: ' + JSON.stringify(r.data).slice(0, 200), 'bad');
    }
  }
});

app.get('/webhooks/answer', (req, res) => res.json([{ action: 'talk', text: 'Vonage machine detect service.', language: 'en-US' }]));

// ------------------------------------------------------------ Salesforce API
app.get('/api/sf/status', async (req, res) => res.json(await sfdc.status()));
app.post('/api/sf/connect', async (req, res) => {
  try { const t = await sfdc.configure(req.body || {}); res.json({ ok: true, instanceUrl: t.instanceUrl }); }
  catch (e) { res.status(400).json({ ok: false, error: e.message }); }
});
app.get('/api/sf/lists', async (req, res) => {
  try { res.json({ lists: await sfdc.lists() }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get('/api/sf/list/:id', async (req, res) => {
  try { res.json({ members: await sfdc.members(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.get('/api/log', (req, res) => {
  const since = Number(req.query.since || 0);
  res.json({ now: Date.now(), events: log.filter((e) => e.t > since) });
});

// lets the UI prefill the configured caller number without hard-coding it
app.get('/api/config', (req, res) => res.json({ from: DEFAULT_FROM }));

// ------------------------------------------------ take the code with you
// Everything the app is made of, so a team can lift it into their own stack
// (no VCR required). Secrets are NEVER part of the source - config is env only.
const SOURCE_FILES = [
  'server.js', 'salesforce.js', 'store.js', 'public/index.html', 'public/code.html',
  'package.json', '.env.example', 'vcr.yml.example', 'README.md', 'IMPLEMENTATION.md',
];
const readSource = () => SOURCE_FILES.map((f) => {
  try { return { path: f, content: fs.readFileSync(path.join(__dirname, f), 'utf8') }; }
  catch { return null; }
}).filter(Boolean);

app.get('/api/source', (req, res) => res.json({
  repo: 'https://github.com/Omriak10/vonage-machine-detect',
  files: readSource(),
}));
app.get('/code/raw/:file', (req, res) => {
  const f = SOURCE_FILES.find((x) => x.replace(/\//g, '__') === req.params.file || x === req.params.file);
  if (!f) return res.status(404).end();
  res.set('Content-Type', 'text/plain; charset=utf-8').send(fs.readFileSync(path.join(__dirname, f), 'utf8'));
});
app.get('/code', (req, res) => res.sendFile(path.join(__dirname, 'public', 'code.html')));
app.get('/guide', (req, res) => res.sendFile(path.join(__dirname, 'public', 'guide.html')));

// ------------------------------------------------------ live listen bridge
// Vonage streams the call audio here; every browser listener gets a copy.
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const listeners = new Set();   // browser sockets (all hear whatever call is live)

wss.on('connection', (sock, req) => {
  const u = new URL(req.url, 'http://x');
  const sid = u.searchParams.get('sid') || '?';
  if (u.pathname === '/socket/listen') {
    listeners.add(sock);
    sock.on('close', () => listeners.delete(sock));
    return;
  }
  if (u.pathname === '/socket/vonage') {
    addLog(sid, 'live audio connected - you can listen now', 'info');
    sock.on('message', (buf, isBinary) => {
      if (!isBinary) return; // first message is JSON metadata
      for (const l of listeners) if (l.readyState === 1) l.send(buf);
    });
    sock.on('close', () => addLog(sid, 'live audio ended'));
    return;
  }
  sock.close();
});

// ------------------------------------------------ resume after a restart
// Rehydrate persisted runs so late/retried Vonage events find their run, then
// reconcile in-flight legs and resume dialling the not-yet-dialled members.
async function reconcile() {
  const saved = store.all();
  const ids = Object.keys(saved);
  if (!ids.length) return;
  console.log(`[resume] found ${ids.length} persisted run(s)`);
  for (const id of ids) {
    const r = saved[id];
    if (r.finished) { store.remove(id); continue; }
    // rehydrate runtime fields
    r.active = 0; r.cur = null;
    if (!Array.isArray(r.fromPool) || !r.fromPool.length) r.fromPool = [r.from || DEFAULT_FROM];
    runs[id] = r;
    addLog(id, `resuming run after restart - ${Object.keys(r.legs).length} dialled of ${r.list.length}, ${r.nextIdx} claimed`, 'warn');

    // reconcile legs that were dialled but not settled: ask Vonage what happened
    for (const [legId, leg] of Object.entries(r.legs)) {
      if (leg.finished) continue;
      if (!leg.uuid) { finishLeg(id, Number(legId), 'failed', 'no call placed before restart'); continue; }
      const { status, data } = await api('GET', 'https://api.nexmo.com/v1/calls/' + leg.uuid).catch(() => ({ status: 0, data: {} }));
      const st = (data && data.status) || '';
      if (status >= 300) { finishLeg(id, Number(legId), leg.outcome || 'reconcile_unknown', 'call not found on reconcile'); continue; }
      if (['completed', 'failed', 'rejected', 'busy', 'unanswered', 'timeout', 'cancelled'].includes(st)) {
        // the call already ended while we were down - settle the leg
        finishLeg(id, Number(legId), leg.outcome || 'ended_during_restart', `reconciled: ${st}`);
      } else {
        // still live (ringing/answered) - its own events will keep arriving at
        // this instance's event_url now that we're back; leave the slot held.
        r.active++;
        addLog(id, `leg ${Number(legId) + 1} still live (${st}) - awaiting its events`);
      }
    }
    // resume dialling whatever was never claimed
    launchNext(id);
  }
}

// ------------------------------------------------ graceful shutdown
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[${sig}] draining - not starting new calls; in-flight calls persist and resume on next boot`);
  // flush everything to disk (already persisted at each transition, but be safe)
  for (const r of Object.values(runs)) if (!r.finished) store.save(r);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 8000).unref(); // hard stop backstop
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, () => {
  console.log('Machine Detect (VCR) on :' + PORT);
  reconcile().catch((e) => console.error('[resume] error', e.message));
});
