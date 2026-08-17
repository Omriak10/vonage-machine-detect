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
const runs = {};    // runId -> run (see header). In-memory by design: for
                    // production, persist runs + messages to a durable store
                    // and resume from the last unprocessed member on restart.
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
const MSG_PATH = path.join(MSG_DIR, 'drop-message.wav'); // legacy default
let dropMessage = fs.existsSync(MSG_PATH) ? fs.readFileSync(MSG_PATH) : null;
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

const AUTO_MESSAGE = "Hello, this is an automated message from Vonage. We tried to reach you but could not connect. "
  + "Please call us back at your earliest convenience. Thank you, and have a great day.";

// the NCCO played into a voicemail for a given run
function dropNcco(run) {
  if (run.messageId && messages[run.messageId]) {
    return [{ action: 'stream', streamUrl: [HOST + '/message/' + run.messageId + '.wav'] }];
  }
  if (dropMessage) return [{ action: 'stream', streamUrl: [HOST + '/message.wav'] }];
  return [{ action: 'talk', text: AUTO_MESSAGE, language: 'en-US', style: 2 }];
}
const msgLabel = (run) => run.messageId && messages[run.messageId]
  ? `message "${messages[run.messageId].name}"` : (dropMessage ? 'default recorded message' : 'automatic message');

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

async function placeLeg(runId, legId) {
  const run = runs[runId];
  const m = run.list[legId];
  const leg = { m, uuid: null, transferred: false, done: false, outcome: null };
  run.legs[legId] = leg; // active slot was reserved by launchNext
  const amd = {
    behavior: 'continue',
    mode: run.mode === 'detect' ? 'detect' : 'detect_beep', // drops wait for the beep
    beep_timeout: 45, // mandatory for AMD (30-120s) whatever the mode
  };
  const { status, data } = await api('POST', 'https://api.nexmo.com/v1/calls', {
    to: [{ type: 'phone', number: m.number }],
    from: { type: 'phone', number: run.from },
    advanced_machine_detection: amd,
    event_url: [HOST + '/webhooks/events?sid=' + runId + '&leg=' + legId],
    ncco: [
      // websocket leg keeps the call alive while AMD runs AND feeds live listen
      { action: 'connect', from: run.from, endpoint: [{
        type: 'websocket',
        uri: WS_HOST + '/socket/vonage?sid=' + runId,
        'content-type': 'audio/l16;rate=16000',
      }] },
    ],
  });
  if (status >= 300 || !data.uuid) {
    addLog(runId, `call to ${m.number} FAILED: ` + JSON.stringify(data).slice(0, 250), 'bad');
    finishLeg(runId, legId, 'failed', JSON.stringify(data).slice(0, 200));
    return false;
  }
  leg.uuid = data.uuid;
  const who = m.name ? ` (${m.name})` : '';
  addLog(runId, run.mode === 'drop'
    ? `[${legId + 1}/${run.list.length}] calling ${m.number}${who} from ${run.from}`
    : `calling ${m.number}${who} from ${run.from} (AMD ${amd.mode}) - on machine, forward to ${run.forward}`);
  return true;
}

// a leg reached a terminal outcome: record it, push it, refill the dialler
function finishLeg(runId, legId, outcome, detail) {
  const run = runs[runId];
  const leg = run.legs[legId];
  if (!leg || leg.finished) return;
  leg.finished = true; leg.done = true; leg.outcome = outcome;
  run.active = Math.max(0, run.active - 1);
  run.counts[outcome] = (run.counts[outcome] || 0) + 1;
  pushResult(run, legId, outcome, detail);
  launchNext(runId);
}

function launchNext(runId) {
  const run = runs[runId];
  if (run.mode !== 'drop') { maybeFinishRun(runId); return; }
  let batch = 0;
  while (run.active < run.concurrency && run.nextIdx < run.list.length) {
    const legId = run.nextIdx++;
    run.active++; // reserve the slot now; finishLeg releases it
    setTimeout(() => placeLeg(runId, legId), 350 * batch++); // stagger to stay under account CPS
  }
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
  pushResult(run, null, 'run_completed', null);
}

// fire-and-forget outcome push to the client's webhook
function pushResult(run, legId, outcome, detail) {
  if (!run.resultWebhook) return;
  const leg = legId != null ? run.legs[legId] : null;
  const body = leg ? {
    event: 'call_result', runId: run.id, legId, mode: run.mode,
    number: leg.m.number, name: leg.m.name || null, whoId: leg.m.whoId || null,
    outcome, detail: detail || null, callUuid: leg.uuid, messageId: run.messageId || null,
    at: new Date().toISOString(),
  } : {
    event: 'run_completed', runId: run.id, mode: run.mode, total: run.list.length,
    counts: run.counts, at: new Date().toISOString(),
  };
  fetch(run.resultWebhook, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  }).catch((e) => addLog(run.id, 'result webhook failed: ' + e.message, 'bad'));
}

// fire-and-forget Salesforce activity log for a leg's member
function logSf(runId, legId, kind, detail) {
  const run = runs[runId];
  const m = run && run.legs[legId] && run.legs[legId].m;
  if (!run || !run.logToSf || !m || !m.whoId) return;
  sfdc.logActivity(m.whoId, kind, detail)
    .then((r) => { if (r && r.id) addLog(runId, `logged to Salesforce (${kind === 'machine' ? 'machine detected' : 'live conversation'}) on ${m.name || m.whoId}`, 'info'); })
    .catch((e) => addLog(runId, 'Salesforce log failed: ' + e.message, 'bad'));
}

