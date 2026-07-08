// Audio engine: microphone or synthetic demo sources -> AudioWorklet
// capture -> ring buffer readable by the analysis loop.
//
// Microphone capture disables echoCancellation / noiseSuppression /
// autoGainControl so the signal is as close to the raw transducer as the
// platform allows (essential for measurement).

export const DEMO_SOURCES = [
  { id: 'demo-sine', label: 'Sine 440 Hz' },
  { id: 'demo-beats', label: 'Beats 440 + 444 Hz' },
  { id: 'demo-twotone', label: 'Two tones 440 + 2500 Hz' },
  { id: 'demo-sweep', label: 'Log sweep 100 Hz – 8 kHz' },
  { id: 'demo-white', label: 'White noise' },
  { id: 'demo-pink', label: 'Pink noise' },
  { id: 'demo-impulses', label: 'Impulse train 2 Hz' },
  { id: 'demo-tonenoise', label: 'Tone 1 kHz + noise' },
];

export class AudioEngine {
  /**
   * @param {string} workletUrl URL of capture-worklet.js relative to the page
   * @param {number} ringSeconds ring buffer length in seconds
   */
  constructor(workletUrl, ringSeconds = 12) {
    this.workletUrl = workletUrl;
    this.ringSeconds = ringSeconds;
    this.ctx = null;
    this.workletNode = null;
    this.sourceNodes = [];
    this.mediaStream = null;
    this.monitorGain = null;
    this.sweepTimer = null;
    this.ring = null;
    this.ringPos = 0;
    this.totalSamples = 0;
    this.running = false;
    this.currentSourceId = null;
    this.onOverload = null; // callback(clipped: boolean)
  }

  get sampleRate() {
    return this.ctx ? this.ctx.sampleRate : 48000;
  }

