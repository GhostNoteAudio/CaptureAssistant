// AudioWorklet processors for CaptureAssistant

class TestSignalProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = false;
    this.mode = 'sine'; // 'sine' | 'white' | 'pink'
    this.freq = 1000;
    this.phase = 0;
    this.twoPi = Math.PI * 2;
    // Pink noise state (Paul Kellet method)
    this.b0 = 0; this.b1 = 0; this.b2 = 0; this.b3 = 0; this.b4 = 0; this.b5 = 0; this.b6 = 0;
    this.port.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'config') {
        if (typeof m.enabled === 'boolean') this.enabled = m.enabled;
        if (m.mode) this.mode = m.mode;
        if (typeof m.freq === 'number') this.freq = m.freq;
      }
    };
  }
  process(_inputs, outputs, _params) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const ch0 = output[0];
    const len = ch0.length;
    if (!this.enabled) {
      for (let i = 0; i < len; i++) ch0[i] = 0;
      return true;
    }
    if (this.mode === 'sine') {
      const incr = this.twoPi * this.freq / sampleRate;
      for (let i = 0; i < len; i++) {
        ch0[i] = Math.sin(this.phase);
        this.phase += incr;
        if (this.phase > this.twoPi) this.phase -= this.twoPi;
      }
    } else if (this.mode === 'white') {
      for (let i = 0; i < len; i++) {
        ch0[i] = Math.random() * 2 - 1;
      }
    } else { // pink
      for (let i = 0; i < len; i++) {
        const white = Math.random() * 2 - 1;
        this.b0 = 0.99886 * this.b0 + white * 0.0555179;
        this.b1 = 0.99332 * this.b1 + white * 0.0750759;
        this.b2 = 0.96900 * this.b2 + white * 0.1538520;
        this.b3 = 0.86650 * this.b3 + white * 0.3104856;
        this.b4 = 0.55000 * this.b4 + white * 0.5329522;
        this.b5 = -0.7616 * this.b5 - white * 0.0168980;
        this.b6 = white * 0.115926;
        let pink = this.b0 + this.b1 + this.b2 + this.b3 + this.b4 + this.b5 + this.b6 + white * 0.5362;
        pink *= 0.11; // normalize roughly to [-1,1]
        // simple clamp
        if (pink > 1) pink = 1; else if (pink < -1) pink = -1;
        ch0[i] = pink;
      }
    }
    return true;
  }
}
registerProcessor('test-signal-processor', TestSignalProcessor);

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (ev) => {
      const m = ev.data || {};
      if (m.type === 'set-recording') {
        this.recording = !!m.enabled;
      }
    };
  }
  process(inputs, _outputs, _params) {
    const input = inputs[0];
    if (!input || input.length === 0) return true;
    const ch0 = input[0];
    const frames = ch0.length;
    // Downmix to mono if multiple channels
    let mono;
    if (input.length === 1) {
      mono = ch0;
    } else {
      mono = new Float32Array(frames);
      for (let c = 0; c < input.length; c++) {
        const ch = input[c];
        for (let i = 0; i < frames; i++) mono[i] += ch[i];
      }
      const inv = 1 / input.length;
      for (let i = 0; i < frames; i++) mono[i] *= inv;
    }
    if (this.recording) {
      // Transferable ArrayBuffer to avoid copying on main thread
      const copy = new Float32Array(mono.length);
      copy.set(mono);
      this.port.postMessage({ type: 'data', buffer: copy.buffer }, [copy.buffer]);
    }
    return true;
  }
}
registerProcessor('recorder-processor', RecorderProcessor);


