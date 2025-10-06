import {
  encodeWav24,
  computeSpectrum,
  buildMinimumPhaseIRFromMag,
  applyFrequencySmoothing,
  truncateAndWindowIR
} from './dsp.js';

// ===== Utility Functions =====

const $ = (sel) => document.querySelector(sel);

// ===== Core Audio State =====

let audioContext = null;
let requestedSampleRate = 48000;
let masterGain = null;
let outputDest = null;
let outputAudioEl = null;
let generatorNode = null;
let recorderNode = null;
let inputStream = null;
let inputSourceNode = null;
let initialized = false;
let isPlayingTest = false;
let directOutConnected = false;
let inputDeviceInfoById = {};

// ===== Global Options =====

const FFTSizeOptions = [1024, 2048, 4096, 8192, 16384, 32768];
const IrSizeOptions = [1024, 2048, 4096, 8192];

// ===== Recording State =====

let isRecording = false;
let recordingTimer = null;
let startCaptureTimer = null;
let recordTargetSamples = 0;
let recordWriteIndex = 0;
let recordBuffer = null;

// ===== Filename Builder State =====

const FILENAME_STORE_KEY = 'ca-filename-columns-v1';
let filenameColumns = [[], [], []];
let filenameColumnNames = ['Column 1', 'Column 2', 'Column 3'];
let selectedIndices = [null, null, null];

// ===== Spectrum/Visualization State =====

let spectrumSamples = null;
let spectrumFftSize = 4096;
let viewXMin = 20; // Hz
let viewXMax = 24000; // Hz
let viewYMin = -120; // dB
let viewYMax = 0; // dB
let isPanning = false;
let showImpulse = false;
let specBackup = { xMin: 20, xMax: 24000, yMin: -120, yMax: 0 };
let impLastLength = 0;

// ===== Level Meter State =====

let meterAnalyser = null;
let meterTimeData = null;
let meterRafHandle = 0;
let meterTapNode = null;

// ===== Export/Settings State =====

let autoExportEnabled = true;

// ===== Unified UI State Persistence =====

const UI_STATE_KEY = 'ca-ui-state-v1';

function getDefaultUiState() {
  return {
    selectedInputId: '',
    selectedOutputId: '',
    inputChannel: 'left',
    signalType: 'white',
    volume: '0.2',
    sampleRate: 48000,
    fftIndex: 2,
    smooth: 0,
    irIndex: 2,
    autoExport: true,
    filename: { columns: [[], [], []], names: ['Column 1', 'Column 2', 'Column 3'] }
  };
}

function loadUiState() {
  try {
    const raw = localStorage.getItem(UI_STATE_KEY);
    if (raw) {
      const obj = JSON.parse(raw);
      return { ...getDefaultUiState(), ...obj };
    }
  } catch {}

  // Backward-compat: read legacy keys if unified key absent
  const state = getDefaultUiState();
  try {
    const sr = parseInt(localStorage.getItem('ca-sr') || '48000', 10);
    if ([44100, 48000, 96000].includes(sr)) state.sampleRate = sr;
  } catch {}
  try {
    const v = localStorage.getItem('ca-volume');
    if (v != null) state.volume = String(v);
  } catch {}
  try { state.selectedInputId = localStorage.getItem('ca-selected-input') || ''; } catch {}
  try { state.selectedOutputId = localStorage.getItem('ca-selected-output') || ''; } catch {}
  try {
    const idx = parseInt(localStorage.getItem('ca-fft-index') || '', 10);
    if (!Number.isNaN(idx)) state.fftIndex = idx;
  } catch {}
  try {
    const sm = parseInt(localStorage.getItem('ca-smooth') || '', 10);
    if (!Number.isNaN(sm)) state.smooth = sm;
  } catch {}
  try {
    const ir = parseInt(localStorage.getItem('ca-ir-index') || '', 10);
    if (!Number.isNaN(ir)) state.irIndex = ir;
  } catch {}
  try {
    const ae = localStorage.getItem('ca-auto-export');
    if (ae === '0') state.autoExport = false;
    if (ae === '1') state.autoExport = true;
  } catch {}
  try {
    const raw2 = localStorage.getItem(FILENAME_STORE_KEY);
    if (raw2) {
      const data = JSON.parse(raw2);
      if (data && Array.isArray(data.columns) && data.columns.length === 3 && data.columns.every(col => Array.isArray(col))) {
        state.filename.columns = data.columns.map(col => col.map(v => String(v)));
      } else if (Array.isArray(data) && data.length === 3) {
        state.filename.columns = data.map(col => col.map(v => String(v)));
      }
      if (data && Array.isArray(data.names) && data.names.length === 3) {
        state.filename.names = data.names.map(v => String(v) || '');
      }
    }
  } catch {}
  return state;
}

