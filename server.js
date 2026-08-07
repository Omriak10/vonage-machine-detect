// Machine Detect - outbound calls + Vonage Advanced Machine Detection (VCR).
//
// Modes:
//   detect       - transfer to the forward number as soon as a machine answers
//   detect_beep  - same, but transfer after the voicemail beep
//   drop         - VOICEMAIL DROP: dial a LIST of numbers; when a machine
//                  answers, play the operator's recorded message after the
//                  beep, hang up, and dial the next number automatically.
//                  Humans get a short notice, never the drop.
//
// Live listen: every call leg is bridged to a websocket (audio/l16, 16 kHz),
// rebroadcast to any browser listening on /socket/listen - so you can hear
// the far side (greeting, machine, beep) straight from this page.
//
//   GET  /                  - console UI
//   POST /api/call          - {mode, to|numbers[], forward?, from?}
//   POST /api/message       - upload the recorded drop message (WAV body)
//   GET  /message.wav       - the stored drop message (fetched by Vonage)
//   GET  /api/log?since=    - event timeline for the UI
//   POST /webhooks/events   - Voice API event webhook (per-call event_url)
//   WS   /socket/vonage?sid - call audio in from Vonage
//   WS   /socket/listen?sid - browser listeners
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
const calls = {};   // sid -> session (single-operator demo tool)
const log = [];
const addLog = (sid, msg, kind = 'info') => {
  log.push({ t: Date.now(), sid, msg, kind });
  if (log.length > 500) log.splice(0, log.length - 500);
  console.log(`[${sid}] ${msg}`);
};
const clean = (n) => String(n || '').replace(/[^\d]/g, '');

// the operator's recorded voicemail-drop message (survives within the instance).
// optional: if nothing is recorded, drop mode falls back to AUTO_MESSAGE (TTS).
const MSG_PATH = path.join(os.tmpdir(), 'drop-message.wav');
let dropMessage = fs.existsSync(MSG_PATH) ? fs.readFileSync(MSG_PATH) : null;
const AUTO_MESSAGE = "Hello, this is an automated message from Vonage. We tried to reach you but could not connect. "
  + "Please call us back at your earliest convenience. Thank you, and have a great day.";

// the NCCO played into a voicemail: recorded WAV if we have one, else spoken auto message
const dropNcco = () => dropMessage
  ? [{ action: 'stream', streamUrl: [HOST + '/message.wav'] }]
  : [{ action: 'talk', text: AUTO_MESSAGE, language: 'en-US', style: 2 }];

// ---------------------------------------------------------------- calling
// every call targets a "member": { number, whoId?, name? }. Drop mode walks a
// list of them; transfer modes have a single member. whoId (from Salesforce)
// enables activity logging.
async function placeCall(sid) {
  const c = calls[sid];
  const m = c.mode === 'drop' ? c.list[c.idx] : c.single;
  c.cur = m;
  const amd = {
    behavior: 'continue',
    mode: c.mode === 'detect' ? 'detect' : 'detect_beep', // drops wait for the beep
    beep_timeout: 45, // mandatory for AMD (30-120s) whatever the mode
  };
  const { status, data } = await api('POST', 'https://api.nexmo.com/v1/calls', {
    to: [{ type: 'phone', number: m.number }],
    from: { type: 'phone', number: c.from },
    advanced_machine_detection: amd,
    event_url: [HOST + '/webhooks/events?sid=' + sid],
    ncco: [
      // websocket leg keeps the call alive while AMD runs AND feeds live listen
      { action: 'connect', from: c.from, endpoint: [{
        type: 'websocket',
        uri: WS_HOST + '/socket/vonage?sid=' + sid,
        'content-type': 'audio/l16;rate=16000',
      }] },
    ],
  });
  if (status >= 300 || !data.uuid) {
    addLog(sid, `call to ${m.number} FAILED: ` + JSON.stringify(data).slice(0, 250), 'bad');
    if (c.mode === 'drop') nextInList(sid);
    return false;
  }
  c.uuid = data.uuid; c.transferred = false; c.done = false;
  const who = m.name ? ` (${m.name})` : '';
  addLog(sid, c.mode === 'drop'
    ? `[${c.idx + 1}/${c.list.length}] calling ${m.number}${who} from ${c.from} - drop message on machine`
    : `calling ${m.number}${who} from ${c.from} (AMD ${amd.mode}) - on machine, forward to ${c.forward}`);
  return true;
}

