// DSP module - extracted from index.html. Functions exported without changes.

// WAV encoding (24-bit PCM, mono)
export function encodeWav24(float32Data, sampleRate) {
  const numChannels = 1;
  const bitsPerSample = 24;
  const blockAlign = numChannels * (bitsPerSample / 8);
  const byteRate = sampleRate * blockAlign;
  const dataBytes = float32Data.length * blockAlign; // 3 bytes per sample
  const buffer = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buffer);

  // RIFF header
  writeString(view, 0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeString(view, 8, 'WAVE');

  // fmt chunk
  writeString(view, 12, 'fmt ');
  view.setUint32(16, 16, true);           // Subchunk1Size
  view.setUint16(20, 1, true);            // AudioFormat = PCM
  view.setUint16(22, numChannels, true);  // NumChannels
  view.setUint32(24, sampleRate, true);   // SampleRate
  view.setUint32(28, byteRate, true);     // ByteRate
  view.setUint16(32, blockAlign, true);   // BlockAlign
  view.setUint16(34, bitsPerSample, true);// BitsPerSample

  // data chunk
  writeString(view, 36, 'data');
  view.setUint32(40, dataBytes, true);

  // PCM 24-bit little endian
  let offset = 44;
  for (let i = 0; i < float32Data.length; i++) {
    let s = Math.max(-1, Math.min(1, float32Data[i]));
    // Scale to signed 24-bit
    let int = s < 0 ? Math.round(s * 0x800000) : Math.round(s * 0x7FFFFF);
    // Write 3 bytes LE
    view.setUint8(offset + 0, int & 0xFF);
    view.setUint8(offset + 1, (int >> 8) & 0xFF);
    view.setUint8(offset + 2, (int >> 16) & 0xFF);
    offset += 3;
  }

  return new Blob([view], { type: 'audio/wav' });
}

export function writeString(dataview, offset, str) {
  for (let i = 0; i < str.length; i++) {
    dataview.setUint8(offset + i, str.charCodeAt(i));
  }
}

export function truncateAndWindowIR(irFull, irLength) {
  const N = Math.max(1, irLength | 0);
  const out = new Float32Array(N);
  const copyLen = Math.min(N, irFull.length);
  for (let i = 0; i < copyLen; i++) out[i] = irFull[i];
  const windowStart = Math.floor(N * 0.9);
  const windowLength = Math.max(1, N - windowStart);
  for (let i = windowStart; i < N; i++) {
    const t = (i - windowStart) / windowLength;
    out[i] *= Math.cos(t * Math.PI / 2);
  }
  return out;
}

export function hammingWindow(N) {
  const w = new Float32Array(N);
  const twoPiOverNMinus1 = Math.PI * 2 / (N - 1);
  for (let n = 0; n < N; n++) w[n] = 0.54 - 0.46 * Math.cos(twoPiOverNMinus1 * n);
  return w;
}

export function computeSpectrum(samples, sampleRate, fftSize) {
  if (!samples || samples.length === 0) return { freq: [], magDb: [] };
  const N = fftSize >>> 0;
  const hop = Math.max(1, Math.floor(N / 2)); // 50% overlap
  const window = hammingWindow(N);
  const numFrames = Math.max(1, Math.floor((samples.length - N) / hop) + 1);
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  const magAccum = new Float32Array(N >> 1);
  for (let frame = 0; frame < numFrames; frame++) {
    const start = frame * hop;
    for (let n = 0; n < N; n++) {
      const s = samples[start + n] || 0;
      re[n] = s * window[n];
      im[n] = 0;
    }
    fftRadix2(re, im);
    for (let k = 1; k < (N >> 1); k++) {
      const mr = re[k], mi = im[k];
      const mag = Math.hypot(mr, mi) / (N >> 1);
      magAccum[k] += mag;
    }
  }
  for (let k = 1; k < (N >> 1); k++) magAccum[k] /= numFrames;
  const len = N >> 1;
  const freq = new Float32Array(len);
  const magDb = new Float32Array(len);
  for (let k = 1; k < len; k++) {
    freq[k] = k * sampleRate / N;
    magDb[k] = 20 * Math.log10(magAccum[k] + 1e-12);
  }
  return { freq, magDb };
}