function saveUiState(newState) {
  try {
    localStorage.setItem(UI_STATE_KEY, JSON.stringify(newState));
  } catch {}
  // Keep filename builder in its legacy key as well for compatibility
  try {
    const payload = { columns: newState.filename.columns, names: newState.filename.names };
    localStorage.setItem(FILENAME_STORE_KEY, JSON.stringify(payload));
  } catch {}
}

function snapshotUiState() {
  const fftSlider = document.getElementById('fftSize');
  const smoothSlider = document.getElementById('smoothSize');
  const irSizeSlider = document.getElementById('irSize');
  const inputSel = document.getElementById('inputDevice');
  const outputSel = document.getElementById('outputDevice');
  const volEl = document.getElementById('volume');
  const signalSel = document.getElementById('signalType');
  const channelSel = document.getElementById('inputChannel');
  return {
    selectedInputId: inputSel ? (inputSel.value || '') : '',
    selectedOutputId: outputSel ? (outputSel.value || '') : '',
    inputChannel: channelSel ? (channelSel.value || 'left') : 'left',
    signalType: signalSel ? (signalSel.value || 'white') : 'white',
    volume: volEl ? String(volEl.value) : '0.2',
    sampleRate: requestedSampleRate || 48000,
    fftIndex: fftSlider ? parseInt(fftSlider.value, 10) || 0 : 2,
    smooth: smoothSlider ? parseInt(smoothSlider.value, 10) || 0 : 0,
    irIndex: irSizeSlider ? parseInt(irSizeSlider.value, 10) || 0 : 2,
    autoExport: !!autoExportEnabled,
    filename: { columns: filenameColumns, names: filenameColumnNames }
  };
}

// ===== Capability Checks =====

const canSelectOutput = () =>
  typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;

// ===== Audio Initialization =====
async function initAudioIfNeeded() {
  if (initialized) return;

  const opts = {};
  if (requestedSampleRate) opts.sampleRate = requestedSampleRate;
  audioContext = new (window.AudioContext || window.webkitAudioContext)(opts);

  await audioContext.audioWorklet.addModule('./worklets.js');

  masterGain = audioContext.createGain();
  masterGain.gain.value = parseFloat($('#volume').value);
  outputDest = audioContext.createMediaStreamDestination();
  masterGain.connect(outputDest);

  generatorNode = new AudioWorkletNode(audioContext, 'test-signal-processor', {
    outputChannelCount: [1]
  });
  generatorNode.connect(masterGain);

  recorderNode = new AudioWorkletNode(audioContext, 'recorder-processor', {
    numberOfInputs: 1,
    numberOfOutputs: 0
  });
  recorderNode.port.onmessage = onRecorderMessage;

  outputAudioEl = document.createElement('audio');
  outputAudioEl.autoplay = true;
  outputAudioEl.playsInline = true;
  outputAudioEl.muted = false;
  outputAudioEl.srcObject = outputDest.stream;
  outputAudioEl.style.display = 'none';
  document.body.appendChild(outputAudioEl);

  try {
    await outputAudioEl.play();
  } catch (e) {
    // Ignore autoplay errors
  }

  initialized = true;
}

// ===== Device Management =====
async function ensureDeviceAccess() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch (err) {
    setStatus(`Microphone permission denied or unavailable. ${err?.message || ''}`);
  }
}