function nextInList(sid) {
  const c = calls[sid];
  if (c.mode !== 'drop') return;
  c.idx++;
  if (c.idx >= c.list.length) {
    addLog(sid, `list finished - ${c.dropped} message${c.dropped === 1 ? '' : 's'} left on ${c.list.length} number${c.list.length === 1 ? '' : 's'}`, 'good');
    return;
  }
  setTimeout(() => placeCall(sid), 1500);
}

// fire-and-forget Salesforce activity log for the current member
function logSf(sid, kind, detail) {
  const c = calls[sid];
  if (!c || !c.logToSf || !c.cur || !c.cur.whoId) return;
  sfdc.logActivity(c.cur.whoId, kind, detail)
    .then((r) => { if (r && r.id) addLog(sid, `logged to Salesforce (${kind === 'machine' ? 'machine detected' : 'live conversation'}) on ${c.cur.name || c.cur.whoId}`, 'info'); })
    .catch((e) => addLog(sid, 'Salesforce log failed: ' + e.message, 'bad'));
}

// ---------------------------------------------------------------- routes
app.get('/_/health', (req, res) => res.status(200).send('OK'));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.post('/api/call', async (req, res) => {
  const mode = ['detect', 'detect_beep', 'drop'].includes(req.body.mode) ? req.body.mode : 'detect';
  const from = clean(req.body.from) || DEFAULT_FROM;
  const logToSf = !!req.body.logToSf && sfdc.isConfigured();
  const sid = crypto.randomUUID().slice(0, 8);

  // members can come from Salesforce (array of {number, whoId, name}) or from
  // the pasted textarea (plain numbers)
  const toMember = (x) => (typeof x === 'string'
    ? { number: clean(x) }
    : { number: clean(x.number), whoId: x.whoId, name: x.name });

  if (mode === 'drop') {
    let list = [];
    if (Array.isArray(req.body.members) && req.body.members.length) {
      list = req.body.members.map(toMember).filter((m) => m.number.length >= 7);
    } else {
      list = String(req.body.numbers || '').split(/[\n,;]+/).map((n) => ({ number: clean(n) })).filter((m) => m.number.length >= 7);
    }
    if (!list.length) return res.status(400).json({ error: 'enter at least one valid number in the list' });
    calls[sid] = { mode, list, idx: 0, from, dropped: 0, logToSf };
    addLog(sid, `voicemail drop started - ${list.length} number${list.length === 1 ? '' : 's'}, `
      + (dropMessage ? 'your recorded message' : 'automatic message')
      + (logToSf ? ', logging to Salesforce' : ''));
  } else {
    const to = clean(req.body.to), forward = clean(req.body.forward);
    if (to.length < 7) return res.status(400).json({ error: 'enter a valid number to call' });
    if (forward.length < 7) return res.status(400).json({ error: 'enter a valid forward number' });
    const single = req.body.member ? toMember(req.body.member) : { number: to };
    calls[sid] = { mode, single, forward, from, logToSf };
  }

  const ok = await placeCall(sid);
  if (!ok && calls[sid].mode !== 'drop') return res.status(502).json({ error: 'Vonage rejected the call - see the log', sid });
  res.json({ ok: true, sid });
});

