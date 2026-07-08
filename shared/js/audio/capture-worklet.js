// AudioWorklet processor: batches input samples and posts them to the main
// thread. Registered as 'capture-processor'. Mono: uses channel 0.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.batchSize = 2048; // ~23 messages/s at 48 kHz
    this.buffer = new Float32Array(this.batchSize);
    this.fill = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (input && input.length > 0) {
      const ch = input[0];
      let i = 0;
      while (i < ch.length) {
        const space = this.batchSize - this.fill;
        const take = Math.min(space, ch.length - i);
        this.buffer.set(ch.subarray(i, i + take), this.fill);
        this.fill += take;
        i += take;
        if (this.fill === this.batchSize) {
          // Transfer a copy; keep reusing our scratch buffer
          const out = this.buffer.slice();
          this.port.postMessage(out, [out.buffer]);
          this.fill = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor('capture-processor', CaptureProcessor);
