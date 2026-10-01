# Build assets/comfort.wav - a quiet, seamless-looping "open line" room tone.
# Deliberately low level (-42 dBFS peak): it should say "the line is live" without
# masking the person who just answered or giving AMD anything to chew on.
import math, os, random, struct, wave

RATE, SECONDS, PEAK = 16000, 2.0, 0.008   # 16 kHz mono PCM16, ~-42 dBFS
n = int(RATE * SECONDS)
random.seed(7)

# gentle filtered noise (one-pole low-pass) + a barely-there 50 Hz hum, both
# wrapped so the end of the buffer matches the start and the loop is seamless.
lp, samples = 0.0, []
for i in range(n):
    white = random.uniform(-1, 1)
    lp = lp * 0.96 + white * 0.04
    hum = math.sin(2 * math.pi * 50 * i / RATE) * 0.25
    samples.append(lp * 3.0 + hum)

# crossfade the last 10% over the start so looping has no click
fade = int(n * 0.1)
for i in range(fade):
    a = i / fade
    samples[i] = samples[i] * a + samples[n - fade + i] * (1 - a)
samples = samples[:n - fade]

peak = max(abs(s) for s in samples) or 1.0
scale = PEAK / peak
frames = b''.join(struct.pack('<h', int(max(-1, min(1, s * scale)) * 32767)) for s in samples)

out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'assets', 'comfort.wav')
os.makedirs(os.path.dirname(out), exist_ok=True)
with wave.open(out, 'wb') as w:
    w.setnchannels(1); w.setsampwidth(2); w.setframerate(RATE); w.writeframes(frames)
print('wrote', out, os.path.getsize(out), 'bytes,', round(len(samples) / RATE, 2), 'sec')

