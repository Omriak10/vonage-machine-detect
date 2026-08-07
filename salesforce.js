// Salesforce connector for Machine Detect.
//
// Auth: OAuth 2.0 Client Credentials flow (server-to-server, no user login).
//   The customer creates a Connected App with Client Credentials enabled and a
//   run-as user, then supplies SF_LOGIN_URL / SF_CLIENT_ID / SF_CLIENT_SECRET.
//
// Lists:   Campaigns are the call lists. Members (Leads or Contacts) supply the
//          phone numbers to dial and the WhoId used to log activity back.
// Logging: each outcome is written as a Task (Activity) on the member's record -
//          "machine detected" and "live conversation" are separate log types.
//
// Everything is CONFIG-DRIVEN and OPTIONAL. With no credentials set the module
// reports { configured:false } and the rest of the app runs unchanged.
const API = 'v60.0';

let cfg = {
  loginUrl: process.env.SF_LOGIN_URL || '',
  clientId: process.env.SF_CLIENT_ID || '',
  clientSecret: process.env.SF_CLIENT_SECRET || '',
};
let token = null;      // { accessToken, instanceUrl, exp }

const isConfigured = () => !!(cfg.loginUrl && cfg.clientId && cfg.clientSecret);

// set/replace credentials at runtime (UI "Connect" button); returns connection test
async function configure({ loginUrl, clientId, clientSecret }) {
  cfg = {
    loginUrl: (loginUrl || '').replace(/\/$/, ''),
    clientId: clientId || '',
    clientSecret: clientSecret || '',
  };
  token = null;
  return auth();
}

async function auth() {
  if (!isConfigured()) throw new Error('Salesforce is not configured');
  if (token && token.exp > Date.now() + 60000) return token;
  const r = await fetch(cfg.loginUrl + '/services/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  const d = await r.json();
  if (!d.access_token) throw new Error('SF auth failed: ' + (d.error_description || d.error || JSON.stringify(d)));
  token = { accessToken: d.access_token, instanceUrl: d.instance_url, exp: Date.now() + 25 * 60000 };
  return token;
}

async function sf(method, pathOrSoql, body) {
  const t = await auth();
  const url = pathOrSoql.startsWith('/')
    ? t.instanceUrl + pathOrSoql
    : t.instanceUrl + `/services/data/${API}/query?q=` + encodeURIComponent(pathOrSoql);
  const r = await fetch(url, {
    method,
    headers: { Authorization: 'Bearer ' + t.accessToken, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (r.status >= 300) throw new Error('SF ' + r.status + ': ' + JSON.stringify(data).slice(0, 300));
  return data;
}

async function status() {
  const out = { configured: isConfigured(), connected: false, instanceUrl: null };
  if (!out.configured) return out;
  try { const t = await auth(); out.connected = true; out.instanceUrl = t.instanceUrl; }
  catch (e) { out.error = e.message; }
  return out;
}

// call lists = Campaigns
async function lists() {
  const d = await sf('GET', 'SELECT Id, Name, (SELECT Id FROM CampaignMembers) FROM Campaign WHERE IsActive = true ORDER BY CreatedDate DESC LIMIT 100');
  // count members per campaign in a second lightweight pass would be N calls;
  // instead report the subquery size where returned
  return d.records.map((c) => ({
    id: c.Id,
    name: c.Name,
    members: c.CampaignMembers ? c.CampaignMembers.totalSize : null,
  }));
}

// members of one campaign, with the best phone number and the WhoId to log to
async function members(campaignId) {
  const soql = "SELECT LeadId, Lead.Name, Lead.MobilePhone, Lead.Phone, "
    + "ContactId, Contact.Name, Contact.MobilePhone, Contact.Phone "
    + "FROM CampaignMember WHERE CampaignId = '" + campaignId.replace(/'/g, '') + "'";
  const d = await sf('GET', soql);
  const out = [];
  for (const m of d.records) {
    const isLead = !!m.LeadId;
    const src = (isLead ? m.Lead : m.Contact) || {};
    const phone = src.MobilePhone || src.Phone;
    if (!phone) continue;
    out.push({ whoId: isLead ? m.LeadId : m.ContactId, whoType: isLead ? 'Lead' : 'Contact', name: src.Name || '', number: phone });
  }
  return out;
}

// write a Task activity on the member's record
//   kind: 'machine' -> machine detected / message left
//         'live'    -> a live conversation happened
async function logActivity(whoId, kind, detail) {
  if (!isConfigured() || !whoId) return { skipped: true };
  const subject = kind === 'machine'
    ? 'Machine detect - answering machine, message left'
    : kind === 'live'
      ? 'Machine detect - live conversation'
      : 'Machine detect - call result';
  const task = {
    Subject: subject,
    Status: 'Completed',
    Priority: 'Normal',
    TaskSubtype: 'Call',
    WhoId: whoId,
    Description: detail || '',
    ActivityDate: new Date().toISOString().slice(0, 10),
  };
  const d = await sf('POST', `/services/data/${API}/sobjects/Task`, task);
  return { id: d.id };
}

module.exports = { isConfigured, configure, status, lists, members, logActivity };