// In-place radix-2 Cooley–Tukey FFT (real/imag arrays), N must be power of two
export function fftRadix2(re, im) {
  const N = re.length;
  // bit reversal
  for (let i = 0, j = 0; i < N; i++) {
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti; }
    let m = N >>> 1;
    while (j >= m && m >= 2) { j -= m; m >>>= 1; }
    j += m;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >>> 1;
    const theta = -2 * Math.PI / size;
    const wpr = Math.cos(theta);
    const wpi = Math.sin(theta);
    for (let i = 0; i < N; i += size) {
      let wr = 1, wi = 0;
      for (let j = 0; j < half; j++) {
        const l = i + j;
        const r = l + half;
        const tr = wr * re[r] - wi * im[r];
        const ti = wr * im[r] + wi * re[r];
        re[r] = re[l] - tr;
        im[r] = im[l] - ti;
        re[l] += tr;
        im[l] += ti;
        const wnr = wr * wpr - wi * wpi;
        wi = wr * wpi + wi * wpr;
        wr = wnr;
      }
    }
  }
}

// IFFT via using FFT with conjugation and 1/N scaling
export function ifftRadix2(re, im) {
  const N = re.length;
  for (let i = 0; i < N; i++) im[i] = -im[i];
  fftRadix2(re, im);
  for (let i = 0; i < N; i++) { re[i] = re[i] / N; im[i] = -im[i] / N; }
}

// hilbert_from_scratch: compute analytic signal of u via standard FFT method
// Zero negative frequencies, double positive (except DC and Nyquist), then IFFT
export function hilbertFromScratch(u) {
  const N = u.length;
  const re = new Float32Array(N);
  const im = new Float32Array(N);
  for (let i = 0; i < N; i++) { re[i] = u[i]; im[i] = 0; }
  fftRadix2(re, im);
  const half = N >>> 1;
  // Zero out negative frequencies
  for (let i = half + 1; i < N; i++) { re[i] = 0; im[i] = 0; }
  // Double positive frequencies (1..N/2-1)
  for (let i = 1; i < half; i++) { re[i] *= 2; im[i] *= 2; }
  // IFFT
  ifftRadix2(re, im);
  return { re, im };
}

export function interpDbAt(freqHz, magDb, f) {
  if (!freqHz || !magDb || magDb.length !== freqHz.length) return -120;
  if (f <= freqHz[1]) return magDb[1];
  const last = freqHz.length - 1;
  if (f >= freqHz[last]) return magDb[last];
  // Binary search
  let lo = 1, hi = last;
  while (hi - lo > 1) {
    const mid = (hi + lo) >> 1;
    if (freqHz[mid] < f) lo = mid; else hi = mid;
  }
  const t = (f - freqHz[lo]) / Math.max(1e-12, (freqHz[hi] - freqHz[lo]));
  return magDb[lo] + t * (magDb[hi] - magDb[lo]);
}

export function nearestPow2(n) { let p = 1; while (p < n) p <<= 1; return p; }