// ---------------------------------------------------------------- routes
app.get('/_/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/call', async (req, res) => {
  const b = req.body || {};
  const mode = ['detect', 'detect_beep', 'drop'].includes(b.mode) ? b.mode : 'detect';
  const from = clean(b.from) || DEFAULT_FROM;
  const logToSf = !!b.logToSf && sfdc.isConfigured();
  const runId = crypto.randomUUID().slice(0, 8);
  const resultWebhook = /^https?:\/\//.test(String(b.resultWebhook || '')) ? String(b.resultWebhook) : null;

  const toMember = (x) => (typeof x === 'string'
    ? { number: clean(x) }
    : { number: clean(x.number), whoId: x.whoId, name: x.name });

  const run = {
    id: runId, mode, from, logToSf, resultWebhook,
    legs: {}, nextIdx: 0, active: 0, counts: {}, finished: false,
  };

  if (mode === 'drop') {
    let list = [];
    if (Array.isArray(b.members) && b.members.length) {
      list = b.members.map(toMember).filter((m) => m.number.length >= 7);
    } else {
      list = String(b.numbers || '').split(/[\n,;]+/).map((n) => ({ number: clean(n) })).filter((m) => m.number.length >= 7);
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
    addLog(runId, `drop run started - ${list.length} number${list.length === 1 ? '' : 's'}, concurrency ${run.concurrency}, ${msgLabel(run)}`
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
  res.json({ ok: true, id: 'default', bytes: dropMessage.length });
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
  dropMessage = null;
  try { fs.existsSync(MSG_PATH) && fs.unlinkSync(MSG_PATH); } catch {}
  addLog('msg', 'reverted to automatic message', 'info');
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

  // ANY terminal status frees the leg - a failed/busy/unanswered call never
  // sends 'completed', and treating only 'completed' as terminal stalls a slot.
  const TERMINAL = ['completed', 'failed', 'rejected', 'busy', 'unanswered', 'timeout', 'cancelled'];
  if (TERMINAL.includes(status)) {
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
      addLog(runId, `HUMAN detected - transferring to agent (${run.sipUri})`, 'good');
      const r = await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, {
        action: 'transfer',
        destination: { type: 'ncco', ncco: [
          { action: 'connect', from: run.from, timeout: 60,
            endpoint: [{ type: 'sip', uri: run.sipUri, headers }] },
        ] },
      });
      if (r.status < 300) {
        leg.outcome = 'human_transferred';
        addLog(runId, `leg ${legId + 1} TRANSFERRED to SIP agent`, 'good');
        logSf(runId, legId, 'live', 'A person answered; call transferred to a live agent.');
      } else {
        leg.outcome = 'transfer_failed';
        addLog(runId, `leg ${legId + 1} SIP transfer FAILED: ` + JSON.stringify(r.data).slice(0, 200), 'bad');
      }
      return; // 'completed' fires when the bridged call ends
    }
    if (run.mode === 'drop' && run.humanAction === 'forward') {
      addLog(runId, `HUMAN detected - transferring to ${run.humanForward}`, 'good');
      const r = await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, {
        action: 'transfer',
        destination: { type: 'ncco', ncco: [
          { action: 'connect', from: run.from, timeout: 60, endpoint: [{ type: 'phone', number: run.humanForward }] },
        ] },
      });
      leg.outcome = r.status < 300 ? 'human_transferred' : 'transfer_failed';
      if (r.status < 300) logSf(runId, legId, 'live', `A person answered; call transferred to ${run.humanForward}.`);
      else addLog(runId, `leg ${legId + 1} transfer FAILED: ` + JSON.stringify(r.data).slice(0, 200), 'bad');
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
    const atBeep = sub === 'beep_start' || sub === 'beep_timeout';

    if (run.mode === 'drop') {
      if (!atBeep || leg.transferred) return;   // wait for the beep, drop once
      leg.transferred = true; leg.done = true;
      const r = await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, {
        action: 'transfer',
        destination: { type: 'ncco', ncco: dropNcco(run) },
      });
      if (r.status < 300) {
        leg.outcome = 'machine_message_dropped';
        addLog(runId, `leg ${legId + 1} - ${msgLabel(run)} dropped after the beep`, 'good');
        logSf(runId, legId, 'machine', 'Answering machine detected; voicemail message left.');
      } else {
        leg.outcome = 'drop_failed';
        addLog(runId, `leg ${legId + 1} drop FAILED: ` + JSON.stringify(r.data).slice(0, 200), 'bad');
      }
      return; // 'completed' fires when the stream finishes
    }

    // transfer modes
    const go = run.mode === 'detect' ? true : atBeep;
    if (!go || leg.transferred) return;
    leg.transferred = true; leg.done = true;
    const r = await api('PUT', 'https://api.nexmo.com/v1/calls/' + leg.uuid, {
      action: 'transfer',
      destination: { type: 'ncco', ncco: [
        { action: 'connect', from: run.from, timeout: 45, endpoint: [{ type: 'phone', number: run.forward }] },
      ] },
    });
    leg.outcome = r.status < 300 ? 'machine_transferred' : 'transfer_failed';
    addLog(runId, r.status < 300 ? `TRANSFERRED to ${run.forward}` : 'transfer FAILED: ' + JSON.stringify(r.data).slice(0, 200),
      r.status < 300 ? 'good' : 'bad');
    if (r.status < 300) logSf(runId, legId, 'machine', `Answering machine detected; call transferred to ${run.forward}.`);
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

server.listen(PORT, () => console.log('Machine Detect (VCR) on :' + PORT));