async function refreshDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;

  const devices = await navigator.mediaDevices.enumerateDevices();
  const inputs = devices
    .filter(d => d.kind === 'audioinput')
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));
  const outputs = devices
    .filter(d => d.kind === 'audiooutput')
    .sort((a, b) => (a.label || '').localeCompare(b.label || ''));

  const inputSel = $('#inputDevice');
  const outputSel = $('#outputDevice');

  const prevIn = inputSel.value || localStorage.getItem('ca-selected-input') || '';
  const prevOut = outputSel.value || localStorage.getItem('ca-selected-output') || '';

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

  if ([...inputSel.options].some(o => o.value === prevIn)) inputSel.value = prevIn;
  if ([...outputSel.options].some(o => o.value === prevOut)) outputSel.value = prevOut;

  await applyOutputSink();
}

async function applyOutputSink() {
  if (!outputAudioEl) return;
  const outId = $('#outputDevice').value;
  if (canSelectOutput() && outId) {
    try {
      await outputAudioEl.setSinkId(outId);
    } catch (e) {
      setStatus(`Cannot set output device: ${e?.message || e}`);
    }
  }
  updateOutputRouting();
}

// ===== Input Stream Management =====
async function startInput(deviceId) {
  stopInput();

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
  setupInputMeter();

  try {
    await audioContext.resume();
  } catch (e) {
    // Ignore resume errors
  }

  const chanSelect = document.getElementById('inputChannel');
  const chanMode = chanSelect ? (chanSelect.value || 'left') : 'left';
  const track = inputStream.getAudioTracks()[0];
  const settings = track.getSettings ? track.getSettings() : {};
  const channels = settings.channelCount || inputSourceNode.channelCount || 1;

  if (chanSelect && chanSelect.parentElement) {
    chanSelect.parentElement.style.display = channels > 1 ? '' : 'none';
    if (channels <= 1) chanSelect.value = 'left';
  }

  let tapNode = inputSourceNode;
  if (channels > 1) {
    const splitter = audioContext.createChannelSplitter(Math.max(2, channels));
    inputSourceNode.connect(splitter);
    if (chanMode === 'right') {
      const gain = audioContext.createGain();
      splitter.connect(gain, 1);
      tapNode = gain;
    } else {
      const gain = audioContext.createGain();
      splitter.connect(gain, 0);
      tapNode = gain;
    }
  }
  // Connect selected channel to recorder
  tapNode.connect(recorderNode);
  // Route selected channel to meter analyser (mirror of actual capture path)
  try { if (meterTapNode) meterTapNode.disconnect(meterAnalyser); } catch {}
  try { tapNode.connect(meterAnalyser); meterTapNode = tapNode; } catch {}

  try {
    const label = track?.label || 'Unknown input device';
    setStatus(`Input device in use: ${label}`);
  } catch (e) {
    // Ignore label errors
  }
}

function setupInputMeter() {
  try {
    if (meterAnalyser) {
      try {
        if (meterTapNode) meterTapNode.disconnect(meterAnalyser);
      } catch (e) {
        // Ignore disconnect errors
      }
    }

    meterAnalyser = audioContext.createAnalyser();
    meterAnalyser.fftSize = 2048;
    meterAnalyser.smoothingTimeConstant = 0.0;
    meterAnalyser.minDecibels = -120;
    meterAnalyser.maxDecibels = 0;
    meterTimeData = new Float32Array(meterAnalyser.fftSize);

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
        const norm = Math.min(1, Math.max(0, (db + 50) / 50));

        if (fillEl) {
          fillEl.style.width = `${(norm * 100).toFixed(1)}%`;
          let color = '#22c55e';
          if (peak > 0.7) color = '#ef4444';
          else if (peak > 0.25) color = '#eab308';
          fillEl.style.backgroundColor = color;
        }
        if (labelEl) {
          labelEl.textContent = isFinite(db) ? `${db.toFixed(1)} dB` : '-∞ dB';
        }
      } catch (e) {
        // Ignore meter errors
      }
      meterRafHandle = requestAnimationFrame(raf);
    }

    meterRafHandle = requestAnimationFrame(raf);
    return meterAnalyser;
  } catch (e) {
    return null;
  }
}

function stopInput() {
  try {
    if (inputSourceNode) inputSourceNode.disconnect();
  } catch (e) {
    // Ignore disconnect errors
  }
  inputSourceNode = null;
  if (inputStream) {
    inputStream.getTracks().forEach(t => t.stop());
    inputStream = null;
  }
}