// Build a minimum-phase impulse response from magnitude (in dB) using C++ minphase() logic
// 1) Create full-length log-magnitude vector (symmetric) on a uniform frequency grid
// 2) Compute Hilbert transform of log-mag via hilbert_from_scratch (FFT-domain zeroing/doubling)
// 3) Combine |H| with phase to form complex spectrum, enforce Hermitian symmetry
// 4) IFFT to time domain and normalize
export function buildMinimumPhaseIRFromMag(freqHz, magDb, sampleRate, spectrumFftSize) {
  const nyquist = sampleRate / 2;
  const N = nearestPow2(Math.max(1024, spectrumFftSize));
  const half = N >>> 1;
  // Interpolate to uniform bins (0..Nyquist), convert dB->linear
  const magLinHalf = new Float32Array(half + 1);
  for (let k = 0; k <= half; k++) {
    const f = (k / half) * nyquist;
    const db = interpDbAt(freqHz, magDb, f);
    const lin = Math.pow(10, db / 20);
    magLinHalf[k] = Math.max(1e-12, lin);
  }
  // Build full-length log magnitude (symmetric)
  const logMagFull = new Float32Array(N);
  for (let k = 0; k <= half; k++) logMagFull[k] = Math.log(magLinHalf[k]);
  for (let k = 1; k < half; k++) logMagFull[N - k] = logMagFull[k];
  // Patch DC and Nyquist if needed (avoid +/-inf per C++)
  if (!Number.isFinite(logMagFull[0])) logMagFull[0] = -10;
  if (!Number.isFinite(logMagFull[half])) logMagFull[half] = -10;

  // hilbert_from_scratch on logMagFull -> v (complex); min phase angle = -imag(v)
  const v = hilbertFromScratch(logMagFull);
  const minPhaseAngle = new Float32Array(half + 1);
  for (let k = 0; k <= half; k++) minPhaseAngle[k] = -v.im[k];

  // Construct complex spectrum from |H| and phase
  const Hr = new Float32Array(N);
  const Hi = new Float32Array(N);
  for (let k = 0; k <= half; k++) {
    const a = magLinHalf[k];
    Hr[k] = a * Math.cos(minPhaseAngle[k]);
    Hi[k] = a * Math.sin(minPhaseAngle[k]);
  }
  // Hermitian symmetry
  for (let k = 1; k < half; k++) {
    Hr[N - k] = Hr[k];
    Hi[N - k] = -Hi[k];
  }
  // IFFT to time-domain impulse
  ifftRadix2(Hr, Hi);
  const ir = new Float32Array(N);
  let maxAbs = 1e-12;
  for (let n = 0; n < N; n++) { ir[n] = Hr[n]; maxAbs = Math.max(maxAbs, Math.abs(ir[n])); }
  for (let n = 0; n < N; n++) ir[n] /= maxAbs;
  return ir;
}

// Apply smoothing based on provided C++ algorithm (translated to JS)
// getWindow(idx, smoothing): raised cosine window whose width grows ~ log2(1+idx) * smoothing
export function applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize) {
  const N = magDb.length;
  if (!N || smoothFactor <= 0) return magDb;
  const out = new Float32Array(N);
  const getWindow = (idx, smoothing) => {
    const width = Math.log2(1 + idx) * smoothing;
    if (width <= 1) return [1.0];
    const output = [1.0];
    for (let j = 1; j < 100; j++) {
      const dx = j * Math.PI / width;
      if (dx > Math.PI) break;
      const value = 0.5 * (1 + Math.cos(dx));
      output.push(value);
    }
    return output;
  };
  // Below f0, no smoothing. f0 depends on FFT size.
  // For 1024/2048/4096 → 50 Hz; 8192 → 30 Hz; 16384 → 25 Hz; 32768 → 20 Hz
  const f0Lookup = { 1024: 50, 2048: 50, 4096: 50, 8192: 30, 16384: 25, 32768: 20 };
  const f0 = f0Lookup[spectrumFftSize] ?? 50;
  const f1 = f0 + 30; // ramp width 30 Hz for a smooth transition
  const baseS = smoothFactor * 4; // per C++ DoSmooth(getWindow(i, smoothing*4))
  for (let i = 0; i < N; i++) {
    const f = freq && freq[i] != null ? freq[i] : 0;
    let sEff = 0;
    if (f <= f0) sEff = 0;
    else if (f >= f1) sEff = baseS;
    else {
      let t = (f - f0) / (f1 - f0);
      // smoothstep for seamless transition
      t = t * t * (3 - 2 * t);
      sEff = baseS * t;
    }
    if (sEff <= 0) { out[i] = magDb[i]; continue; }
    const win = getWindow(i, sEff);
    let sum = magDb[i];
    let weightSum = 1.0;
    for (let j = 1; j < win.length; j++) {
      const w = win[j];
      const idxLow = i - j;
      const idxHigh = i + j;
      if (idxLow >= 0) { sum += w * magDb[idxLow]; weightSum += w; }
      if (idxHigh < N) { sum += w * magDb[idxHigh]; weightSum += w; }
    }
    out[i] = sum / weightSum;
  }
  return out;
}


