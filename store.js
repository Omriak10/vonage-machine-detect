// Durable run store - survives process restarts / crashes / redeploys within
// the instance. One JSON file per run, written atomically (temp file + rename)
// so a crash mid-write never corrupts state.
//
// This is intentionally dependency-free (fs only) so the app deploys anywhere.
// To move to Redis / a shared DB for multi-instance, swap this module - the
// interface is: load(), save(run), remove(id), all().
const fs = require('fs');
const os = require('os');
const path = require('path');

// STATE_DIR persists across process restarts on the same instance. Set it to a
// mounted/durable path for cross-deploy durability; defaults to the tmp dir.
const DIR = process.env.STATE_DIR || path.join(os.tmpdir(), 'md-state');
try { fs.mkdirSync(DIR, { recursive: true }); } catch {}

const file = (id) => path.join(DIR, `run-${id}.json`);

// what actually needs to survive a restart (not sockets/timers)
function serialize(run) {
  return JSON.stringify({
    id: run.id, mode: run.mode, from: run.from, logToSf: run.logToSf,
    resultWebhook: run.resultWebhook, list: run.list, nextIdx: run.nextIdx,
    counts: run.counts, finished: run.finished, concurrency: run.concurrency,
    messageId: run.messageId, forward: run.forward, humanAction: run.humanAction,
    humanForward: run.humanForward, sipUri: run.sipUri, sipHeaders: run.sipHeaders,
    createdAt: run.createdAt,
    // per-leg: keep the call uuid + outcome so a resumed run can reconcile
    legs: Object.fromEntries(Object.entries(run.legs || {}).map(([k, l]) => [k, {
      m: l.m, uuid: l.uuid, transferred: !!l.transferred, done: !!l.done,
      finished: !!l.finished, outcome: l.outcome || null,
    }])),
  });
}

function save(run) {
  try {
    const tmp = file(run.id) + '.tmp';
    fs.writeFileSync(tmp, serialize(run));
    fs.renameSync(tmp, file(run.id)); // atomic on the same filesystem
  } catch (e) { console.error('[store] save', run.id, e.message); }
}

function remove(id) {
  try { fs.existsSync(file(id)) && fs.unlinkSync(file(id)); } catch {}
}

// load every persisted run as a plain object (caller rehydrates runtime fields)
function all() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => /^run-.*\.json$/.test(f)); } catch {}
  for (const n of names) {
    try {
      const r = JSON.parse(fs.readFileSync(path.join(DIR, n), 'utf8'));
      if (r && r.id) out[r.id] = r;
    } catch (e) { console.error('[store] load', n, e.message); }
  }
  return out;
}

module.exports = { save, remove, all, DIR };