// ===== Generator Control =====
async function configureGenerator() {
  const mode = $('#signalType').value;
  const freq = 1000;
  generatorNode.port.postMessage({
    type: 'config',
    mode,
    freq,
    enabled: isPlayingTest
  });
  masterGain.gain.value = parseFloat($('#volume').value);
  await applyOutputSink();
}

function setGeneratorPlaying(on) {
  isPlayingTest = !!on;
  generatorNode.port.postMessage({ type: 'config', enabled: isPlayingTest });
  updateOutputRouting();
  updatePlayButtonLabel();
}

// ===== Recording Flow =====
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
      stopRecordingFlow();
    }
  }
}

function startRecordingFlow() {
  if (isRecording) return;
  if (!initialized) {
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

  setGeneratorPlaying(true);
  configureGenerator();

  startCaptureTimer = setTimeout(() => {
    recorderNode.port.postMessage({ type: 'set-recording', enabled: true });
    setStatus('Recording for 5 seconds...');
    recordingTimer = setTimeout(() => stopRecordingFlow(), 5100);
  }, 500);
}

function stopRecordingFlow() {
  if (!isRecording) return;
  isRecording = false;

  try {
    recorderNode.port.postMessage({ type: 'set-recording', enabled: false });
  } catch (e) {
    // Ignore messaging errors
  }

  if (startCaptureTimer) {
    clearTimeout(startCaptureTimer);
    startCaptureTimer = null;
  }
  if (recordingTimer) {
    clearTimeout(recordingTimer);
    recordingTimer = null;
  }

  setGeneratorPlaying(false);

  const finalSamples = Math.min(recordWriteIndex, recordTargetSamples);
  const finalBuf =
    finalSamples === recordTargetSamples ? recordBuffer : recordBuffer.slice(0, finalSamples);

  spectrumSamples = finalBuf;
  drawSpectrum();

  if (!showImpulse) {
    resetSpectrumView();
  }

  if (autoExportEnabled) {
    try {
      exportSpectrumFile();
    } catch (e) {
      // Ignore export errors
    }
    try {
      exportImpulseResponse();
    } catch (e) {
      // Ignore export errors
    }
    try {
      exportRawAudio();
    } catch (e) {
      // Ignore export errors
    }
  }

  $('#recordBtn').disabled = false;
  setStatus('Capture completed. Exported IR and Spectrum.');
  updatePlayButtonLabel();
}

// ===== Export Functions =====

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
  if (!spectrumSamples || !audioContext) {
    setStatus('Nothing to export. Perform a capture first.');
    return;
  }

  const sr = audioContext.sampleRate | 0;
  let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
  const smoothSlider = document.getElementById('smoothSize');
  const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
  if (smoothFactor > 0) {
    magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize);
  }

  const header = String(sr);
  const lines = [header];
  for (let i = 0; i < magDb.length; i++) {
    const db = Number.isFinite(magDb[i]) ? magDb[i] : 0;
    const mag = Math.pow(10, db / 20);
    lines.push(mag.toFixed(8));
  }

  const content = lines.join('\r\n');
  const blob = new Blob([content], { type: 'text/plain' });
  const base = buildFilenameBase();
  const name = `${base || 'IR'}.spectrum`;
  triggerDownload(blob, name);
  setStatus(`Exported spectrum: ${name}`);
}

function exportImpulseResponse() {
  if (!spectrumSamples || !audioContext) {
    setStatus('Nothing to export. Perform a capture first.');
    return;
  }

  const sr = audioContext.sampleRate | 0;
  let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
  const smoothSlider = document.getElementById('smoothSize');
  const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
  if (smoothFactor > 0) {
    magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize);
  }

  const ir = buildMinimumPhaseIRFromMag(freq, magDb, sr, spectrumFftSize);
  const irLength = getSelectedIrLength();
  const truncated = truncateAndWindowIR(ir, irLength);

  let maxAbs = 1e-12;
  for (let i = 0; i < irLength; i++) {
    maxAbs = Math.max(maxAbs, Math.abs(truncated[i]));
  }
  const norm = 1 / maxAbs;
  for (let i = 0; i < irLength; i++) {
    truncated[i] *= norm;
  }

  const blob = encodeWav24(truncated, sr);
  const base = buildFilenameBase();
  const name = `${base || 'IR'}.wav`;
  triggerDownload(blob, name);
  setStatus(`Exported IR: ${name}`);
}