  async listInputDevices() {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'audioinput');
  }

  async #ensureContext() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive',
      });
      await this.ctx.audioWorklet.addModule(this.workletUrl);
      let cap = 1;
      while (cap < this.ctx.sampleRate * this.ringSeconds) cap <<= 1;
      this.ring = new Float32Array(cap);
      this.workletNode = new AudioWorkletNode(this.ctx, 'capture-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      this.workletNode.port.onmessage = (e) => this.#append(e.data);
      // Keep the graph pulled; monitor gain lets demo signals be heard on demand
      this.monitorGain = this.ctx.createGain();
      this.monitorGain.gain.value = 0;
      this.workletNode.connect(this.monitorGain).connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      // Don't block on resume(): without user activation (e.g. automated
      // testing) it may never resolve; audio simply starts when it does.
      const p = this.ctx.resume();
      await Promise.race([p, new Promise((res) => setTimeout(res, 400))]);
    }
  }

  #append(block) {
    const ring = this.ring;
    const mask = ring.length - 1;
    let clipped = false;
    for (let i = 0; i < block.length; i++) {
      const v = block[i];
      ring[(this.ringPos + i) & mask] = v;
      if (v > 0.99 || v < -0.99) clipped = true;
    }
    this.ringPos = (this.ringPos + block.length) & mask;
    this.totalSamples += block.length;
    if (clipped && this.onOverload) this.onOverload(true);
  }

  /**
   * Copy the newest n samples into out (oldest first).
   * Returns false if not enough samples have been captured yet.
   */
  read(n, out) {
    if (this.totalSamples < n || n > this.ring.length) return false;
    const ring = this.ring;
    const mask = ring.length - 1;
    let idx = (this.ringPos - n) & mask;
    for (let i = 0; i < n; i++) {
      out[i] = ring[idx];
      idx = (idx + 1) & mask;
    }
    return true;
  }

  /** Set monitor volume (0..1) for hearing demo signals through speakers. */
  setMonitor(level) {
    if (this.monitorGain) {
      this.monitorGain.gain.setTargetAtTime(level, this.ctx.currentTime, 0.02);
    }
  }

  #disconnectSources() {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const node of this.sourceNodes) {
      try { node.stop?.(); } catch { /* already stopped */ }
      try { node.disconnect(); } catch { /* not connected */ }
    }
    this.sourceNodes = [];
    if (this.mediaStream) {
      for (const t of this.mediaStream.getTracks()) t.stop();
      this.mediaStream = null;
    }
  }

  /**
   * Start capturing from a microphone device or a demo source.
   * @param {string} sourceId 'mic' | mic deviceId | one of DEMO_SOURCES ids
   */
  async start(sourceId = 'mic') {
    await this.#ensureContext();
    this.#disconnectSources();
    this.totalSamples = 0;

    if (sourceId.startsWith('demo-')) {
      this.#startDemo(sourceId);
    } else {
      const constraints = {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      };
      if (sourceId !== 'mic') constraints.deviceId = { exact: sourceId };
      this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      const src = this.ctx.createMediaStreamSource(this.mediaStream);
      src.connect(this.workletNode);
      this.sourceNodes.push(src);
    }
    this.currentSourceId = sourceId;
    this.running = true;
  }

  async pause() {
    if (this.ctx && this.ctx.state === 'running') await this.ctx.suspend();
    this.running = false;
  }

  async resume() {
    if (this.ctx && this.ctx.state === 'suspended') await this.ctx.resume();
    this.running = this.currentSourceId !== null;
  }

  stop() {
    this.#disconnectSources();
    this.running = false;
    this.currentSourceId = null;
  }

  #osc(freq, gainValue, type = 'sine') {
    const osc = this.ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    osc.connect(g).connect(this.workletNode);
    osc.start();
    this.sourceNodes.push(osc, g);
    return osc;
  }

  #noiseBuffer(seconds, pink = false) {
    const n = Math.floor(this.ctx.sampleRate * seconds);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const data = buf.getChannelData(0);
    if (!pink) {
      for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    } else {
      // Paul Kellet's pink noise approximation
      let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
      for (let i = 0; i < n; i++) {
        const white = Math.random() * 2 - 1;
        b0 = 0.99886 * b0 + white * 0.0555179;
        b1 = 0.99332 * b1 + white * 0.0750759;
        b2 = 0.969 * b2 + white * 0.153852;
        b3 = 0.8665 * b3 + white * 0.3104856;
        b4 = 0.55 * b4 + white * 0.5329522;
        b5 = -0.7616 * b5 - white * 0.016898;
        data[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + white * 0.5362) * 0.11;
        b6 = white * 0.115926;
      }
    }
    return buf;
  }

  #bufferSource(buf, gainValue) {
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    const g = this.ctx.createGain();
    g.gain.value = gainValue;
    src.connect(g).connect(this.workletNode);
    src.start();
    this.sourceNodes.push(src, g);
    return src;
  }

  #startDemo(id) {
    switch (id) {
      case 'demo-sine':
        this.#osc(440, 0.5);
        break;
      case 'demo-beats':
        this.#osc(440, 0.25);
        this.#osc(444, 0.25);
        break;
      case 'demo-twotone':
        this.#osc(440, 0.35);
        this.#osc(2500, 0.12);
        break;
      case 'demo-sweep': {
        const osc = this.#osc(100, 0.4);
        const period = 10;
        const schedule = () => {
          const t = this.ctx.currentTime;
          osc.frequency.cancelScheduledValues(t);
          osc.frequency.setValueAtTime(100, t);
          osc.frequency.exponentialRampToValueAtTime(8000, t + period);
        };
        schedule();
        this.sweepTimer = setInterval(schedule, period * 1000);
        break;
      }
      case 'demo-white':
        this.#bufferSource(this.#noiseBuffer(4), 0.25);
        break;
      case 'demo-pink':
        this.#bufferSource(this.#noiseBuffer(4, true), 0.5);
        break;
      case 'demo-impulses': {
        const buf = this.ctx.createBuffer(1, this.ctx.sampleRate / 2, this.ctx.sampleRate);
        buf.getChannelData(0)[0] = 0.9;
        this.#bufferSource(buf, 1.0);
        break;
      }
      case 'demo-tonenoise':
        this.#osc(1000, 0.3);
        this.#bufferSource(this.#noiseBuffer(4), 0.02);
        break;
      default:
        throw new Error(`Unknown demo source: ${id}`);
    }
  }
}
