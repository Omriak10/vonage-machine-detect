<div align="center">

# ⌵ Vonage Machine Detect

**Call → Detect → Act.** Outbound calling with Vonage **Advanced Machine Detection** — transfer live answers to a colleague, drop a voicemail on every machine in a list, pull the list from **Salesforce**, log every outcome, and **listen to the far side live**.

</div>

---

## Why

When you dial a list, half the calls hit voicemail. Machine Detect uses Vonage AMD to tell a human from a machine on each call, and does the right thing automatically:

- **Human answers** → transfer to your team (or just log the live conversation).
- **Machine answers** → transfer, *or* leave your recorded voicemail and move straight to the next number.

## Features

- 🎯 **Three modes** — transfer on machine (immediate / after beep), or **voicemail drop** across a whole list.
- 📇 **Salesforce** — load call lists from Campaigns and log each result (machine / live conversation) back to the record.
- 🎙️ **Your message, your way** — a built-in automatic message, or **record** one in the browser, or **upload** any audio file.
- 🎧 **Live listen** — hear the greeting, the machine, the beep, in real time from the console.
- ⌨️ **API-first** — every capability is an HTTP endpoint; drive it from your own dialer or CRM.
- 🔒 **No secrets in the repo** — all config is environment-driven.

## Quick start

```bash
git clone https://github.com/2stars-io/vonage-machine-detect.git
cd vonage-machine-detect
npm install
cp .env.example .env         # fill in your Vonage app id, number, public URL
cp vcr.yml.example vcr.yml   # fill in the same for VCR
cp /path/to/private.key .    # your Vonage application private key
vcr deploy
```

Full walkthrough — Vonage app, VCR deploy, Salesforce Connected App, API usage, and **what Vonage charges for** (Advanced Machine Detection is a billable feature) — is in **[IMPLEMENTATION.md](IMPLEMENTATION.md)**.

> **Vonage can deploy and host this on your VCR account for you** — ask your Vonage team.

## Stack

Node.js · Express · Vonage Voice API (Advanced Machine Detection, WebSocket audio) · Salesforce REST · Vonage Cloud Runtime.

---

<div align="center"><sub>Built on the Vonage Voice API.</sub></div>
