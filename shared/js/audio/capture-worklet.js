// AudioWorklet processor: batches input samples and posts them to the main
// thread. Registered as 'capture-processor'. Mono: uses channel 0.

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 1024 samples = 8 render quanta, ~47 messages/s at 48 kHz. This sets
    // the pace of every view: the sample count only advances when a batch
    // lands, so a larger batch caps the display no matter how short the
    // analysis frame is.
    this.batchSize = 1024;
    this.buffer = new Float32Array(this.batchSize);
    this.fill = 0;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    // pass the signal through so the monitor gain (demo "Listen") has audio
    if (input && input.length > 0 && outputs[0] && outputs[0].length > 0) {
      outputs[0][0].set(input[0]);
    }
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
