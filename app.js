import { encodeWav24, nearestPow2, hammingWindow, fftRadix2, ifftRadix2, computeSpectrum, hilbertFromScratch, interpDbAt, buildMinimumPhaseIRFromMag, applyFrequencySmoothing, truncateAndWindowIR } from './dsp.js';
// Utility: UI helpers
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

// Core state
let audioContext = null;
let requestedSampleRate = 48000;
let masterGain = null;
let outputDest = null;           // MediaStreamDestination
let outputAudioEl = null;         // <audio> that plays outputDest
let generatorNode = null;         // AudioWorkletNode producing test signals
let recorderNode = null;          // AudioWorkletNode capturing input
let inputStream = null;           // MediaStream for selected input
let inputSourceNode = null;       // MediaStreamAudioSourceNode from inputStream
let initialized = false;
let isPlayingTest = false;
let directOutConnected = false;   // whether masterGain is connected to destination
let isRecording = false;
let recordingTimer = null;
let startCaptureTimer = null;
let recordTargetSamples = 0;
let recordWriteIndex = 0;
let recordBuffer = null;          // Float32Array pre-allocated for 5s
const FILENAME_STORE_KEY = 'ca-filename-columns-v1';
let filenameColumns = [[], [], []]; // entries per column
let filenameColumnNames = ['Column 1', 'Column 2', 'Column 3'];
let selectedIndices = [null, null, null]; // selected index per column (or null)
// Spectrum state
let spectrumSamples = null; // Float32 samples of last recording
let spectrumFftSize = 4096;
let viewXMin = 20;      // Hz
let viewXMax = 24000;   // Hz
let viewYMin = -120;    // dB
let viewYMax = 0;       // dB
let isPanning = false;
let panStart = null;
let showImpulse = false; // false = spectrum view, true = impulse response view
let specBackup = { xMin: 20, xMax: 24000, yMin: -120, yMax: 0 };
let impLastLength = 0;
// Meter state
let meterAnalyser = null;
let meterTimeData = null;
let meterRafHandle = 0;

// Capability checks
const canSelectOutput = () => typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
// Cache of input device info by id for validation and heuristics
let inputDeviceInfoById = {};

// Initialization
async function initAudioIfNeeded() {
  if (initialized) return;
  const opts = {};
  if (requestedSampleRate) opts.sampleRate = requestedSampleRate;
  audioContext = new (window.AudioContext || window.webkitAudioContext)(opts);
  // Load worklets
  await audioContext.audioWorklet.addModule('./worklets.js');

  // Output path: generator -> masterGain -> MediaStreamDestination -> <audio>
  masterGain = audioContext.createGain();
  masterGain.gain.value = parseFloat($('#volume').value);
  outputDest = audioContext.createMediaStreamDestination();
  masterGain.connect(outputDest);

  // Create generator node (mono output)
  generatorNode = new AudioWorkletNode(audioContext, 'test-signal-processor', { outputChannelCount: [1] });
  generatorNode.connect(masterGain);

  // Create recorder node (input only, no outputs)
  recorderNode = new AudioWorkletNode(audioContext, 'recorder-processor', { numberOfInputs: 1, numberOfOutputs: 0 });
  recorderNode.port.onmessage = onRecorderMessage;

  // Audio element for routing to selected output device
  outputAudioEl = document.createElement('audio');
  outputAudioEl.autoplay = true;
  outputAudioEl.playsInline = true;
  outputAudioEl.muted = false;
  outputAudioEl.srcObject = outputDest.stream;
  outputAudioEl.style.display = 'none';
  document.body.appendChild(outputAudioEl);

  // Try to start audio (user gesture usually needed when clicking buttons)
  try { await outputAudioEl.play(); } catch (e) { /* ignore */ }

  initialized = true;
}