function exportRawAudio() {
  if (!spectrumSamples || !audioContext) {
    setStatus('Nothing to export. Perform a capture first.');
    return;
  }
  const sr = audioContext.sampleRate | 0;
  const blob = encodeWav24(spectrumSamples, sr);
  const base = buildFilenameBase();
  const name = `${base || 'IR'}.raw.wav`;
  triggerDownload(blob, name);
  setStatus(`Exported raw audio: ${name}`);
}

function getSelectedIrLength() {
  const slider = document.getElementById('irSize');
  const idx = Math.max(0, Math.min(IrSizeOptions.length - 1, parseInt(slider.value, 10)));
  return IrSizeOptions[idx];
}

function setStatus(text) {
  $('#status').textContent = text || '';
}

// ===== UI Event Handlers =====
async function onInitDevicesClick() {
  await initAudioIfNeeded();
  await ensureDeviceAccess();
  await refreshDevices();
  setStatus('Devices initialized. Choose input/output, then press Record.');
}

async function onRecordClick() {
  await initAudioIfNeeded();
  const inId = $('#inputDevice').value;
  if (!inputStream) await startInput(inId);
  await applyOutputSink();
  try {
    await audioContext.resume();
  } catch (e) {
    // Ignore resume errors
  }
  try {
    await outputAudioEl.play();
  } catch (e) {
    // Ignore play errors
  }
  startRecordingFlow();
}

async function onPlayToggleClick() {
  await initAudioIfNeeded();
  const newState = !isPlayingTest;
  setGeneratorPlaying(newState);
  await configureGenerator();
  try {
    await audioContext.resume();
  } catch (e) {
    // Ignore resume errors
  }
  try {
    await outputAudioEl.play();
  } catch (e) {
    // Ignore play errors
  }
  updatePlayButtonLabel();
  setStatus(newState ? 'Playing test signal...' : '');
}

