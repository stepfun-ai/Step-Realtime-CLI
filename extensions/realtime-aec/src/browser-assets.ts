// Browser-side assets served to the headless Chrome helper.
//
// The page does the whole AEC job via libwebrtc APM (getUserMedia
// echoCancellation):
//   - capture: getUserMedia → AudioWorklet → 24k mono int16 → WS → Node
//   - playback: WS PCM from Node → WebAudio → speaker (this is what makes the
//     echoCancellation work: the browser plays the far-end itself, so its APM
//     has an accurate render reference).
//
// PCM contract Node <-> browser: 24kHz, mono, signed 16-bit LE.

export const SAMPLE_RATE = 24000;

/** AudioWorklet that converts captured Float32 frames to Int16 and ships them
 *  to the main thread. Accumulates into ~40ms blocks (960 samples @ 24kHz)
 *  before posting: the WebAudio render quantum is only 128 samples (~5ms),
 *  which is too small for the downstream VAD (silero/avr-vad needs larger
 *  blocks to produce frame probabilities). */
const CAPTURE_WORKLET = `
const CAP_BLOCK = 960; // ~40ms @ 24kHz
class CapProc extends AudioWorkletProcessor {
  constructor() {
    super();
    this.acc = new Int16Array(CAP_BLOCK);
    this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) {
      for (let i = 0; i < ch.length; i++) {
        const s = Math.max(-1, Math.min(1, ch[i]));
        this.acc[this.pos++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.pos === CAP_BLOCK) {
          const out = this.acc;
          this.acc = new Int16Array(CAP_BLOCK);
          this.pos = 0;
          this.port.postMessage(out, [out.buffer]);
        }
      }
    }
    return true;
  }
}
registerProcessor("cap-proc", CapProc);
`;

/** AudioWorklet that plays Int16 PCM pushed from the main thread by pulling
 *  from an internal ring of queued frames. Keeps a small jitter buffer. */
const PLAYBACK_WORKLET = `
class PlayProc extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];      // Array<Float32Array>
    this.cur = null;
    this.curPos = 0;
    this.port.onmessage = (e) => {
      const msg = e.data;
      if (msg && msg.flush) {
        // barge-in: drop all queued + in-progress playback immediately
        this.queue = [];
        this.cur = null;
        this.curPos = 0;
        return;
      }
      const i16 = msg; // Int16Array
      const f = new Float32Array(i16.length);
      for (let i = 0; i < i16.length; i++) f[i] = i16[i] / 0x8000;
      this.queue.push(f);
      // Backlog safety ceiling ONLY. The realtime backend delivers a whole
      // response's audio in a fast burst (far quicker than real-time playback),
      // so the queue legitimately holds many seconds of not-yet-played speech.
      // Dropping from the FRONT here discards audio that WILL be played → it
      // swallows words mid-response ("吞字"): a long reply whose spoken audio
      // exceeds this ceiling gets chopped. The 1s cap did it audibly; 30s still
      // clipped long coding explanations. Barge-in latency is handled by the
      // flush control message above, NOT by dropping frames, so this ceiling
      // exists only to bound memory against a runaway producer — set it well
      // beyond any real response (5min ≈ 29MB of Float32 @ 24kHz).
      const MAX_BACKLOG = ${SAMPLE_RATE} * 300; // ~5min; memory guard only
      let total = 0;
      for (const q of this.queue) total += q.length;
      while (total > MAX_BACKLOG && this.queue.length > 1) {
        total -= this.queue.shift().length;
      }
    };
  }
  process(_inputs, outputs) {
    const out = outputs[0][0];
    for (let i = 0; i < out.length; i++) {
      if (!this.cur || this.curPos >= this.cur.length) {
        this.cur = this.queue.shift() || null;
        this.curPos = 0;
      }
      out[i] = this.cur ? this.cur[this.curPos++] : 0;
    }
    return true;
  }
}
registerProcessor("play-proc", PlayProc);
`;

/** The page that wires capture + playback to a WebSocket on the given path.
 *  Binary WS messages: capture frames are sent Node-ward; the page treats
 *  incoming binary as playback PCM. JSON messages carry logs/control. */
export function buildPageHtml(): string {
  const cap = JSON.stringify(CAPTURE_WORKLET);
  const play = JSON.stringify(PLAYBACK_WORKLET);
  return `<!doctype html><meta charset="utf-8"><title>step-aec</title><body>step-aec helper<script>
(async () => {
  const ws = new WebSocket("ws://127.0.0.1:" + location.port + "/aec");
  ws.binaryType = "arraybuffer";
  const log = (m) => { try { ws.send(JSON.stringify({ log: String(m) })); } catch {} };
  await new Promise((r) => (ws.onopen = r));
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true,
               channelCount: 1, sampleRate: ${SAMPLE_RATE} },
    });
  } catch (e) { log("getUserMedia FAILED: " + e); return; }
  const ac = new AudioContext({ sampleRate: ${SAMPLE_RATE} });
  await ac.audioWorklet.addModule("data:text/javascript," + encodeURIComponent(${cap}));
  await ac.audioWorklet.addModule("data:text/javascript," + encodeURIComponent(${play}));

  // Capture: mic -> worklet -> WS (binary)
  const src = ac.createMediaStreamSource(stream);
  const capNode = new AudioWorkletNode(ac, "cap-proc");
  capNode.port.onmessage = (e) => { if (ws.readyState === 1) ws.send(e.data); };
  src.connect(capNode);

  // Playback: WS (binary) -> worklet -> speaker (far-end reference for AEC)
  const playNode = new AudioWorkletNode(ac, "play-proc");
  playNode.connect(ac.destination);
  ws.onmessage = (ev) => {
    if (typeof ev.data === "string") {
      // control message (JSON), e.g. {control:"flush"} on barge-in
      try {
        const o = JSON.parse(ev.data);
        if (o.control === "flush") playNode.port.postMessage({ flush: true });
      } catch {}
      return;
    }
    const i16 = new Int16Array(ev.data);
    playNode.port.postMessage(i16, [i16.buffer]);
  };

  const tr = stream.getAudioTracks()[0];
  log("aec ready @ " + ac.sampleRate + "Hz; ec=" + tr.getSettings().echoCancellation);
})();
</script></body>`;
}