// browser-recorded WAV (already 16-bit PCM, encoded client-side)
app.post('/api/message', express.raw({ type: '*/*', limit: '15mb' }), (req, res) => {
  if (!req.body || req.body.length < 1000) return res.status(400).json({ error: 'empty recording' });
  dropMessage = req.body;
  try { fs.writeFileSync(MSG_PATH, dropMessage); } catch {}
  addLog('msg', `drop message saved (${Math.round(dropMessage.length / 1024)} KB)`, 'good');
  res.json({ ok: true, bytes: dropMessage.length });
});
app.get('/message.wav', (req, res) => {
  if (!dropMessage) return res.status(404).end();
  res.set('Content-Type', 'audio/wav').send(dropMessage);
});
app.get('/api/message', (req, res) => res.json({ recorded: !!dropMessage, bytes: dropMessage ? dropMessage.length : 0, auto: AUTO_MESSAGE }));
app.delete('/api/message', (req, res) => {
  dropMessage = null;
  try { fs.existsSync(MSG_PATH) && fs.unlinkSync(MSG_PATH); } catch {}
  addLog('msg', 'reverted to automatic message', 'info');
  res.json({ ok: true });
});

// per-call event webhook - the whole detect/act brain lives here
app.post('/webhooks/events', async (req, res) => {
  res.status(200).end();
  const sid = req.query.sid || '?';
  const ev = req.body || {};
  const c = calls[sid];
  const status = ev.status, sub = ev.sub_state;

  if (status && !['machine', 'human'].includes(status)) addLog(sid, 'status: ' + status);
  if (!c) return;

  if (status === 'completed') {
    const wasDone = c.done;
    c.done = true;
    if (c.mode === 'drop') { if (!wasDone) addLog(sid, 'no answer / ended before detection'); nextInList(sid); }
    return;
  }
  if (c.done) return;

  if (status === 'human') {
    addLog(sid, 'HUMAN detected - live conversation' + (c.mode === 'drop' ? ' (skipping, no message left)' : ''), 'good');
    c.done = true;
    logSf(sid, 'live', 'A live conversation happened - a person answered' + (c.mode === 'drop' ? ' (no voicemail left).' : '.'));
    // transfer modes forward the human? No - forwarding is machine-only. Human
    // is the person we wanted, so leave them a short notice and end.
    await api('PUT', 'https://api.nexmo.com/v1/calls/' + c.uuid, {
      action: 'transfer',
      destination: { type: 'ncco', ncco: [
        { action: 'talk', text: 'Sorry to disturb you. Goodbye.', language: 'en-US' },
      ] },
    });
    // drop mode advances on the 'completed' event, never from here
    return;
  }

  if (status === 'machine') {
    addLog(sid, 'MACHINE detected' + (sub ? ` (${sub})` : ''), 'warn');
    const atBeep = sub === 'beep_start' || sub === 'beep_timeout';

    if (c.mode === 'drop') {
      if (!atBeep || c.transferred) return;   // wait for the beep, drop once
      c.transferred = true; c.done = true; c.dropped++;
      const r = await api('PUT', 'https://api.nexmo.com/v1/calls/' + c.uuid, {
        action: 'transfer',
        destination: { type: 'ncco', ncco: dropNcco() },
      });
      addLog(sid, r.status < 300 ? `${dropMessage ? 'recorded' : 'automatic'} message dropped after the beep`
        : 'drop FAILED: ' + JSON.stringify(r.data).slice(0, 200), r.status < 300 ? 'good' : 'bad');
      if (r.status < 300) logSf(sid, 'machine', 'Answering machine detected; ' + (dropMessage ? 'recorded' : 'automated') + ' voicemail message left.');
      // 'completed' fires when the stream finishes -> nextInList from there
      return;
    }

    // transfer modes
    const go = c.mode === 'detect' ? true : atBeep;
    if (!go || c.transferred) return;
    c.transferred = true; c.done = true;
    const r = await api('PUT', 'https://api.nexmo.com/v1/calls/' + c.uuid, {
      action: 'transfer',
      destination: { type: 'ncco', ncco: [
        { action: 'connect', from: c.from, timeout: 45, endpoint: [{ type: 'phone', number: c.forward }] },
      ] },
    });
    addLog(sid, r.status < 300 ? `TRANSFERRED to ${c.forward}` : 'transfer FAILED: ' + JSON.stringify(r.data).slice(0, 200),
      r.status < 300 ? 'good' : 'bad');
    if (r.status < 300) logSf(sid, 'machine', `Answering machine detected; call transferred to ${c.forward}.`);
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