// Device management
async function ensureDeviceAccess() {
  try {
    // Request mic once to reveal device labels
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch (err) {
    setStatus(`Microphone permission denied or unavailable. ${err?.message || ''}`);
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices.filter(d => d.kind === 'audioinput').sort((a,b)=> (a.label||'').localeCompare(b.label||''));
  const outputs = devices.filter(d => d.kind === 'audiooutput').sort((a,b)=> (a.label||'').localeCompare(b.label||''));
  const inputSel = $('#inputDevice');
  const outputSel = $('#outputDevice');

  // Remember selections
  const prevIn = inputSel.value || localStorage.getItem('ca-selected-input') || '';
  const prevOut = outputSel.value || localStorage.getItem('ca-selected-output') || '';

  // Populate input devices
  inputSel.innerHTML = '';
  inputDeviceInfoById = {};
  for (const d of inputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Input ${inputSel.length + 1}`;
    inputSel.appendChild(opt);
    inputDeviceInfoById[d.deviceId] = d;
  }
  if (inputs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No input devices found';
    inputSel.appendChild(opt);
  }

  // Populate output devices
  outputSel.innerHTML = '';
  for (const d of outputs) {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `Output ${outputSel.length + 1}`;
    outputSel.appendChild(opt);
  }
  if (outputs.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Default system output';
    outputSel.appendChild(opt);
  }

  // Restore if possible
  if ([...inputSel.options].some(o => o.value === prevIn)) inputSel.value = prevIn;
  if ([...outputSel.options].some(o => o.value === prevOut)) outputSel.value = prevOut;

  // Apply sink to current audio element
  await applyOutputSink();
}

async function applyOutputSink() {
  if (!outputAudioEl) return;
  const outId = $('#outputDevice').value;
  if (canSelectOutput() && outId) {
    try { await outputAudioEl.setSinkId(outId); }
    catch (e) { setStatus(`Cannot set output device: ${e?.message || e}`); }
  }
  updateOutputRouting();
}

// Input stream setup
async function startInput(deviceId) {
  stopInput();
  // Request the selected device with minimal constraints
  const constraints = {
    audio: {
      deviceId: deviceId ? { exact: deviceId } : undefined,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
  };
  try {
    inputStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    setStatus(`Failed to access input device: ${err?.message || err}`);
    return;
  }
  inputSourceNode = audioContext.createMediaStreamSource(inputStream);

  // Real-time peak meter: create analyser inline and branch from it
  const inlineAnalyser = setupInputMeter(inputSourceNode);
  const meterSource = inlineAnalyser || inputSourceNode;

  // Ensure processing is running for metering
  try { await audioContext.resume(); } catch {}

  // Inspect channel count and route to mono based on selection
  const chanSelect = document.getElementById('inputChannel');
  const chanMode = chanSelect ? chanSelect.value : 'auto';
  const track = inputStream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  const channels = settings.channelCount || inputSourceNode.channelCount || 1;

  // Show/hide channel selector
  if (chanSelect && chanSelect.parentElement) {
    chanSelect.parentElement.style.display = channels > 1 ? '' : 'none';
  }

  if (channels > 1) {
    const splitter = audioContext.createChannelSplitter(Math.max(2, channels));
    meterSource.connect(splitter);
    if (chanMode === 'left') {
      const gain = audioContext.createGain();
      splitter.connect(gain, 0);
      gain.connect(recorderNode);
    } else if (chanMode === 'right') {
      const gain = audioContext.createGain();
      splitter.connect(gain, 1);
      gain.connect(recorderNode);
    } else {
      // Auto (Sum L+R to mono)
      const gainL = audioContext.createGain();
      const gainR = audioContext.createGain();
      gainL.gain.value = 0.5;
      gainR.gain.value = 0.5;
      splitter.connect(gainL, 0);
      splitter.connect(gainR, 1);
      const sum = audioContext.createGain();
      gainL.connect(sum);
      gainR.connect(sum);
      sum.connect(recorderNode);
    }
  } else {
    // Mono input, connect directly
    meterSource.connect(recorderNode);
  }

  try {
    const label = track?.label || 'Unknown input device';
    setStatus(`Input device in use: ${label}`);
  } catch {}
}

function setupInputMeter(sourceNode) {
  try {
    // Reuse a single analyser across re-inits
    if (meterAnalyser) {
      try { sourceNode.disconnect(meterAnalyser); } catch {}
    }
    meterAnalyser = audioContext.createAnalyser();
    meterAnalyser.fftSize = 2048;
    meterAnalyser.smoothingTimeConstant = 0.0;
    meterAnalyser.minDecibels = -120;
    meterAnalyser.maxDecibels = 0;
    meterTimeData = new Float32Array(meterAnalyser.fftSize);
    // Tap the source for metering; do not interrupt main routing
    sourceNode.connect(meterAnalyser);
    const fillEl = document.getElementById('meterFill');
    const labelEl = document.getElementById('meterLabel');
    if (meterRafHandle) cancelAnimationFrame(meterRafHandle);
    function raf() {
      try {
        meterAnalyser.getFloatTimeDomainData(meterTimeData);
        let peak = 0;
        for (let i = 0; i < meterTimeData.length; i++) {
          const v = Math.abs(meterTimeData[i]);
          if (v > peak) peak = v;
        }
        const db = peak > 0 ? 20 * Math.log10(peak) : -120;
        const norm = Math.max(0, Math.min(1, peak));
        if (fillEl) {
          fillEl.style.width = `${(norm * 100).toFixed(1)}%`;
          // Color zones
          let color = '#22c55e';
          if (peak > 0.7) color = '#ef4444'; else if (peak > 0.25) color = '#eab308';
          fillEl.style.backgroundColor = color;
        }
        if (labelEl) labelEl.textContent = isFinite(db) ? `${db.toFixed(1)} dB` : '-∞ dB';
      } catch {}
      meterRafHandle = requestAnimationFrame(raf);
    }
    meterRafHandle = requestAnimationFrame(raf);
    return meterAnalyser;
  } catch {
    return null;
  }
}

function stopInput() {
  try { if (inputSourceNode) inputSourceNode.disconnect(); } catch {}
  inputSourceNode = null;
  if (inputStream) {
    inputStream.getTracks().forEach(t => t.stop());
    inputStream = null;
  }
}

// Generator control
async function configureGenerator() {
  const mode = $('#signalType').value; // 'sine' | 'white' | 'pink'
  const freq = 1000; // fixed per requirements
  generatorNode.port.postMessage({ type: 'config', mode, freq, enabled: isPlayingTest });
  masterGain.gain.value = parseFloat($('#volume').value);
  await applyOutputSink();
}

function setGeneratorPlaying(on) {
  isPlayingTest = !!on;
  generatorNode.port.postMessage({ type: 'config', enabled: isPlayingTest });
  updateOutputRouting();
  updatePlayButtonLabel();
}

// Recorder messaging
function onRecorderMessage(ev) {
  const m = ev.data || {};
  if (m.type === 'data' && recordBuffer) {
    const chunk = new Float32Array(m.buffer);
    const remaining = recordTargetSamples - recordWriteIndex;
    if (remaining <= 0) return;
    const toCopy = Math.min(remaining, chunk.length);
    recordBuffer.set(chunk.subarray(0, toCopy), recordWriteIndex);
    recordWriteIndex += toCopy;
    if (recordWriteIndex >= recordTargetSamples) {
      // we reached target length; stop now
      stopRecordingFlow();
    }
  }
}

function startRecordingFlow() {
  if (isRecording) return;
  if (!initialized) {
    // Should not happen since record button initializes, but guard anyway
    setStatus('Audio not initialized.');
    return;
  }
  const sr = audioContext.sampleRate;
  recordTargetSamples = Math.round(sr * 5);
  recordBuffer = new Float32Array(recordTargetSamples);
  recordWriteIndex = 0;
  isRecording = true;
  $('#recordBtn').disabled = true;
  setStatus('Starting test signal...');

  // Start test signal immediately
  setGeneratorPlaying(true);
  configureGenerator();

  // Start capture after 0.5 seconds
  startCaptureTimer = setTimeout(() => {
    recorderNode.port.postMessage({ type: 'set-recording', enabled: true });
    setStatus('Recording for 5 seconds...');
    // Also set a hard timeout in case we don't hit exact samples
    recordingTimer = setTimeout(() => stopRecordingFlow(), 5000 + 100 /* guard */);
  }, 500);
}

function stopRecordingFlow() {
  if (!isRecording) return;
  isRecording = false;
  try { recorderNode.port.postMessage({ type: 'set-recording', enabled: false }); } catch {}
  if (startCaptureTimer) { clearTimeout(startCaptureTimer); startCaptureTimer = null; }
  if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null; }

  // Stop test signal
  setGeneratorPlaying(false);

  // Finalize buffer length
  const finalSamples = Math.min(recordWriteIndex, recordTargetSamples);
  const finalBuf = finalSamples === recordTargetSamples ? recordBuffer : recordBuffer.slice(0, finalSamples);

  // Encode and download
  // No auto-save; keep samples for spectrum/IR only
  const wavBlob = encodeWav24(finalBuf, audioContext.sampleRate);
  spectrumSamples = finalBuf;
  drawSpectrum();
  // Auto-export spectrum and IR after capture completes
  try { exportSpectrumFile(); } catch {}
  try { exportImpulseResponse(); } catch {}

  $('#recordBtn').disabled = false;
  setStatus('Capture completed. Exported IR and Spectrum.');
  updatePlayButtonLabel();
}


function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function exportSpectrumFile() {
  if (!spectrumSamples || !audioContext) { setStatus('Nothing to export. Perform a capture first.'); return; }
  const sr = audioContext.sampleRate | 0;
  let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
  const smoothSlider = document.getElementById('smoothSize');
  const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
  if (smoothFactor > 0) magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize);
  // Convert dB to magnitude: y = 10^(x/20), and write each point on its own line with CRLF
  const header = String(sr);
  const lines = [header];
  for (let i = 0; i < magDb.length; i++) {
    const db = Number.isFinite(magDb[i]) ? magDb[i] : 0;
    const mag = Math.pow(10, db / 20);
    lines.push(mag.toFixed(8));
  }
  const content = lines.join("\r\n");
  const blob = new Blob([content], { type: 'text/plain' });
  const base = buildFilenameBase();
  const name = `${(base || 'IR')}.spectrum`;
  triggerDownload(blob, name);
  setStatus(`Exported spectrum: ${name}`);
}

function exportImpulseResponse() {
  if (!spectrumSamples || !audioContext) { setStatus('Nothing to export. Perform a capture first.'); return; }
  const sr = audioContext.sampleRate | 0;
  let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
  const smoothSlider = document.getElementById('smoothSize');
  const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
  if (smoothFactor > 0) magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize);
  const ir = buildMinimumPhaseIRFromMag(freq, magDb, sr, spectrumFftSize);
  const irLength = getSelectedIrLength();
  const truncated = truncateAndWindowIR(ir, irLength);
  // Normalize before export
  let maxAbs = 1e-12; for (let i = 0; i < irLength; i++) maxAbs = Math.max(maxAbs, Math.abs(truncated[i]));
  const norm = 1 / maxAbs; for (let i = 0; i < irLength; i++) truncated[i] *= norm;
  const blob = encodeWav24(truncated, sr);
  const base = buildFilenameBase();
  const name = `${(base || 'IR')}.wav`;
  triggerDownload(blob, name);
  setStatus(`Exported IR: ${name}`);
}

function getSelectedIrLength() {
  const irSizeOpts = [1024, 2048, 4096, 8192];
  const slider = document.getElementById('irSize');
  const idx = Math.max(0, Math.min(irSizeOpts.length - 1, parseInt(slider.value, 10)));
  return irSizeOpts[idx];
}


function setStatus(text) {
  $('#status').textContent = text || '';
}

// UI wiring
async function onInitDevicesClick() {
  await initAudioIfNeeded();
  await ensureDeviceAccess();
  await refreshDevices();
  setStatus('Devices initialized. Choose input/output, then press Record.');
}

async function onRecordClick() {
  await initAudioIfNeeded();
  // Ensure we have at least default input
  const inId = $('#inputDevice').value;
  if (!inputStream) await startInput(inId);
  // Ensure sink
  await applyOutputSink();
  // Resume context to be safe
  try { await audioContext.resume(); } catch {}
  // Ensure the hidden audio element is actually playing (user gesture context)
  try { await outputAudioEl.play(); } catch {}
  startRecordingFlow();
}

async function onPlayToggleClick() {
  await initAudioIfNeeded();
  const newState = !isPlayingTest;
  setGeneratorPlaying(newState);
  await configureGenerator();
  // Ensure audio context and HTMLMediaElement are playing under user gesture
  try { await audioContext.resume(); } catch {}
  try { await outputAudioEl.play(); } catch {}
  updatePlayButtonLabel();
  setStatus(newState ? 'Playing test signal...' : '');
}

function bindUI() {
  $('#initBtn').addEventListener('click', onInitDevicesClick);
  $('#recordBtn').addEventListener('click', onRecordClick);
  $('#playBtn').addEventListener('click', onPlayToggleClick);
  $('#signalType').addEventListener('change', configureGenerator);
  $('#volume').addEventListener('input', () => {
    if (masterGain) masterGain.gain.value = parseFloat($('#volume').value);
    try { localStorage.setItem('ca-volume', String($('#volume').value)); } catch {}
  });
  $('#inputDevice').addEventListener('change', async (e) => { await initAudioIfNeeded(); localStorage.setItem('ca-selected-input', e.target.value || ''); await startInput(e.target.value); });
  const chanSelEl = document.getElementById('inputChannel');
  if (chanSelEl) {
    chanSelEl.addEventListener('change', async () => {
      await initAudioIfNeeded();
      const currentId = document.getElementById('inputDevice')?.value || '';
      await startInput(currentId);
    });
  }
  $('#sampleRateSel').addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10) || 48000;
    requestedSampleRate = val;
    localStorage.setItem('ca-sr', String(val));
    // Recreate audio graph with new context at next init
    if (audioContext) {
      try { await audioContext.close(); } catch {}
      initialized = false;
      audioContext = null; masterGain = null; outputDest = null; generatorNode = null; recorderNode = null; outputAudioEl = null;
    }
    await initAudioIfNeeded();
    await refreshDevices();
    await applyOutputSink();
    setStatus(`Sample rate set to ${val} Hz.`);
  });
  $('#outputDevice').addEventListener('change', async (e) => { await initAudioIfNeeded(); localStorage.setItem('ca-selected-output', e.target.value || ''); await applyOutputSink(); });
  if (navigator.mediaDevices) navigator.mediaDevices.addEventListener('devicechange', refreshDevices);

  // Filename builder events
  for (let c = 0; c < 3; c++) {
    const addBtn = document.getElementById(`btnAdd${c}`);
    const addInput = document.getElementById(`add${c}`);
    addBtn.addEventListener('click', () => addEntry(c));
    addInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addEntry(c); } });
    // Column name editing events (persist, prevent newlines)
    const nameEl = document.getElementById(`colName${c}`);
    if (nameEl) {
      const commit = () => {
        const txt = (nameEl.textContent || '').replace(/\n+/g, ' ').trim() || `Column ${c+1}`;
        filenameColumnNames[c] = txt;
        nameEl.textContent = txt;
        saveFilenameColumns();
      };
      nameEl.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); nameEl.blur(); }
      });
      nameEl.addEventListener('paste', (e) => {
        e.preventDefault();
        const text = (e.clipboardData?.getData('text') || '').replace(/\n+/g, ' ');
        document.execCommand('insertText', false, text);
      });
      nameEl.addEventListener('blur', commit);
    }
  }

  // Spectrum events
  const fftSlider = document.getElementById('fftSize');
  const fftLabel = document.getElementById('fftLabel');
  const fftOptions = [1024, 2048, 4096, 8192, 16384, 32768];
  // restore saved fft index if present
  try {
    const savedFftIdx = parseInt(localStorage.getItem('ca-fft-index') || '', 10);
    if (!Number.isNaN(savedFftIdx) && savedFftIdx >= 0 && savedFftIdx < fftOptions.length) {
      fftSlider.value = String(savedFftIdx);
    }
  } catch {}
  fftLabel.textContent = String(fftOptions[parseInt(fftSlider.value, 10)]);
  spectrumFftSize = fftOptions[parseInt(fftSlider.value, 10)];
  fftSlider.addEventListener('input', () => {
    const idx = Math.max(0, Math.min(fftOptions.length - 1, parseInt(fftSlider.value, 10) || 0));
    spectrumFftSize = fftOptions[idx];
    fftLabel.textContent = String(spectrumFftSize);
    drawSpectrum();
    try { localStorage.setItem('ca-fft-index', String(idx)); } catch {}
  });
  const smoothSlider = document.getElementById('smoothSize');
  const smoothLabel = document.getElementById('smoothLabel');
  try {
    const savedSmooth = parseInt(localStorage.getItem('ca-smooth') || '', 10);
    if (!Number.isNaN(savedSmooth) && savedSmooth >= parseInt(smoothSlider.min, 10) && savedSmooth <= parseInt(smoothSlider.max, 10)) {
      smoothSlider.value = String(savedSmooth);
    }
  } catch {}
  smoothLabel.textContent = String(smoothSlider.value);
  smoothSlider.addEventListener('input', () => {
    smoothLabel.textContent = String(smoothSlider.value);
    drawSpectrum();
    try { localStorage.setItem('ca-smooth', String(smoothSlider.value)); } catch {}
  });
  const irSizeSlider = document.getElementById('irSize');
  const irSizeLabel = document.getElementById('irSizeLabel');
  const irSizeOpts = [1024, 2048, 4096, 8192];
  try {
    const savedIrIdx = parseInt(localStorage.getItem('ca-ir-index') || '', 10);
    if (!Number.isNaN(savedIrIdx) && savedIrIdx >= 0 && savedIrIdx < irSizeOpts.length) {
      irSizeSlider.value = String(savedIrIdx);
    }
  } catch {}
  irSizeLabel.textContent = String(irSizeOpts[parseInt(irSizeSlider.value, 10)]);
  irSizeSlider.addEventListener('input', () => {
    const idx = Math.max(0, Math.min(irSizeOpts.length - 1, parseInt(irSizeSlider.value, 10) || 0));
    irSizeLabel.textContent = String(irSizeOpts[idx]);
    drawSpectrum();
    try { localStorage.setItem('ca-ir-index', String(idx)); } catch {}
  });
  irSizeSlider.addEventListener('change', () => { drawSpectrum(); });
  // Restore saved volume last, so initAudio can pick it up
  try {
    const savedVol = localStorage.getItem('ca-volume');
    if (savedVol != null) {
      const volEl = document.getElementById('volume');
      volEl.value = String(savedVol);
      if (masterGain) masterGain.gain.value = parseFloat(volEl.value);
    }
  } catch {}
  document.getElementById('resetView').addEventListener('click', () => resetSpectrumView());
  document.getElementById('toggleView').addEventListener('click', () => {
    showImpulse = !showImpulse;
    document.getElementById('toggleView').textContent = showImpulse ? 'Show Spectrum' : 'Show Impulse';
    if (showImpulse) {
      // Switch to impulse-specific view ranges (time in samples on X, normalized amplitude on Y)
      specBackup = { xMin: viewXMin, xMax: viewXMax, yMin: viewYMin, yMax: viewYMax };
      viewXMin = 0; viewXMax = 1; // relative [0,1] across canvas width for impulse
      viewYMin = -1; viewYMax = 1;
    } else {
      // Restore spectrum view ranges
      viewXMin = specBackup.xMin; viewXMax = specBackup.xMax;
      viewYMin = specBackup.yMin; viewYMax = specBackup.yMax;
    }
    drawSpectrum();
  });
  document.getElementById('exportIR').addEventListener('click', () => exportImpulseResponse());
  document.getElementById('exportSpectrum').addEventListener('click', () => exportSpectrumFile());

  initSpectrumCanvasInteractions();
}

window.addEventListener('DOMContentLoaded', () => {
  bindUI();
  // Attempt to init devices proactively; if permission blocked, user can press Initialize
  (async () => {
    try {
      // restore requested sample rate
      const savedSr = parseInt(localStorage.getItem('ca-sr') || '48000', 10);
      if ([44100,48000,96000].includes(savedSr)) {
        requestedSampleRate = savedSr;
        const srSel = document.getElementById('sampleRateSel');
        if (srSel) srSel.value = String(savedSr);
      }
      await initAudioIfNeeded();
      await ensureDeviceAccess();
      await refreshDevices();
      setStatus('Ready.');
      updatePlayButtonLabel();
      // Load filename lists
      loadFilenameColumns();
      renderFilenameColumns();
      // Auto-start input if we have a saved selection
      const savedInput = localStorage.getItem('ca-selected-input') || document.getElementById('inputDevice')?.value || '';
      if (savedInput) {
        try { await startInput(savedInput); } catch {}
      }
    } catch {
      // Silent; user can click Initialize
    }
  })();
});

function updatePlayButtonLabel() {
  const btn = document.getElementById('playBtn');
  if (!btn) return;
  btn.textContent = isPlayingTest ? 'Stop Test Signal' : 'Play Test Signal';
}

// ===== Filename builder logic =====
function loadFilenameColumns() {
  try {
    const raw = localStorage.getItem(FILENAME_STORE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data && Array.isArray(data.columns) && data.columns.length === 3 && data.columns.every(col => Array.isArray(col))) {
      filenameColumns = data.columns.map(col => col.map(v => String(v)));
    } else if (Array.isArray(data) && data.length === 3) { // backward compatibility
      filenameColumns = data.map(col => col.map(v => String(v)));
    }
    if (data && Array.isArray(data.names) && data.names.length === 3) {
      filenameColumnNames = data.names.map(v => String(v) || '');
    }
  } catch {}
}

function saveFilenameColumns() {
  const payload = { columns: filenameColumns, names: filenameColumnNames };
  try { localStorage.setItem(FILENAME_STORE_KEY, JSON.stringify(payload)); } catch {}
}

function renderFilenameColumns() {
  for (let c = 0; c < 3; c++) {
    const listEl = document.getElementById(`col${c}`);
    listEl.innerHTML = '';
    const col = filenameColumns[c] || [];
    const nameEl = document.getElementById(`colName${c}`);
    if (nameEl) nameEl.textContent = filenameColumnNames[c] || `Column ${c+1}`;
    if (col.length === 0) {
      const li = document.createElement('li');
      li.className = 'item';
      const span = document.createElement('span');
      span.className = 'label';
      span.textContent = '(empty)';
      li.appendChild(span);
      li.style.opacity = .7;
      listEl.appendChild(li);
    } else {
      col.forEach((val, idx) => {
        const li = document.createElement('li');
        li.className = 'item' + (selectedIndices[c] === idx ? ' selected' : '');
        const span = document.createElement('span');
        span.className = 'label';
        span.textContent = val;
        const rm = document.createElement('button');
        rm.className = 'remove';
        rm.type = 'button';
        rm.textContent = 'Remove';
        rm.addEventListener('click', (e) => { e.stopPropagation(); removeEntry(c, idx); });
        li.addEventListener('click', () => toggleSelect(c, idx));
        li.appendChild(span);
        li.appendChild(rm);
        listEl.appendChild(li);
      });
    }
  }
}

function addEntry(colIndex) {
  const input = document.getElementById(`add${colIndex}`);
  const value = (input.value || '').trim();
  if (!value) return;
  filenameColumns[colIndex] = filenameColumns[colIndex] || [];
  filenameColumns[colIndex].push(value);
  input.value = '';
  saveFilenameColumns();
  renderFilenameColumns();
}

function removeEntry(colIndex, idx) {
  const col = filenameColumns[colIndex];
  if (!col) return;
  col.splice(idx, 1);
  // Adjust selection
  if (selectedIndices[colIndex] === idx) selectedIndices[colIndex] = null;
  else if (selectedIndices[colIndex] != null && selectedIndices[colIndex] > idx) selectedIndices[colIndex]--;
  saveFilenameColumns();
  renderFilenameColumns();
}

function toggleSelect(colIndex, idx) {
  if (selectedIndices[colIndex] === idx) selectedIndices[colIndex] = null; else selectedIndices[colIndex] = idx;
  renderFilenameColumns();
}

function buildFilenameBase() {
  const parts = [];
  for (let c = 0; c < 3; c++) {
    const idx = selectedIndices[c];
    if (idx != null && filenameColumns[c] && filenameColumns[c][idx] != null) {
      const val = String(filenameColumns[c][idx]).trim();
      if (val) parts.push(sanitizeFilenamePart(val));
    }
  }
  if (parts.length === 0) return '';
  return parts.join('-');
}

function sanitizeFilenamePart(s) {
  // Remove characters not allowed in filenames on Windows/macOS
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

function drawSpectrum() {
  const canvas = document.getElementById('spectrumCanvas');
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(300, Math.floor(rect.width * dpr));
  const height = Math.max(180, Math.floor(rect.height * dpr));
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a0f1a';
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(229,231,235,0.8)';
  if (!showImpulse) {
    // Frequency-domain view
    drawSpectrumGrid(ctx, width, height);
    if (!spectrumSamples) { ctx.restore(); return; }
    const sr = audioContext ? audioContext.sampleRate : 48000;
    let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
    const smoothSlider = document.getElementById('smoothSize');
    const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
    if (smoothFactor > 0) {
      magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize);
    }
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#34d399';
    ctx.beginPath();
    let moved = false;
    for (let i = 1; i < freq.length; i++) {
      const f = freq[i];
      if (f < viewXMin || f > viewXMax) continue;
      const d = magDb[i];
      const x = mapLog(f, viewXMin, viewXMax, 0, width);
      const y = mapLinear(d, viewYMax, viewYMin, 0, height);
      if (!moved) { ctx.moveTo(x, y); moved = true; } else { ctx.lineTo(x, y); }
    }
    ctx.stroke();
  } else {
    // Time-domain impulse response (minimum-phase) view with shared pan/zoom (linear axes)
    if (!spectrumSamples) { ctx.restore(); return; }
    const sr = audioContext ? audioContext.sampleRate : 48000;
    let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
    const smoothSlider = document.getElementById('smoothSize');
    const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
    if (smoothFactor > 0) { magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize); }
    // Build minimum-phase impulse and apply IR Size truncation and windowing
    const irFull = buildMinimumPhaseIRFromMag(freq, magDb, sr, spectrumFftSize);
    const irLength = getSelectedIrLength();
    const ir = truncateAndWindowIR(irFull, irLength);
    const N = ir.length;
    // Prepare view ranges if switching or length changed
    if (impLastLength !== N) { impLastLength = N; viewXMin = 0; viewXMax = N - 1; }
    let maxAbs = 1e-9; for (let i = 0; i < N; i++) maxAbs = Math.max(maxAbs, Math.abs(ir[i]));
    ctx.strokeStyle = '#60a5fa';
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      // map x using linear domain [viewXMin, viewXMax]
      const x = mapLinear(i, viewXMin, viewXMax, 0, width);
      // map y using linear domain [viewYMin, viewYMax]
      const yVal = (ir[i] / maxAbs);
      const y = mapLinear(yVal, viewYMax, viewYMin, 0, height);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawSpectrumGrid(ctx, width, height) {
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.fillStyle = 'rgba(229,231,235,0.7)';
  ctx.lineWidth = 1;
  if (!showImpulse) {
    // dB grid lines
    const step = 10;
    const startDb = Math.ceil(viewYMin / step) * step;
    for (let db = startDb; db <= viewYMax; db += step) {
      const y = mapLinear(db, viewYMax, viewYMin, 0, height);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      ctx.fillText(`${db} dB`, 4, Math.max(0, y - 12));
    }
    // Frequency lines
    const freqs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
    freqs.forEach(f => {
      if (f < viewXMin || f > viewXMax) return;
      const x = mapLog(f, viewXMin, viewXMax, 0, width);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      const label = f >= 1000 ? `${(f/1000)}k` : `${f}`;
      ctx.fillText(`${label} Hz`, Math.min(width - 60, x + 4), 2);
    });
  } else {
    // Impulse view grid: linear amplitude lines and sample index ticks
    const ampStep = 0.2;
    for (let a = -1; a <= 1.0001; a += ampStep) {
      const y = mapLinear(a, viewYMax, viewYMin, 0, height);
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(width, y); ctx.stroke();
      ctx.fillText(`${a.toFixed(1)}`, 4, Math.max(0, y - 12));
    }
    // X ticks every ~10% of span
    const span = Math.max(1, viewXMax - viewXMin);
    const step = Math.max(1, Math.floor(span / 10));
    for (let xv = Math.ceil(viewXMin / step) * step; xv <= viewXMax; xv += step) {
      const x = mapLinear(xv, viewXMin, viewXMax, 0, width);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, height); ctx.stroke();
      ctx.fillText(`${Math.round(xv)}`, Math.min(width - 40, x + 4), 2);
    }
  }
  ctx.restore();
}

function mapLog(value, inMin, inMax, outMin, outMax) {
  const v = Math.max(inMin, Math.min(inMax, value));
  const a = Math.log10(inMin);
  const b = Math.log10(inMax);
  const t = (Math.log10(v) - a) / (b - a);
  return outMin + t * (outMax - outMin);
}
function mapLinear(value, inMin, inMax, outMin, outMax) {
  const t = (value - inMin) / (inMax - inMin);
  return outMin + t * (outMax - outMin);
}

function initSpectrumCanvasInteractions() {
  const canvas = document.getElementById('spectrumCanvas');
  if (!canvas) return;
  let lastX = 0, lastY = 0;
  canvas.addEventListener('mousedown', (e) => {
    isPanning = true; panStart = { x: e.clientX, y: e.clientY }; lastX = e.clientX; lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => { isPanning = false; panStart = null; });
  canvas.addEventListener('mousemove', (e) => {
    if (!isPanning) return;
    const dx = e.clientX - lastX;
    const dy = e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    panView(dx, dy, canvas.width, canvas.height);
    drawSpectrum();
  });
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomFactor = Math.pow(1.0015, e.deltaY);
    const px = e.offsetX * (window.devicePixelRatio || 1);
    const py = e.offsetY * (window.devicePixelRatio || 1);
    if (e.shiftKey) {
      zoomViewY(zoomFactor, py, canvas.height);
    } else {
      zoomViewX(zoomFactor, px, canvas.width);
    }
    drawSpectrum();
  }, { passive: false });
}

function panView(dx, dy, width, height) {
  if (showImpulse) {
    // Linear pan for impulse view (samples domain)
    const span = viewXMax - viewXMin;
    const shift = -dx / width * span;
    let newXMin = viewXMin + shift;
    let newXMax = viewXMax + shift;
    const maxX = Math.max(1, impLastLength - 1);
    if (newXMin < 0) { newXMax -= newXMin; newXMin = 0; }
    if (newXMax > maxX) { const diff = newXMax - maxX; newXMin -= diff; newXMax = maxX; if (newXMin < 0) newXMin = 0; }
    viewXMin = newXMin; viewXMax = newXMax;
    // Vertical pan linear amplitude
    const ampSpan = viewYMax - viewYMin;
    const ampShift = dy / height * ampSpan;
    viewYMin += ampShift; viewYMax += ampShift;
  } else {
    // Log-frequency pan for spectrum view
    const logMin = Math.log10(viewXMin);
    const logMax = Math.log10(viewXMax);
    const logSpan = logMax - logMin;
    const shift = -dx / width * logSpan;
    const newLogMin = logMin + shift;
    const newLogMax = logMax + shift;
    let newXMin = Math.pow(10, newLogMin);
    let newXMax = Math.pow(10, newLogMax);
    if (newXMin >= 10 && newXMax <= 48000) {
      viewXMin = newXMin;
      viewXMax = newXMax;
    }
    // Vertical pan linear in dB
    const dBSpan = viewYMax - viewYMin;
    const dBShift = dy / height * dBSpan;
    viewYMin += dBShift;
    viewYMax += dBShift;
  }
}

function zoomViewX(scale, px, width) {
  if (showImpulse) {
    const t = px / width;
    const span = viewXMax - viewXMin;
    const center = viewXMin + t * span;
    const newSpan = span * scale;
    let newMin = center - t * newSpan;
    let newMax = center + (1 - t) * newSpan;
    const maxX = Math.max(1, impLastLength - 1);
    if (newMin < 0) { newMax -= newMin; newMin = 0; }
    if (newMax > maxX) { const diff = newMax - maxX; newMin -= diff; newMax = maxX; if (newMin < 0) newMin = 0; }
    // Prevent collapse
    if (newMax - newMin < 1) { newMin = Math.max(0, center - 0.5); newMax = Math.min(maxX, center + 0.5); }
    viewXMin = newMin; viewXMax = newMax;
  } else {
    const logMin = Math.log10(viewXMin);
    const logMax = Math.log10(viewXMax);
    const t = px / width;
    const center = logMin + t * (logMax - logMin);
    const newSpan = (logMax - logMin) * scale;
    const newLogMin = center - t * newSpan;
    const newLogMax = center + (1 - t) * newSpan;
    viewXMin = Math.max(10, Math.pow(10, newLogMin));
    viewXMax = Math.min(48000, Math.pow(10, newLogMax));
  }
}

function zoomViewY(scale, py, height) {
  const ty = py / height;
  const centerDb = viewYMax - ty * (viewYMax - viewYMin);
  const newDbSpan = (viewYMax - viewYMin) * scale;
  viewYMin = centerDb - (1 - ty) * newDbSpan;
  viewYMax = centerDb + ty * newDbSpan;
}

function resetSpectrumView() {
  if (showImpulse) {
    // Reset to fit full impulse length and amplitude nicely
    const sr = audioContext ? audioContext.sampleRate : 48000;
    let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
    const smoothSlider = document.getElementById('smoothSize');
    const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
    if (smoothFactor > 0) { magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize); }
    const ir = buildMinimumPhaseIRFromMag(freq, magDb, sr, spectrumFftSize);
    impLastLength = ir.length;
    viewXMin = 0; viewXMax = Math.max(1, impLastLength - 1);
    // Compute amplitude range and add 10% headroom
    let maxAbs = 1e-9; for (let i = 0; i < ir.length; i++) maxAbs = Math.max(maxAbs, Math.abs(ir[i]));
    const margin = maxAbs * 1.1;
    viewYMin = -margin; viewYMax = margin;
  } else {
    // Reset spectrum axes only (leave FFT slider untouched)
    viewXMin = 20;
    viewXMax = 24000;
    viewYMin = -120;
    viewYMax = 0;
  }
  drawSpectrum();
}


// Output routing fallback: connect to default system output when sink selection
// is unavailable or not chosen, otherwise use the HTMLMediaElement route only.
function updateOutputRouting() {
  const wantDirect = !canSelectOutput() || !$('#outputDevice').value;
  ensureDirectOutputConnected(wantDirect && isPlayingTest);
  if (outputAudioEl) outputAudioEl.muted = wantDirect && isPlayingTest; // avoid double-audio
}

function ensureDirectOutputConnected(shouldConnect) {
  if (!audioContext || !masterGain) return;
  try {
    if (shouldConnect && !directOutConnected) {
      masterGain.connect(audioContext.destination);
      directOutConnected = true;
    } else if (!shouldConnect && directOutConnected) {
      masterGain.disconnect(audioContext.destination);
      directOutConnected = false;
    }
  } catch {}
}