function bindUI() {
  $('#initBtn').addEventListener('click', onInitDevicesClick);
  $('#recordBtn').addEventListener('click', onRecordClick);
  $('#playBtn').addEventListener('click', onPlayToggleClick);
  $('#signalType').addEventListener('change', configureGenerator);
  $('#signalType').addEventListener('change', () => saveUiState(snapshotUiState()));
  $('#volume').addEventListener('input', () => {
    if (masterGain) masterGain.gain.value = parseFloat($('#volume').value);
    saveUiState(snapshotUiState());
  });
  $('#inputDevice').addEventListener('change', async (e) => { await initAudioIfNeeded(); saveUiState(snapshotUiState()); await startInput(e.target.value); });
  const chanSelEl = document.getElementById('inputChannel');
  if (chanSelEl) {
    chanSelEl.addEventListener('change', async () => {
      await initAudioIfNeeded();
      const currentId = document.getElementById('inputDevice')?.value || '';
      await startInput(currentId);
      saveUiState(snapshotUiState());
    });
  }
  $('#sampleRateSel').addEventListener('change', async (e) => {
    const val = parseInt(e.target.value, 10) || 48000;
    requestedSampleRate = val;
    saveUiState(snapshotUiState());
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
  $('#outputDevice').addEventListener('change', async (e) => { await initAudioIfNeeded(); saveUiState(snapshotUiState()); await applyOutputSink(); });
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
        saveUiState(snapshotUiState());
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
  // restore saved fft index if present
  try {
    const savedFftIdx = parseInt(localStorage.getItem('ca-fft-index') || '', 10);
    if (!Number.isNaN(savedFftIdx) && savedFftIdx >= 0 && savedFftIdx < FFTSizeOptions.length) {
      fftSlider.value = String(savedFftIdx);
    }
  } catch {}
  fftLabel.textContent = String(FFTSizeOptions[parseInt(fftSlider.value, 10)]);
  spectrumFftSize = FFTSizeOptions[parseInt(fftSlider.value, 10)];
  fftSlider.addEventListener('input', () => {
    const idx = Math.max(0, Math.min(FFTSizeOptions.length - 1, parseInt(fftSlider.value, 10) || 0));
    spectrumFftSize = FFTSizeOptions[idx];
    fftLabel.textContent = String(spectrumFftSize);
    drawSpectrum();
    saveUiState(snapshotUiState());
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
    saveUiState(snapshotUiState());
  });
  const irSizeSlider = document.getElementById('irSize');
  const irSizeLabel = document.getElementById('irSizeLabel');
  try {
    const savedIrIdx = parseInt(localStorage.getItem('ca-ir-index') || '', 10);
    if (!Number.isNaN(savedIrIdx) && savedIrIdx >= 0 && savedIrIdx < IrSizeOptions.length) {
      irSizeSlider.value = String(savedIrIdx);
    }
  } catch {}
  irSizeLabel.textContent = String(IrSizeOptions[parseInt(irSizeSlider.value, 10)]);
  irSizeSlider.addEventListener('input', () => {
    const idx = Math.max(0, Math.min(IrSizeOptions.length - 1, parseInt(irSizeSlider.value, 10) || 0));
    irSizeLabel.textContent = String(IrSizeOptions[idx]);
    drawSpectrum();
    saveUiState(snapshotUiState());
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
  const rawBtn = document.getElementById('exportRaw');
  if (rawBtn) rawBtn.addEventListener('click', () => exportRawAudio());

  // Auto-export toggle
  const autoBtn = document.getElementById('autoExportToggle');
  if (autoBtn) {
    const applyLabel = () => {
      autoBtn.textContent = `Auto Export: ${autoExportEnabled ? 'On' : 'Off'}`;
    };
    applyLabel();
    autoBtn.addEventListener('click', () => {
      autoExportEnabled = !autoExportEnabled;
      applyLabel();
      saveUiState(snapshotUiState());
    });
  }

  initSpectrumCanvasInteractions();
}

// ===== App Initialization =====

window.addEventListener('DOMContentLoaded', () => {
  bindUI();
  (async () => {
    try {
      // Restore unified UI state
      const ui = loadUiState();
      requestedSampleRate = ui.sampleRate;
      const srSel = document.getElementById('sampleRateSel');
      if (srSel) srSel.value = String(ui.sampleRate);
      // Restore static dropdowns prior to audio init
      try {
        const signalSel = document.getElementById('signalType');
        if (signalSel) signalSel.value = ui.signalType;
        const chanSel = document.getElementById('inputChannel');
        if (chanSel) chanSel.value = ui.inputChannel;
      } catch {}
      autoExportEnabled = !!ui.autoExport;
      const autoBtn = document.getElementById('autoExportToggle');
      if (autoBtn) autoBtn.textContent = `Auto Export: ${autoExportEnabled ? 'On' : 'Off'}`;
      await initAudioIfNeeded();
      await ensureDeviceAccess();
      await refreshDevices();
      setStatus('Ready.');
      updatePlayButtonLabel();
      // Restore settings to UI controls
      try {
        const volEl = document.getElementById('volume');
        if (volEl) {
          volEl.value = String(ui.volume);
          if (masterGain) masterGain.gain.value = parseFloat(volEl.value);
        }
      } catch {}
      // Filename builder
      filenameColumns = ui.filename.columns;
      filenameColumnNames = ui.filename.names;
      renderFilenameColumns();
      // Restore device selections
      try {
        const inputSel = document.getElementById('inputDevice');
        const outputSel = document.getElementById('outputDevice');
        if (inputSel && [...inputSel.options].some(o => o.value === ui.selectedInputId)) inputSel.value = ui.selectedInputId;
        if (outputSel && [...outputSel.options].some(o => o.value === ui.selectedOutputId)) outputSel.value = ui.selectedOutputId;
      } catch {}
      const savedInput = ui.selectedInputId || document.getElementById('inputDevice')?.value || '';
      if (savedInput) {
        try {
          await startInput(savedInput);
        } catch (e) {
          // Ignore errors
        }
      }
      // Restore spectrum control selections
      const fftSlider = document.getElementById('fftSize');
      const fftLabel = document.getElementById('fftLabel');
      if (fftSlider && fftLabel) {
        const idx = Math.max(0, Math.min(FFTSizeOptions.length - 1, ui.fftIndex));
        fftSlider.value = String(idx);
        spectrumFftSize = FFTSizeOptions[idx];
        fftLabel.textContent = String(spectrumFftSize);
      }
      const smoothSlider = document.getElementById('smoothSize');
      const smoothLabel = document.getElementById('smoothLabel');
      if (smoothSlider && smoothLabel) {
        smoothSlider.value = String(ui.smooth);
        smoothLabel.textContent = String(ui.smooth);
      }
      const irSizeSlider = document.getElementById('irSize');
      const irSizeLabel = document.getElementById('irSizeLabel');
      if (irSizeSlider && irSizeLabel) {
        const idx = Math.max(0, Math.min(IrSizeOptions.length - 1, ui.irIndex));
        irSizeSlider.value = String(idx);
        irSizeLabel.textContent = String(IrSizeOptions[idx]);
      }
    } catch (e) {
      // Silent; user can click Initialize
    }
  })();
});

function updatePlayButtonLabel() {
  const btn = document.getElementById('playBtn');
  if (!btn) return;
  btn.textContent = isPlayingTest ? 'Stop Test Signal' : 'Play Test Signal';
}

// ===== Filename Builder =====
function saveFilenameColumns() {
  const payload = { columns: filenameColumns, names: filenameColumnNames };
  try {
    localStorage.setItem(FILENAME_STORE_KEY, JSON.stringify(payload));
  } catch (e) {
    // Ignore storage errors
  }
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
  saveUiState(snapshotUiState());
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
  saveUiState(snapshotUiState());
  renderFilenameColumns();
}

function toggleSelect(colIndex, idx) {
  if (selectedIndices[colIndex] === idx) {
    selectedIndices[colIndex] = null;
  } else {
    selectedIndices[colIndex] = idx;
  }
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
  return s.replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim();
}

// ===== Spectrum Visualization =====

function drawSpectrum() {
  const canvas = document.getElementById('spectrumCanvas');
  if (!canvas) return;

  const rect = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const width = Math.max(300, Math.floor(rect.width * dpr));
  const height = Math.max(180, Math.floor(rect.height * dpr));

  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#0a0f1a';
  ctx.fillRect(0, 0, width, height);
  ctx.font = `${12 * dpr}px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial`;
  ctx.textBaseline = 'top';
  ctx.fillStyle = 'rgba(229,231,235,0.8)';

  if (!showImpulse) {
    drawSpectrumGrid(ctx, width, height);
    if (!spectrumSamples) {
      ctx.restore();
      return;
    }

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
      if (!moved) {
        ctx.moveTo(x, y);
        moved = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();
  } else {
    if (!spectrumSamples) {
      ctx.restore();
      return;
    }
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
    isPanning = true;
    lastX = e.clientX;
    lastY = e.clientY;
  });
  window.addEventListener('mouseup', () => {
    isPanning = false;
  });
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
    // Reset spectrum axes with auto vertical range
    viewXMin = 20;
    viewXMax = 24000;
    if (spectrumSamples && audioContext) {
      const sr = audioContext.sampleRate | 0;
      let { freq, magDb } = computeSpectrum(spectrumSamples, sr, spectrumFftSize);
      const smoothSlider = document.getElementById('smoothSize');
      const smoothFactor = smoothSlider ? (parseInt(smoothSlider.value, 10) || 0) / 100 : 0;
      if (smoothFactor > 0) { magDb = applyFrequencySmoothing(freq, magDb, smoothFactor, spectrumFftSize); }
      let topDb = -Infinity;
      for (let i = 1; i < freq.length; i++) {
        const f = freq[i];
        if (f >= 20 && f <= 20000) {
          const d = magDb[i];
          if (Number.isFinite(d) && d > topDb) topDb = d;
        }
      }
      if (!Number.isFinite(topDb)) topDb = 0;
      viewYMax = topDb + 1;
      viewYMin = viewYMax - 70;
    } else {
      viewYMax = 0;
      viewYMin = -70;
    }
  }
  drawSpectrum();
}

// ===== Output Routing =====

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
