Default announcement (baked into the container)
================================================

Put the default voicemail announcement here as:

    default-message.wav

Requirements:
- WAV, PCM 16-bit, mono, 16 kHz (Vonage `stream` plays this back verbatim).
- Keep it short (a few seconds to ~20s).

Because this file ships INSIDE the deploy artifact, it is always present after
any restart or redeploy - the app loads it as the default drop message on
startup, so the flow can never silently fall back to the built-in English TTS.

Precedence for the message played to a voicemail:
  1. a named message chosen for the run (messageId)
  2. a default uploaded at runtime via POST /api/message   (tmp - lost on redeploy)
  3. this bundled assets/default-message.wav               (survives redeploy)
  4. the TTS AUTO_MESSAGE (last resort; text + language set by the
     AUTO_MESSAGE / AUTO_MESSAGE_LANG env vars, not hardcoded English)

To change the bundled default: replace this file and redeploy
(`python build/zip` as applicable, then `vcr deploy`). Or point the
DEFAULT_MSG_PATH env var at another bundled file.
