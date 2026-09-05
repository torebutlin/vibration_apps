// Gate analysis frames on the audio sample clock instead of the display
// refresh, so "N averages" means N frames with a fixed overlap whatever the
// frame rate (60 Hz, 120 Hz, or a throttled phone).

export class FrameHopper {
  /** @param {number} hop samples between processed frames (N/2 = 50% overlap) */
  constructor(hop) {
    this.hop = hop;
    this.last = null; // sample count at the last processed frame
  }

  setHop(hop) {
    this.hop = hop;
  }

  reset() {
    this.last = null;
  }

  /**
   * @param {number} total samples captured so far
   * @returns {boolean} true if a new frame should be processed now
   */
  due(total) {
    if (this.last === null || total < this.last) {
      this.last = total;
      return true;
    }
    const n = Math.floor((total - this.last) / this.hop);
    if (n < 1) return false;
    this.last += n * this.hop;
    return true;
  }
}
