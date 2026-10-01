/* =========================================================
   FLOWCESS v2 · Sprachmemo-Stil
   ---------------------------------------------------------
   Aufbau dieser Datei:
    1. Helfer
    2. Einstellungen
    3. Speicher (IndexedDB)
    4. Audio-Engine (WebAudio: Beat, Takes, Metronom)
    5. Aufnahme (Mikrofon)
    6. Analyse (Wellenform, BPM, Tonart)
    7. Waveform-Ansicht
    8. Oberfläche: Song-Liste, Studio, Lyrics, Live-Modus
    9. Sheets (Menüs & Dialoge)
   10. Export (Mix als WAV, Take teilen)
   11. Clean Vocal (Server vorbereitet)
   12. Start
   ========================================================= */
"use strict";

/* ===================== 1. HELFER ===================== */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const dbToGain = (db) => Math.pow(10, db / 20);
const gainToDb = (g) => (g <= 0.00001 ? -Infinity : 20 * Math.log10(g));

function el(tag, attrs = {}, children = []) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(n.style, v);
    else if (k.startsWith("on") && typeof v === "function") n.addEventListener(k.slice(2), v);
    else if (k === "html") n.innerHTML = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : v);
  }
  for (const c of [].concat(children)) {
    if (c == null || c === false) continue;
    n.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return n;
}

function fmtTime(t, withCs = false) {
  t = Math.max(0, t || 0);
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  if (withCs) {
    const cs = Math.floor((t * 100) % 100);
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(cs).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtDate(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString("de-CH", { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return "Gestern";
  return d.toLocaleDateString("de-CH", { day: "numeric", month: "short", year: d.getFullYear() === now.getFullYear() ? undefined : "numeric" });
}

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function haptic(ms = 8) {
  try { if (navigator.vibrate) navigator.vibrate(ms); } catch {}
}

let toastTimer = null;
function toast(msg, ms = 2200) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), ms);
}

/* Songteil-Typen: Name + Farbe */
const SECTION_TYPES = {
  intro:     { label: "Intro",     color: "#64d2ff", numbered: false },
  verse:     { label: "Verse",     color: "#0a84ff", numbered: true },
  pre:       { label: "Pre-Hook",  color: "#ff9f0a", numbered: false },
  hook:      { label: "Hook",      color: "#bf5af2", numbered: false },
  bridge:    { label: "Bridge",    color: "#30d158", numbered: false },
  interlude: { label: "Interlude", color: "#5e5ce6", numbered: false },
  outro:     { label: "Outro",     color: "#ac8e68", numbered: false },
  custom:    { label: "Eigener",   color: "#8e8e93", numbered: false },
};
const TAKE_COLORS = ["#ff375f", "#ff9f0a", "#64d2ff", "#30d158", "#ffd60a", "#bf5af2"];
const typeColor = (type) => (SECTION_TYPES[type] || SECTION_TYPES.custom).color;

/* ===================== 2. EINSTELLUNGEN ===================== */
const SETTINGS_KEY = "fc2_settings";
const Settings = Object.assign({
  latencyMs: 0,          // manuelle Sync-Korrektur für Aufnahmen
  duckOnRec: true,       // Beat bei Aufnahme leiser
  countIn: false,        // 1 Takt einzählen vor Aufnahme
  follow: true,          // Lyrics scrollen beim Abspielen mit
  liveSize: 34,          // Schriftgrösse im Live-Modus
  metroVolume: 0.7,
}, (() => { try { return JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); } catch { return {}; } })());
function saveSettings() { try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(Settings)); } catch {} }

/* ===================== 3. SPEICHER (IndexedDB) ===================== */
const Store = {
  db: null,
  ok: false,
  mem: { songs: new Map(), blobs: new Map() }, // Fallback, falls IndexedDB nicht geht

  async open() {
    if (!window.indexedDB) return;
    try {
      this.db = await new Promise((resolve, reject) => {
        const req = indexedDB.open("flowcess", 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("songs")) db.createObjectStore("songs", { keyPath: "id" });
          if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        setTimeout(() => reject(new Error("IDB timeout")), 4000);
      });
      this.ok = true;
      try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch {}
    } catch (err) {
      console.warn("IndexedDB nicht verfügbar:", err);
      this.ok = false;
    }
  },

  _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(store, mode);
      const os = tx.objectStore(store);
      const req = fn(os);
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  },

  async allSongs() {
    if (!this.ok) return [...this.mem.songs.values()];
    return (await this._tx("songs", "readonly", (os) => os.getAll())) || [];
  },
  async putSong(song) {
    const copy = JSON.parse(JSON.stringify(song));
    if (!this.ok) { this.mem.songs.set(copy.id, copy); return; }
    await this._tx("songs", "readwrite", (os) => os.put(copy));
  },
  async deleteSong(song) {
    if (!this.ok) { this.mem.songs.delete(song.id); return; }
    await this._tx("songs", "readwrite", (os) => os.delete(song.id));
    await this.deleteBlob(`beat:${song.id}`);
    for (const t of song.takes || []) { await this.deleteBlob(`take:${t.id}`); await this.deleteBlob(`take:${t.id}:clean`); }
  },
  async putBlob(key, blob) {
    if (!this.ok) { this.mem.blobs.set(key, blob); return; }
    // iOS speichert Blobs zuverlässiger als ArrayBuffer + Typ
    const buf = await blob.arrayBuffer();
    await this._tx("blobs", "readwrite", (os) => os.put({ type: blob.type, buf }, key));
  },
  async getBlob(key) {
    if (!this.ok) return this.mem.blobs.get(key) || null;
    const rec = await this._tx("blobs", "readonly", (os) => os.get(key));
    if (!rec) return null;
    return new Blob([rec.buf], { type: rec.type || "" });
  },
  async deleteBlob(key) {
    if (!this.ok) { this.mem.blobs.delete(key); return; }
    await this._tx("blobs", "readwrite", (os) => os.delete(key));
  },
};

/* ===================== APP-ZUSTAND ===================== */
const S = {
  songs: [],
  song: null,           // aktuell offener Song
  tab: "studio",
  lyrSub: "lyrics",
  playing: false,
  recording: false,
  pos: 0,               // Playhead in Sekunden (Song-Zeit)
  pps: 60,              // Zoom: Pixel pro Sekunde
  selTakeId: null,
  liveOpen: false,
};

function newSong(name) {
  const now = Date.now();
  return {
    id: uid(), name: name || nextSongName(), createdAt: now, updatedAt: now,
    bpm: 0, key: "", bpmManual: false, keyManual: false,
    beat: null, beatVolume: 0.85, beatMuted: false,
    sections: [], lyrics: [], notes: "", takes: [],
    metronome: false, loopSectionId: null, duration: 0,
  };
}

function nextSongName() {
  let n = 1;
  const names = new Set(S.songs.map((s) => s.name));
  while (names.has(`Neuer Song ${n}`)) n++;
  return `Neuer Song ${n}`;
}

const saveSongNow = async () => {
  if (!S.song) return;
  S.song.updatedAt = Date.now();
  S.song.duration = songDuration();
  try { await Store.putSong(S.song); } catch (err) { console.warn("Speichern fehlgeschlagen", err); }
};
const saveSong = debounce(saveSongNow, 400);

/* ===================== 4. AUDIO-ENGINE ===================== */
/*
  Warum WebAudio?
  Auf dem iPhone ignoriert Safari die Lautstärke von <audio>-Elementen
  (nur 0 oder 100 %). Deshalb spielen Beat und Takes hier als
  AudioBuffer mit eigenem GainNode. KEIN createMediaElementSource
  (das hat früher Fehler auf dem iPhone gemacht).
*/
const E = {
  ctx: null,
  master: null,
  beatGain: null,
  beatAnalyser: null,
  metroGain: null,
  beatBuf: null,
  beatPeaks: null,
  takes: new Map(),      // takeId -> { buf, peaks, gain, analyser }
  sources: [],
  startCtx: 0,           // ctx-Zeit, zu der startPos erklingt
  startPos: 0,
  raf: 0,
  metroTimer: 0,
  metroNextBeat: 0,      // Index des nächsten Metronom-Schlags
  unlocked: false,
};

function makeLimiter(ctx) {
  const l = ctx.createDynamicsCompressor();
  l.threshold.value = -1.5; l.knee.value = 0; l.ratio.value = 20; l.attack.value = 0.002; l.release.value = 0.12;
  return l;
}

function ensureCtx() {
  if (E.ctx) return E.ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  E.ctx = new AC({ latencyHint: "interactive" });
  E.master = E.ctx.createGain();
  // Limiter am Ende: verhindert Übersteuern (wie in einer DAW)
  E.limiter = makeLimiter(E.ctx);
  E.master.connect(E.limiter);
  E.limiter.connect(E.ctx.destination);

  E.beatGain = E.ctx.createGain();
  E.beatAnalyser = E.ctx.createAnalyser();
  E.beatAnalyser.fftSize = 1024;
  E.beatGain.connect(E.beatAnalyser);
  E.beatAnalyser.connect(E.master);

  E.metroGain = E.ctx.createGain();
  E.metroGain.gain.value = Settings.metroVolume;
  E.metroGain.connect(E.master);

  E.ctx.onstatechange = () => {
    if (E.ctx.state !== "running" && (S.playing || S.recording)) {
      E.ctx.resume().catch(() => {});
    }
  };
  applyMix();
  return E.ctx;
}

/*
  iPhone-Trick: WebAudio wird vom Stumm-Schalter stummgeschaltet.
  Ein stilles <audio> in Schleife schaltet iOS auf "Wiedergabe" um,
  dann ist der Beat auch bei Stumm-Schalter hörbar.
*/
let silentEl = null;
function startSilentAudio() {
  try {
    if (!silentEl) {
      const sr = 8000, len = sr / 2;
      const ab = new ArrayBuffer(44 + len * 2);
      const v = new DataView(ab);
      const w = (o, str) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
      w(0, "RIFF"); v.setUint32(4, 36 + len * 2, true); w(8, "WAVE"); w(12, "fmt ");
      v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
      v.setUint32(24, sr, true); v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
      w(36, "data"); v.setUint32(40, len * 2, true);
      silentEl = document.createElement("audio");
      silentEl.setAttribute("playsinline", "");
      silentEl.setAttribute("webkit-playsinline", "");
      silentEl.loop = true;
      silentEl.preload = "auto";
      silentEl.src = URL.createObjectURL(new Blob([ab], { type: "audio/wav" }));
    }
    if (silentEl.paused) {
      const p = silentEl.play();
      if (p && p.catch) p.catch(() => {});
    }
  } catch {}
}

/* Muss bei einem Tipp des Users passieren (iOS-Regel) */
async function unlockAudio() {
  startSilentAudio();
  ensureCtx();
  // iPhone: Stumm-Schalter soll Beat NICHT stumm machen
  setAudioSessionType(S.recording ? "play-and-record" : "playback");
  if (E.ctx.state !== "running") {
    try { await E.ctx.resume(); } catch {}
  }
  if (!E.unlocked) {
    // kurzer stiller Ton "weckt" iOS-Audio
    try {
      const b = E.ctx.createBuffer(1, 1, 22050);
      const s = E.ctx.createBufferSource();
      s.buffer = b; s.connect(E.ctx.destination); s.start(0);
    } catch {}
    E.unlocked = true;
  }
}

function setAudioSessionType(type) {
  // In der Xcode-App regelt Swift die Audio-Session → hier nichts ändern
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.flowcessShare) return;
  try {
    if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type;
  } catch {}
}

/* Tempo-Faktor: Song-Tempo / Original-Tempo des Beats (1 = unverändert)
   Umrechnung: Beat-Zeit = trim + Song-Zeit × R */
function beatRate(s = S.song) {
  if (!s || !s.beat) return 1;
  const o = s.beat.origBpm;
  return o && s.bpmExact ? s.bpmExact / o : 1;
}

/* Ende des Beats (Beat-Zeit) – mit Trimmen am Ende */
function beatEnd(s) {
  const full = E.beatBuf ? E.beatBuf.duration : (s.beat && s.beat.duration) || 0;
  return s.beat && s.beat.trimEnd ? Math.min(full, s.beat.trimEnd) : full;
}
/* Wie weit darf man nach links scrollen (im Trimm-Modus in den abgeschnittenen Teil) */
function minPos() {
  return S.trimMode && S.song && S.song.beat ? -(S.song.beat.trim || 0) / beatRate() : 0;
}

/* Wie weit darf man nach rechts (im Trimm-Modus bis zum echten Beat-Ende) */
function maxPos() {
  const d = songDuration();
  if (S.trimMode && E.beatBuf && S.song && S.song.beat) return Math.max(d, (E.beatBuf.duration - (S.song.beat.trim || 0)) / beatRate());
  return d;
}

function songDuration() {
  const s = S.song;
  if (!s) return 0;
  let d = 0;
  if (s.beat) d = Math.max(d, (beatEnd(s) - (s.beat.trim || 0)) / beatRate(s));
  for (const t of s.takes) d = Math.max(d, t.offset + (t.duration || 0));
  if (S.recording && Rec.startPos != null) d = Math.max(d, getPos());
  return Math.max(0, d);
}

function getPos() {
  if (!S.playing || !E.ctx) return S.pos;
  return E.startPos + (E.ctx.currentTime - E.startCtx);
}

/* Beat stumm? (Mute, oder eine andere Spur ist Solo) */
function beatSilent(s) { return s.beatMuted || (anySolo() && !s.beatSolo); }

function anySolo() {
  return !!(S.song && (S.song.beatSolo || S.song.takes.some((t) => t.solo)));
}

/* Lautstärken live anwenden (Beat-Volume, Mute, Solo, Take-Gain) */
function applyMix() {
  if (!E.ctx || !S.song) return;
  const s = S.song;
  const solo = anySolo();
  const now = E.ctx.currentTime;
  let beatVol = beatSilent(s) ? 0 : beatGainValue(s);
  if (S.recording && Settings.duckOnRec) beatVol *= 0.6;
  E.beatGain.gain.setTargetAtTime(beatVol, now, 0.015);
  for (const t of s.takes) {
    const node = E.takes.get(t.id);
    if (!node || !node.gain) continue;
    let g = takeGainValue(t);
    if (t.muted || (solo && !t.solo)) g = 0;
    node.gain.gain.setTargetAtTime(g, now, 0.015);
  }
}

function ensureTakeNodes(takeId) {
  ensureCtx();
  let n = E.takes.get(takeId);
  if (!n) { n = {}; E.takes.set(takeId, n); }
  if (!n.gain) {
    // Quelle → input → [FX: EQ → Kompressor] → gain (Fader) → analyser → master
    //                                          gain → Hall-Send / Echo-Send (nach dem Fader)
    n.input = E.ctx.createGain();
    n.gain = E.ctx.createGain();
    n.analyser = E.ctx.createAnalyser();
    n.analyser.fftSize = 1024;
    n.gain.connect(n.analyser);
    n.analyser.connect(E.master);
    n.fx = buildFxNodes(E.ctx, n.gain);
    ensureFxBuses();
    n.revSend = E.ctx.createGain(); n.revSend.gain.value = 0;
    n.dlySend = E.ctx.createGain(); n.dlySend.gain.value = 0;
    n.gain.connect(n.revSend); n.revSend.connect(E.revIn);
    n.gain.connect(n.dlySend); n.dlySend.connect(E.dlyIn);
    n.input.connect(n.gain);
    n.fxWired = false;
    const t = S.song && S.song.takes.find((x) => x.id === takeId);
    if (t) applyTakeFx(t);
  }
  return n;
}

function stopSources() {
  for (const src of E.sources) {
    try { src.onended = null; src.stop(); } catch {}
    try { src.disconnect(); } catch {}
  }
  E.sources = [];
}

/*
  play(from, preroll):
  Startet Beat + alle Takes sample-genau ab Position "from".
  preroll = Sekunden Vorlauf (fürs Einzählen).
*/
async function play(from = S.pos, preroll = 0) {
  await unlockAudio();
  const ctx = E.ctx;
  stopSources();
  const s = S.song;
  if (!s) return;

  from = Math.max(0, from);
  const when = ctx.currentTime + 0.05 + preroll;
  E.startCtx = when;
  E.startPos = from;

  // Beat
  if (E.beatBuf && s.beat) {
    const R = beatRate(s), trim = s.beat.trim || 0;
    const bOff = trim + from * R;              // Position im Original-Beat
    const bEnd = beatEnd(s);
    const remain = (bEnd - bOff) / R;          // restliche Song-Zeit
    if (remain > 0.01) {
      const src = ctx.createBufferSource();
      const baked = E.beatProc && E.beatProc.key === procKey(s) ? E.beatProc.buf : null;
      if (baked) {
        // fertig bearbeiteter Beat (Tempo/Tonart eingerechnet)
        src.buffer = baked;
        src.start(when, bOff / R);
      } else {
        // Vorschau, bis die Bearbeitung fertig ist (Tonhöhe ändert kurz mit)
        src.buffer = E.beatBuf;
        src.playbackRate.value = R;
        src.start(when, bOff);
      }
      src.stop(when + remain);
      src.connect(E.beatGain);
      E.sources.push(src);
    }
  }

  // Takes
  for (const t of s.takes) {
    const n = E.takes.get(t.id);
    if (!n || !n.buf) continue;
    const rel = from - t.offset;
    if (rel >= n.buf.duration) continue;
    const nodes = ensureTakeNodes(t.id);
    const src = ctx.createBufferSource();
    src.buffer = takePlayBuffer(t, n);
    src.connect(nodes.input);
    if (rel >= 0) src.start(when, rel);
    else src.start(when - rel, 0);
    E.sources.push(src);
  }

  S.playing = true;
  applyMix();
  if (ctx.state !== "running") {
    toast("Ton wird aktiviert – falls still: nochmal auf Play tippen");
  } else if (!Settings.muteHintShown && /iPhone|iPad|iPod/.test(navigator.userAgent)) {
    Settings.muteHintShown = true; saveSettings();
    toast("Kein Ton? Lautstärke-Tasten und Stumm-Schalter prüfen", 3500);
  }
  startMetronome(preroll > 0);
  startLoop();
  updatePlayButtons();
}

function pause() {
  if (!S.playing) return;
  S.pos = Math.max(0, getPos());
  S.playing = false;
  stopSources();
  stopMetronome();
  updatePlayButtons();
  renderAll();
}

function seek(t) {
  if (S.recording) return; // während der Aufnahme nicht spulen
  const d = songDuration();
  t = clamp(t, minPos(), Math.max(maxPos(), 0));
  if (S.playing) play(t);
  else { S.pos = t; renderAll(); }
}

async function togglePlay() {
  if (S.recording) { stopRecording(); pause(); return; }
  if (S.playing) { pause(); return; }
  const d = songDuration();
  if (d <= 0) { toast("Noch nichts zum Abspielen – lade einen Beat oder nimm auf."); return; }
  if (S.pos >= d - 0.05) S.pos = 0;
  const loopSec = getLoopSection();
  if (loopSec) {
    const r = sectionRange(loopSec);
    if (S.pos < r.start || S.pos >= r.end) S.pos = r.start;
  }
  haptic();
  await play(S.pos);
}

/* ---------- Metronom (lila wenn an) ---------- */
function beatLen() {
  const s = S.song;
  const bpm = s ? (s.bpmExact || s.bpm || 0) : 0;
  return bpm > 0 ? 60 / bpm : 0;
}
/* Taktraster: wo liegt "die 1" (Song-Zeit, Sekunden) */
function gridOffset() {
  const s = S.song;
  const spb = beatLen();
  if (!s || !spb) return 0;
  const bar = spb * 4;
  const off = s.gridOffset || 0;
  let o = ((off % bar) + bar) % bar; // erste 1 ab 0:00
  if (o > bar - 0.08) o -= bar;       // "fast 0" = 0
  return o;
}
function barInfo(t) {
  const spb = beatLen();
  if (!spb) return null;
  const off = gridOffset();
  const n = Math.floor((t - off) / spb + 0.01);
  if (n < 0) return { bar: 0, beat: 4 + (n % 4 || 0) + 1, pickup: true };
  return { bar: Math.floor(n / 4) + 1, beat: (n % 4) + 1, pickup: false };
}
function barLabel(t) {
  const b = barInfo(t);
  if (!b) return "";
  return b.pickup ? "Auftakt" : `Takt ${b.bar}.${b.beat}`;
}
/* Zeit auf den nächsten Taktanfang einrasten */
function snapToBar(t) {
  const s = S.song;
  const spb = beatLen();
  if (!s || !spb || s.snap === false) return t;
  const bar = spb * 4, off = gridOffset();
  const n = Math.round((t - off) / bar);
  if (n <= 0 && t < off) return 0;
  return Math.max(0, off + n * bar);
}

function startMetronome(withCountIn) {
  stopMetronome();
  const spb = beatLen();
  if (!spb) return;
  const s = S.song;
  if (!s.metronome && !withCountIn) return;
  // Position beim Start (kann beim Einzählen negativ sein)
  const posNow = E.startPos + (E.ctx.currentTime - E.startCtx);
  const off = gridOffset();
  E.metroNextBeat = Math.ceil((posNow - off - 0.001) / spb);
  const countInFrom = withCountIn ? E.metroNextBeat : null;
  const countInTo = withCountIn ? Math.ceil((E.startPos - off) / spb - 0.0001) - 1 : null;

  const tick = () => {
    if (!S.playing || !E.ctx) return;
    const horizon = E.ctx.currentTime + 0.12;
    while (true) {
      const songT = off + E.metroNextBeat * spb;
      const ctxT = E.startCtx + (songT - E.startPos);
      if (ctxT > horizon) break;
      const isCountIn = countInFrom != null && E.metroNextBeat >= countInFrom && E.metroNextBeat <= countInTo && songT < E.startPos;
      if (ctxT >= E.ctx.currentTime - 0.01 && (S.song.metronome || isCountIn)) {
        scheduleClick(ctxT, ((E.metroNextBeat % 4) + 4) % 4 === 0, isCountIn);
      }
      E.metroNextBeat++;
    }
  };
  tick();
  E.metroTimer = setInterval(tick, 25);
}

function stopMetronome() {
  if (E.metroTimer) clearInterval(E.metroTimer);
  E.metroTimer = 0;
}

function scheduleClick(time, accent, countIn) {
  const ctx = E.ctx;
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.frequency.setValueAtTime(accent ? 1500 : 1000, time);
  if (countIn) osc.frequency.setValueAtTime(accent ? 1760 : 1320, time);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.55, time + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  osc.connect(g); g.connect(E.metroGain);
  osc.start(time); osc.stop(time + 0.06);
  // Knopf pulsiert im Takt
  const delay = Math.max(0, (time - ctx.currentTime) * 1000);
  setTimeout(() => {
    const b = $("#dock-metro");
    b.classList.add("tick");
    setTimeout(() => b.classList.remove("tick"), 90);
  }, delay);
}

function toggleMetronome() {
  const s = S.song;
  if (!s) return;
  if (!s.bpm) {
    toast("Zuerst BPM setzen – tippe oben auf BPM.");
    openBpmSheet();
    return;
  }
  s.metronome = !s.metronome;
  haptic();
  updateMetroButton();
  if (S.playing) {
    if (s.metronome) startMetronome(false);
    else stopMetronome();
  }
  saveSong();
}

function updateMetroButton() {
  $("#dock-metro").classList.toggle("on", !!(S.song && S.song.metronome));
}

/* ---------- Haupt-Schleife beim Abspielen ---------- */
function startLoop() {
  cancelAnimationFrame(E.raf);
  const frame = () => {
    if (!S.playing) return;
    const pos = getPos();
    const d = songDuration();

    // Loop-Teil
    const loopSec = getLoopSection();
    if (loopSec && !S.recording) {
      const r = sectionRange(loopSec);
      if (pos >= r.end - 0.01) { play(r.start); return; }
    }
    // Ende erreicht
    if (!S.recording && pos >= d && d > 0) {
      pause();
      S.pos = d;
      renderAll();
      return;
    }
    if (S.recording) Rec.onFrame(pos);
    renderFrame(pos);
    E.raf = requestAnimationFrame(frame);
  };
  E.raf = requestAnimationFrame(frame);
}

/* ===================== 5. AUFNAHME ===================== */
const Rec = {
  stream: null,
  recorder: null,
  chunks: [],
  mime: "",
  startPos: null,       // Song-Position beim Start der Aufnahme
  recCtxStart: 0,
  micSource: null,
  micAnalyser: null,
  livePeaks: [],        // [{t, v}] für die Live-Wellenform
  peakHold: 0,
  peakHoldTime: 0,
  maxLevel: 0,

  pickMime() {
    if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return "";
    const list = ["audio/mp4", "audio/webm;codecs=opus", "audio/webm", "audio/aac", "audio/ogg;codecs=opus"];
    return list.find((m) => { try { return MediaRecorder.isTypeSupported(m); } catch { return false; } }) || "";
  },

  onFrame(pos) {
    if (!this.micAnalyser) return;
    const buf = new Float32Array(this.micAnalyser.fftSize);
    this.micAnalyser.getFloatTimeDomainData(buf);
    let peak = 0;
    for (let i = 0; i < buf.length; i++) { const a = Math.abs(buf[i]); if (a > peak) peak = a; }
    this.maxLevel = Math.max(this.maxLevel, peak);
    this.livePeaks.push({ t: pos, v: peak });
    updateMeter(peak, "rec");
  },
};

function latencySeconds() {
  let lat = 0;
  if (E.ctx) lat += (E.ctx.baseLatency || 0) + (E.ctx.outputLatency || 0);
  try {
    const tr = Rec.stream && Rec.stream.getAudioTracks()[0];
    const st = tr && tr.getSettings ? tr.getSettings() : null;
    if (st && typeof st.latency === "number") lat += st.latency;
  } catch {}
  return lat + (Settings.latencyMs || 0) / 1000;
}

async function toggleRecord() {
  if (S.recording) { stopRecording(); return; }
  await startRecording();
}

async function startRecording() {
  if (!S.song) return;
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder) {
    sheetAlert("Aufnahme nicht möglich", "Dieser Browser kann nicht aufnehmen. Öffne Flowcess in Safari (iPhone) oder Chrome.");
    return;
  }
  const btns = $$(".rec-btn");
  btns.forEach((b) => b.classList.add("armed"));
  try {
    setAudioSessionType("play-and-record");
    await unlockAudio();
    Rec.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
    });
  } catch (err) {
    btns.forEach((b) => b.classList.remove("armed"));
    setAudioSessionType("playback");
    console.warn(err);
    openSheet((root) => {
      sheetHeader(root, "Kein Mikrofon-Zugriff", "Erlaube Flowcess das Mikrofon: Einstellungen › Safari › Mikrofon. In der Claude-Vorschau ist das Mikrofon immer gesperrt – dort kannst du stattdessen eine Audiodatei als Take laden.");
      root.appendChild(el("div", { class: "sheet-group" }, [sheetItem("mic", "Audiodatei als Take laden", pickTakeFile)]));
      sheetCancel(root, "OK");
    });
    return;
  }

  // Mikrofon-Pegel (MediaStreamSource – nicht MediaElementSource)
  try {
    if (E.ctx.state !== "running") await E.ctx.resume();
    Rec.micSource = E.ctx.createMediaStreamSource(Rec.stream);
    Rec.micAnalyser = E.ctx.createAnalyser();
    Rec.micAnalyser.fftSize = 1024;
    const silent = E.ctx.createGain();
    silent.gain.value = 0;
    Rec.micSource.connect(Rec.micAnalyser);
    Rec.micAnalyser.connect(silent);
    silent.connect(E.ctx.destination);
    Rec._silent = silent;
  } catch (err) { console.warn("Mic-Meter", err); }

  Rec.mime = Rec.pickMime();
  try {
    Rec.recorder = Rec.mime ? new MediaRecorder(Rec.stream, { mimeType: Rec.mime }) : new MediaRecorder(Rec.stream);
  } catch {
    Rec.recorder = new MediaRecorder(Rec.stream);
  }
  Rec.chunks = [];
  Rec.livePeaks = [];
  Rec.maxLevel = 0;
  Rec.recorder.ondataavailable = (e) => { if (e.data && e.data.size) Rec.chunks.push(e.data); };
  Rec.recorder.onstop = finishRecording;
  Rec.recorder.onerror = (e) => { console.warn("Recorder-Fehler", e); toast("Aufnahme-Fehler – bitte nochmal versuchen."); };

  // Startposition: Playhead (Loop-Teil beachten)
  let from = S.playing ? getPos() : S.pos;
  // Am Ende des Beats? Dann von vorne aufnehmen
  if (!S.playing && E.beatBuf && from >= songDuration() - 0.05) from = 0;
  const preroll = Settings.countIn && beatLen() ? beatLen() * 4 : 0;

  S.recording = true;
  Rec.startPos = from;
  Rec.recStartSongPos = from;
  Rec.peakHold = 0;
  btns.forEach((b) => { b.classList.remove("armed"); b.classList.add("recording"); });
  $("#dock").classList.add("is-rec");
  $("#rec-meter").classList.remove("hidden");
  $("#live-meter").classList.remove("hidden");
  haptic(15);

  // Transport (neu) starten – der Beat läuft mit
  await play(from, preroll);
  Rec.recCtxStart = E.ctx.currentTime;
  try { Rec.recorder.start(); } catch (err) { console.warn(err); }
  // Song-Position, die in dem Moment erklingt, in dem der Recorder startet
  Rec.recStartSongPos = E.startPos + (E.ctx.currentTime - E.startCtx);
  applyMix();
}

function stopRecording() {
  if (!S.recording) return;
  S.recording = false;
  haptic(15);
  try { if (Rec.recorder && Rec.recorder.state !== "inactive") Rec.recorder.stop(); } catch (err) { console.warn(err); finishRecording(); }
  $$(".rec-btn").forEach((b) => b.classList.remove("recording", "armed"));
  $("#dock").classList.remove("is-rec");
  $("#rec-meter").classList.add("hidden");
  $("#live-meter").classList.add("hidden");
  applyMix(); // Ducking aus – Beat läuft weiter
}

async function finishRecording() {
  const chunks = Rec.chunks.slice();
  Rec.chunks = [];
  // Mikrofon freigeben (orangener Punkt verschwindet)
  try { Rec.stream && Rec.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { Rec.micSource && Rec.micSource.disconnect(); Rec._silent && Rec._silent.disconnect(); } catch {}
  Rec.stream = null; Rec.micSource = null; Rec.micAnalyser = null;
  setAudioSessionType("playback");

  const livePeaks = Rec.livePeaks;
  Rec.livePeaks = [];
  const startSongPos = Rec.recStartSongPos != null ? Rec.recStartSongPos : Rec.startPos || 0;
  Rec.startPos = null;

  if (!chunks.length) {
    toast("Es wurde nichts aufgenommen. Mikrofon-Erlaubnis prüfen.");
    renderAll();
    return;
  }
  const type = (Rec.recorder && Rec.recorder.mimeType) || Rec.mime || "audio/mp4";
  const blob = new Blob(chunks, { type });
  const s = S.song;
  const take = {
    id: uid(),
    name: nextTakeName(),
    offset: Math.round((startSongPos - latencySeconds()) * 1000) / 1000,
    duration: 0,
    gainDb: 0,
    muted: false,
    solo: false,
    mime: type,
    createdAt: Date.now(),
    color: TAKE_COLORS[s.takes.length % TAKE_COLORS.length],
    clean: null,
    level: Rec.maxLevel,
  };

  try {
    await Store.putBlob(`take:${take.id}`, blob);
  } catch (err) {
    console.warn("Take speichern", err);
    toast("Take konnte nicht dauerhaft gespeichert werden.");
  }

  try {
    ensureCtx();
    const buf = await decodeBlob(blob);
    take.duration = buf.duration;
    const n = ensureTakeNodes(take.id);
    n.buf = buf;
    n.peaks = computePeaks(buf);
  } catch (err) {
    console.warn("Take dekodieren", err);
    // Grobe Dauer aus der Live-Wellenform
    take.duration = livePeaks.length ? livePeaks[livePeaks.length - 1].t - startSongPos : 0;
    const n = ensureTakeNodes(take.id);
    n.peaks = null;
    toast("Take gespeichert, kann aber in diesem Browser nicht abgespielt werden.");
  }

  s.takes.push(take);
  S.selTakeId = take.id;
  // Falls gerade abgespielt wird: Take ab sofort mitspielen
  if (S.playing) play(getPos());
  saveSongNow();
  renderTracks();
  renderAll();
  toast(`${take.name} gespeichert`);
}

/* Audiodatei (z. B. Sprachmemo) als Take ab Playhead einfügen */
function pickTakeFile() {
  const inp = $("#take-input");
  inp.value = "";
  inp.click();
}

async function onTakeFile(file) {
  if (!file || !S.song) return;
  const s = S.song;
  try {
    ensureCtx();
    const buf = await decodeBlob(file);
    const take = {
      id: uid(), name: file.name.replace(/\.[^.]+$/, "").slice(0, 40) || nextTakeName(),
      offset: Math.round(Math.max(0, getPos()) * 1000) / 1000, duration: buf.duration,
      gainDb: 0, muted: false, solo: false, mime: file.type, createdAt: Date.now(),
      color: TAKE_COLORS[s.takes.length % TAKE_COLORS.length], clean: null, level: 1,
    };
    await Store.putBlob(`take:${take.id}`, file);
    const n = ensureTakeNodes(take.id);
    n.buf = buf; n.peaks = computePeaks(buf);
    s.takes.push(take);
    S.selTakeId = take.id;
    if (S.playing) play(getPos());
    applyMix(); saveSongNow(); renderTracks(); renderAll();
    toast(`${take.name} hinzugefügt`);
  } catch (err) {
    console.warn(err);
    sheetAlert("Datei kann nicht gelesen werden", "Versuch es mit M4A, MP3 oder WAV.");
  }
}

function nextTakeName() {
  const names = new Set(S.song.takes.map((t) => t.name));
  let n = S.song.takes.length + 1;
  while (names.has(`Take ${n}`)) n++;
  return `Take ${n}`;
}

function updateMeter(peak, which) {
  const db = gainToDb(peak);
  // -60 dB .. 0 dB → 0..100 %
  const pct = clamp(((db + 60) / 60) * 100, 0, 100);
  if (which === "rec") {
    const now = performance.now();
    if (pct > Rec.peakHold || now - Rec.peakHoldTime > 1200) { Rec.peakHold = pct; Rec.peakHoldTime = now; }
    const fill = $("#rec-meter-fill");
    fill.style.setProperty("--lvl", pct + "%");
    $("#rec-meter-peak").style.setProperty("--pk", Rec.peakHold + "%");
    $("#live-meter-fill").style.setProperty("--lvl", pct + "%");
    $("#rec-meter-db").textContent = isFinite(db) ? `${db.toFixed(1)} dB` : "–∞ dB";
    const t = Math.max(0, getPos() - (Rec.recStartSongPos || 0));
    $("#rec-meter-label").textContent = `REC ${fmtTime(t)}`;
  }
}

/* ===================== 6. ANALYSE ===================== */
async function decodeBlob(blob) {
  const ctx = ensureCtx();
  const ab = await blob.arrayBuffer();
  return await new Promise((resolve, reject) => {
    // Callback-Variante: funktioniert auch auf älteren iPhones
    const p = ctx.decodeAudioData(ab, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
}

const PEAKS_PER_SEC = 100;
function computePeaks(buf) {
  const sr = buf.sampleRate;
  const hop = Math.max(1, Math.floor(sr / PEAKS_PER_SEC));
  const n = Math.ceil(buf.length / hop);
  const out = new Float32Array(n);
  const chs = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  for (let i = 0; i < n; i++) {
    let m = 0;
    const a = i * hop, b = Math.min(buf.length, a + hop);
    for (const ch of chs) {
      for (let j = a; j < b; j += 4) { const v = Math.abs(ch[j]); if (v > m) m = v; }
    }
    out[i] = m;
  }
  // normalisieren, damit leise Beats auch sichtbar sind
  let max = 0;
  for (let i = 0; i < n; i++) if (out[i] > max) max = out[i];
  if (max > 0) { const f = 0.95 / max; for (let i = 0; i < n; i++) out[i] *= f; }
  out.rawMax = max;
  return out;
}

function mixChannels(a, b) {
  const len = Math.min(a.length, b.length);
  const out = new Float32Array(len);
  for (let i = 0; i < len; i++) out[i] = (a[i] + b[i]) * 0.5;
  return out;
}

/* BPM-Erkennung (aus der alten, stabilen Version übernommen) */
function estimateBpm(audioBuffer, fromSec) {
  const sr = audioBuffer.sampleRate;
  const ch = audioBuffer.numberOfChannels > 1
    ? mixChannels(audioBuffer.getChannelData(0), audioBuffer.getChannelData(1))
    : audioBuffer.getChannelData(0);
  // ab dem ersten Ton analysieren (Stille am Anfang ignorieren)
  const st = Math.floor(sr * (fromSec != null ? fromSec : detectSilence(audioBuffer).start));
  const data = ch.subarray(st, Math.min(ch.length, st + sr * 30));
  const hop = Math.max(1, Math.floor(sr / 100));
  const envLen = Math.floor(data.length / hop);
  const env = new Float32Array(envLen);
  for (let i = 0; i < envLen; i++) {
    let s = 0;
    for (let j = 0; j < hop; j++) { const v = data[i * hop + j] || 0; s += v * v; }
    env[i] = Math.sqrt(s / hop);
  }
  const onset = new Float32Array(envLen);
  for (let i = 1; i < envLen; i++) onset[i] = Math.max(0, env[i] - env[i - 1]);
  const minLag = Math.round((60 / 190) * 100);
  const maxLag = Math.round((60 / 55) * 100);
  let bestLag = 0, bestVal = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i + lag < envLen; i++) sum += onset[i] * onset[i + lag];
    if (sum > bestVal) { bestVal = sum; bestLag = lag; }
  }
  if (!bestLag) return 0;
  let bpm = 60 / (bestLag / 100);
  while (bpm < 75) bpm *= 2;
  while (bpm > 170) bpm /= 2;
  return Math.round(bpm);
}

/*
  Taktraster erkennen:
  1) Tempo genau bestimmen (±1.5 BPM um die Schätzung, 0.02er Schritte)
  2) Phase: wo liegen die Schläge
  3) Downbeat: welcher der 4 Schläge ist "die 1" (Bass/Kick + Akkordwechsel)
*/
function analyzeGrid(buf, bpmGuess) {
  try {
    const sr = buf.sampleRate;
    const L = buf.getChannelData(0);
    const R = buf.numberOfChannels > 1 ? buf.getChannelData(1) : L;
    const maxS = Math.min(buf.length, sr * 240);
    const hop = Math.floor(sr / 100); // 100 Frames pro Sekunde
    const n = Math.floor(maxS / hop);
    const full = new Float32Array(n), low = new Float32Array(n);
    let lp = 0;
    const a = 1 - Math.exp(-2 * Math.PI * 150 / sr); // Tiefpass ~150 Hz
    for (let i = 0; i < n; i++) {
      let ef = 0, el2 = 0;
      for (let j = i * hop, e = j + hop; j < e; j++) {
        const x = (L[j] + R[j]) * 0.5;
        lp += a * (x - lp);
        ef += x * x; el2 += lp * lp;
      }
      full[i] = Math.log(1 + 1000 * Math.sqrt(ef / hop));
      low[i] = Math.log(1 + 1000 * Math.sqrt(el2 / hop));
    }
    const onF = new Float32Array(n), onL = new Float32Array(n);
    for (let i = 1; i < n; i++) { onF[i] = Math.max(0, full[i] - full[i - 1]); onL[i] = Math.max(0, low[i] - low[i - 1]); }
    const on = new Float32Array(n);
    for (let i = 0; i < n; i++) on[i] = onF[i] + onL[i];

    const combScore = (period, phase) => {
      let sum = 0, cnt = 0;
      for (let t = phase; t < n - 1; t += period) {
        const k = Math.round(t);
        sum += Math.max(on[k], on[k - 1] || 0, on[k + 1] || 0);
        cnt++;
      }
      return cnt ? sum / cnt : 0;
    };
    let best = { score: -1, bpm: bpmGuess, phase: 0 };
    for (let bpm = bpmGuess - 1.5; bpm <= bpmGuess + 1.5; bpm += 0.02) {
      const period = 6000 / bpm;
      for (let ph = 0; ph < period; ph += 1) {
        const sc = combScore(period, ph);
        if (sc > best.score) best = { score: sc, bpm, phase: ph };
      }
    }
    const period = 6000 / best.bpm;
    // Downbeat: Schlag mit meisten Bass-Einsätzen + Akkordwechseln
    const scores = [0, 0, 0, 0];
    let k = 0;
    for (let t = best.phase; t < n - 1; t += period, k++) {
      const i = Math.round(t);
      scores[k % 4] += 1.0 * Math.max(onL[i], onL[i + 1] || 0) + 0.6 * Math.max(onF[i], onF[i + 1] || 0);
    }
    // Takt 1 = erster Ton des Beats (Beats sind fast immer ab Takt 1 exportiert)
    const firstTone = detectSilence(buf).start + 0.01; // Sekunden
    const i0 = firstTone * 100;
    const kFirst = Math.round((i0 - best.phase) / period);
    let down = ((kFirst % 4) + 4) % 4;
    const barFrames = period * 4;
    let offFrames = best.phase + down * period;
    // liegt der erste Ton genau auf einem Schlag: exakt dort einrasten
    const nearest = best.phase + kFirst * period;
    if (Math.abs(nearest - i0) < 6) offFrames = i0;
    offFrames = ((offFrames % barFrames) + barFrames) % barFrames;
    return { bpm: Math.round(best.bpm * 100) / 100, offset: offFrames / 100, firstTone };
  } catch (err) {
    console.warn("Taktraster", err);
    return null;
  }
}

function fftReal(input) {
  const n = input.length;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let i = 0; i < n; i++) real[i] = input[i];
  let j = 0;
  for (let i = 1; i < n; i++) {
    let bit = n >> 1;
    while (j & bit) { j ^= bit; bit >>= 1; }
    j ^= bit;
    if (i < j) { let t = real[i]; real[i] = real[j]; real[j] = t; t = imag[i]; imag[i] = imag[j]; imag[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr0 = Math.cos(ang), wi0 = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wr = 1, wi = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2;
        const vr = real[b] * wr - imag[b] * wi;
        const vi = real[b] * wi + imag[b] * wr;
        real[b] = real[a] - vr; imag[b] = imag[a] - vi;
        real[a] += vr; imag[a] += vi;
        const nwr = wr * wr0 - wi * wi0;
        wi = wr * wi0 + wi * wr0; wr = nwr;
      }
    }
  }
  return { real, imag };
}

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/* Tonart-Erkennung (Krumhansl-Schmuckler, aus der alten Version) */
function estimateKey(audioBuffer) {
  try {
    const sr = audioBuffer.sampleRate;
    const majorProfile = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
    const minorProfile = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
    const left = audioBuffer.getChannelData(0);
    const right = audioBuffer.numberOfChannels > 1 ? audioBuffer.getChannelData(1) : null;
    const fftSize = 4096;
    const hop = Math.floor(sr * 0.25);
    const start = Math.min(Math.floor(sr * 3), Math.max(0, audioBuffer.length - fftSize * 4));
    const end = Math.min(audioBuffer.length - fftSize, Math.floor(sr * 75));
    const chroma = new Float32Array(12);
    let used = 0;
    const win = new Float32Array(fftSize);
    for (let i = 0; i < fftSize; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
    const minBin = Math.max(1, Math.floor(90 * fftSize / sr));
    const maxBin = Math.min(Math.floor(5000 * fftSize / sr), fftSize / 2);
    const binPc = new Int8Array(maxBin + 1);
    const binW = new Float32Array(maxBin + 1);
    for (let bin = minBin; bin <= maxBin; bin++) {
      const f = bin * sr / fftSize;
      const midi = Math.round(69 + 12 * Math.log2(f / 440));
      binPc[bin] = ((midi % 12) + 12) % 12;
      binW[bin] = f < 160 ? 0.45 : f > 2500 ? 0.55 : 1;
    }
    for (let pos = start; pos < end; pos += hop) {
      const frame = new Float32Array(fftSize);
      let rms = 0;
      for (let i = 0; i < fftSize; i++) {
        const smp = right ? (left[pos + i] + right[pos + i]) * 0.5 : left[pos + i];
        frame[i] = smp * win[i];
        rms += frame[i] * frame[i];
      }
      rms = Math.sqrt(rms / fftSize);
      if (rms < 0.012) continue;
      const sp = fftReal(frame);
      const fc = new Float32Array(12);
      let energy = 0;
      for (let bin = minBin; bin <= maxBin; bin++) {
        const mag = Math.hypot(sp.real[bin], sp.imag[bin]);
        if (mag <= 0.0001) continue;
        const w = mag * binW[bin];
        fc[binPc[bin]] += w; energy += w;
      }
      if (energy <= 0) continue;
      for (let i = 0; i < 12; i++) chroma[i] += fc[i] / energy;
      used++;
    }
    if (used < 3) return "";
    const sm = new Float32Array(12);
    for (let i = 0; i < 12; i++) sm[i] = chroma[i] + chroma[(i + 11) % 12] * 0.18 + chroma[(i + 1) % 12] * 0.18;
    const score = (p, root) => { let s = 0; for (let i = 0; i < 12; i++) s += sm[(root + i) % 12] * p[i]; return s; };
    let best = -Infinity, bestKey = "";
    for (let r = 0; r < 12; r++) {
      const maj = score(majorProfile, r), min = score(minorProfile, r);
      if (maj > best) { best = maj; bestKey = NOTE_NAMES[r]; }
      if (min > best) { best = min; bestKey = NOTE_NAMES[r] + "m"; }
    }
    return bestKey;
  } catch (err) {
    console.warn("Tonart-Erkennung", err);
    return "";
  }
}

/* ===================== TEMPO & TONART ÄNDERN (Time-Stretch / Pitch-Shift) =====================
   Tempo ändern  → Beat schneller/langsamer, Tonart bleibt (WSOLA)
   Tonart ändern → Beat höher/tiefer in Halbtönen, Tempo bleibt (Stretch + Resampling)
   Läuft in einem Hintergrund-Worker, damit die App nicht hängt.
*/
const STRETCH_WORKER_SRC = `
self.onmessage = (ev) => {
  const { id, chs, stretch, pitch } = ev.data;
  const len = chs[0].length;
  const N = 1024, Hs = 512, Ha = Hs / stretch;
  const DEC = 8;
  // Mono, 8x verkleinert – nur für die Suche nach der besten Stelle
  const mdLen = Math.floor(len / DEC);
  const md = new Float32Array(mdLen);
  for (let i = 0; i < mdLen; i++) {
    let v = 0;
    for (let c = 0; c < chs.length; c++) { const a = chs[c]; for (let j = 0; j < DEC; j++) v += a[i * DEC + j]; }
    md[i] = v;
  }
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const outLen = Math.ceil(len * stretch);
  const outs = chs.map(() => new Float32Array(outLen + N));
  const norm = new Float32Array(outLen + N);
  const LD = (N / 2) / DEC, TOL = 48;
  let prev = 0, lastReport = 0;
  const frames = Math.ceil(outLen / Hs);
  for (let k = 0; k < frames; k++) {
    const outPos = k * Hs;
    const nominal = Math.round(k * Ha);
    let best = nominal;
    if (k > 0) {
      const tn = Math.floor((prev + Hs) / DEC);
      const nc = Math.floor(nominal / DEC);
      let bestScore = -Infinity, bestC = nc;
      for (let d = -TOL; d <= TOL; d++) {
        const c = nc + d;
        if (c < 0 || c + LD >= mdLen || tn + LD >= mdLen) continue;
        let sc = 0, en = 1e-9;
        for (let i = 0; i < LD; i++) { const x = md[c + i]; sc += x * md[tn + i]; en += x * x; }
        sc /= Math.sqrt(en);
        if (sc > bestScore) { bestScore = sc; bestC = c; }
      }
      best = bestC * DEC;
      // Feinsuche in voller Auflösung
      const tf = prev + Hs, ch0 = chs[0];
      let fb = best, fs = -Infinity;
      for (let d = -DEC; d <= DEC; d++) {
        const c = best + d;
        if (c < 0 || c + 256 >= len || tf + 256 >= len) continue;
        let sc = 0;
        for (let i = 0; i < 256; i += 2) sc += ch0[c + i] * ch0[tf + i];
        if (sc > fs) { fs = sc; fb = c; }
      }
      best = fb;
    }
    if (best < 0) best = 0;
    for (let c = 0; c < chs.length; c++) {
      const src = chs[c], dst = outs[c];
      for (let i = 0; i < N; i++) { const si = best + i; if (si < len) dst[outPos + i] += src[si] * win[i]; }
    }
    for (let i = 0; i < N; i++) norm[outPos + i] += win[i];
    prev = best;
    if (k - lastReport > 400) { lastReport = k; self.postMessage({ id, progress: pitch === 1 ? k / frames : 0.85 * k / frames }); }
  }
  for (let c = 0; c < outs.length; c++) {
    const d = outs[c];
    for (let i = 0; i < outLen; i++) d[i] = norm[i] > 0.05 ? d[i] / norm[i] : d[i];
  }
  let res = outs.map((d) => d.subarray(0, outLen));
  // Tonhöhe: wieder auf Original-Länge zusammenrechnen (kubische Interpolation)
  if (pitch !== 1) {
    const n2 = Math.floor(outLen / pitch);
    res = res.map((d) => {
      const o = new Float32Array(n2);
      for (let i = 0; i < n2; i++) {
        const x = i * pitch, i1 = Math.floor(x), f = x - i1;
        const y0 = d[i1 - 1] || 0, y1 = d[i1] || 0, y2 = d[i1 + 1] || 0, y3 = d[i1 + 2] || 0;
        o[i] = y1 + 0.5 * f * (y2 - y0 + f * (2 * y0 - 5 * y1 + 4 * y2 - y3 + f * (3 * (y1 - y2) + y3 - y0)));
      }
      return o;
    });
  }
  self.postMessage({ id, done: true, chs: res }, res.map((d) => d.buffer));
};
`;

let stretchWorker = null, stretchJob = 0;
const procCache = new Map();

function procKey(s = S.song) {
  return `${beatRate(s).toFixed(4)}|${(s && s.transpose) || 0}`;
}

function transposeKey(key, n) {
  const m = /^([A-G]#?)(m?)$/.exec(key || "");
  if (!m) return key || "";
  return NOTE_NAMES[(((NOTE_NAMES.indexOf(m[1]) + n) % 12) + 12) % 12] + m[2];
}

/* Bearbeiteten Beat bereitstellen (falls Tempo oder Tonart geändert) */
function ensureBeatProcessed() {
  const s = S.song;
  if (!s || !s.beat || !E.beatBuf) return;
  const key = procKey(s);
  if (key === "1.0000|0") { E.beatProc = null; setProcessingUI(false); return; }
  if (E.beatProc && E.beatProc.key === key) return;
  const cacheKey = `${s.id}|${key}|${E.beatBuf.length}`;
  if (procCache.has(cacheKey)) { E.beatProc = { key, buf: procCache.get(cacheKey) }; if (S.playing) play(getPos()); return; }

  const R = beatRate(s), P = Math.pow(2, (s.transpose || 0) / 12);
  const chs = [];
  for (let c = 0; c < Math.min(2, E.beatBuf.numberOfChannels); c++) chs.push(E.beatBuf.getChannelData(c).slice());
  const id = ++stretchJob;
  if (stretchWorker) stretchWorker.terminate();
  try {
    stretchWorker = new Worker(URL.createObjectURL(new Blob([STRETCH_WORKER_SRC], { type: "text/javascript" })));
  } catch (err) {
    console.warn(err);
    toast("Anpassen geht in diesem Browser nicht – Vorschau mit Tonhöhe");
    return;
  }
  setProcessingUI(true);
  toast("Beat wird angepasst …", 20000);
  const song = s;
  stretchWorker.onmessage = (ev) => {
    const d = ev.data;
    if (d.id !== stretchJob) return;
    if (d.progress != null) { toast(`Beat wird angepasst … ${Math.round(d.progress * 100)} %`, 20000); return; }
    if (d.done) {
      stretchWorker.terminate(); stretchWorker = null;
      setProcessingUI(false);
      if (S.song !== song || procKey(song) !== key) return;
      const buf = E.ctx.createBuffer(d.chs.length, d.chs[0].length, E.beatBuf.sampleRate);
      d.chs.forEach((a, i) => buf.getChannelData(i).set(a));
      procCache.set(cacheKey, buf);
      E.beatProc = { key, buf };
      if (S.playing && !S.recording) play(getPos());
      toast(`Beat angepasst · ${Math.round(song.bpmExact)} BPM · ${song.key || ""}`);
    }
  };
  stretchWorker.onerror = (e) => { console.warn(e); setProcessingUI(false); toast("Anpassen fehlgeschlagen"); };
  stretchWorker.postMessage({ id, chs, stretch: P / R, pitch: P }, chs.map((c) => c.buffer));
}

function setProcessingUI(on) {
  $("#chip-bpm").classList.toggle("analyzing", on);
  $("#chip-key").classList.toggle("analyzing", on);
}

/* Song-Tempo ändern: Beat wird schneller/langsamer, alles andere rutscht mit */
function setSongTempo(newBpm) {
  const s = S.song;
  if (!s.beat) { s.bpm = Math.round(newBpm); s.bpmExact = newBpm; return; }
  if (!s.beat.origBpm) s.beat.origBpm = s.bpmExact || s.bpm || newBpm;
  const oldR = beatRate(s);
  const newR = newBpm / s.beat.origBpm;
  const f = oldR / newR; // Song-Zeit-Faktor
  const wasPlaying = S.playing;
  if (wasPlaying) pause();
  s.sections.forEach((x) => (x.time = Math.round(x.time * f * 1000) / 1000));
  s.takes.forEach((t) => (t.offset = Math.round(t.offset * f * 1000) / 1000));
  if (s.gridOffset != null) s.gridOffset *= f;
  S.pos *= f;
  s.bpmExact = newBpm;
  s.bpm = Math.round(newBpm);
  saveSong(); renderChips(); renderSections(); renderLyrics(); renderTracks(); renderAll();
  ensureBeatProcessed();
  updateFxTempo();
  if (wasPlaying) play(S.pos);
}

function setTranspose(n) {
  const s = S.song;
  s.transpose = n;
  if (s.beat) {
    if (!s.beat.origKey) s.beat.origKey = s.key || "";
    s.key = transposeKey(s.beat.origKey, n);
  }
  saveSong(); renderChips(); renderTracks();
  ensureBeatProcessed();
  ensureAllTuned();
  if (S.playing && !(E.beatProc && E.beatProc.key === procKey(s))) play(getPos());
}

/* ===================== VOCAL-FX =====================
   EQ + Kompressor (live), Hall + Echo im Takt (live),
   Auto-Tune auf die Tonleiter des Songs (im Hintergrund berechnet).
*/
const FX_PRESETS = {
  clean:   { label: "Clean",     tune: "off",     eq: true, comp: 0.45, reverb: 0.14, delay: 0,    delayNote: "1/8" },
  rap:     { label: "Rap",       tune: "off",     eq: true, comp: 0.75, reverb: 0.10, delay: 0.12, delayNote: "1/8" },
  melodic: { label: "Melodic",   tune: "natural", eq: true, comp: 0.6,  reverb: 0.30, delay: 0.16, delayNote: "1/4" },
  hard:    { label: "Hard Tune", tune: "hard",    eq: true, comp: 0.7,  reverb: 0.24, delay: 0.18, delayNote: "1/8" },
};
const NOTE_VALUES = { "1/16": 0.25, "1/8": 0.5, "1/4": 1, "1/2": 2 };

function defaultFx(preset = "melodic") {
  return Object.assign({ on: true, preset }, JSON.parse(JSON.stringify(FX_PRESETS[preset])));
}

/* EQ + Kompressor-Kette; endet in "dest" */
function buildFxNodes(ctx, dest) {
  const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 90; hp.Q.value = 0.7;
  const mud = ctx.createBiquadFilter(); mud.type = "peaking"; mud.frequency.value = 320; mud.Q.value = 1.1; mud.gain.value = -3;
  const pres = ctx.createBiquadFilter(); pres.type = "peaking"; pres.frequency.value = 3200; pres.Q.value = 0.9; pres.gain.value = 3;
  const air = ctx.createBiquadFilter(); air.type = "highshelf"; air.frequency.value = 10000; air.gain.value = 3;
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -20; comp.ratio.value = 4; comp.attack.value = 0.005; comp.release.value = 0.12; comp.knee.value = 6;
  const makeup = ctx.createGain(); makeup.gain.value = 1.4;
  hp.connect(mud); mud.connect(pres); pres.connect(air); air.connect(comp); comp.connect(makeup); makeup.connect(dest);
  return { first: hp, hp, mud, pres, air, comp, makeup };
}

/* Hall-Impulsantwort (künstlicher Raum) */
function makeReverbIR(ctx, seconds = 2.3) {
  const sr = ctx.sampleRate, len = Math.floor(sr * seconds);
  const ir = ctx.createBuffer(2, len, sr);
  let seed = 3;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let c = 0; c < 2; c++) {
    const d = ir.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      const env = Math.exp(-t * 3.2) * (t < 0.012 ? t / 0.012 : 1);
      lp += 0.35 * (rnd() - lp); // etwas dunkler
      d[i] = lp * env;
    }
  }
  return ir;
}

/* Gemeinsame Hall- und Echo-Busse (für alle Takes) */
function ensureFxBuses() {
  if (E.revIn) return;
  const ctx = E.ctx;
  E.revIn = ctx.createGain();
  E.revPre = ctx.createDelay(1);
  E.revConv = ctx.createConvolver();
  E.revConv.buffer = makeReverbIR(ctx);
  E.revIn.connect(E.revPre); E.revPre.connect(E.revConv); E.revConv.connect(E.master);
  E.dlyIn = ctx.createGain();
  E.dly = ctx.createDelay(4);
  E.dlyFb = ctx.createGain(); E.dlyFb.gain.value = 0.32;
  E.dlyFilt = ctx.createBiquadFilter(); E.dlyFilt.type = "bandpass"; E.dlyFilt.frequency.value = 1800; E.dlyFilt.Q.value = 0.5;
  E.dlyIn.connect(E.dly); E.dly.connect(E.dlyFilt); E.dlyFilt.connect(E.dlyFb); E.dlyFb.connect(E.dly);
  E.dlyFilt.connect(E.master);
  updateFxTempo();
}

/* Echo & Hall-Vorverzögerung an das Tempo anpassen */
function fxTempoTimes(fx) {
  const spb = beatLen() || 0.5;
  return {
    delay: clamp(spb * (NOTE_VALUES[(fx && fx.delayNote) || "1/8"] || 0.5), 0.05, 3.9),
    pre: clamp(spb / 8, 0.005, 0.12), // 1/32-Note
  };
}
function updateFxTempo() {
  if (!E.revIn || !S.song) return;
  // Echo-Zeit vom ersten Take mit Echo (alle Takes teilen sich einen Echo-Bus)
  const t = S.song.takes.find((x) => x.fx && x.fx.on && x.fx.delay > 0);
  const tt = fxTempoTimes(t && t.fx);
  const now = E.ctx.currentTime;
  E.dly.delayTime.setTargetAtTime(tt.delay, now, 0.02);
  E.revPre.delayTime.setTargetAtTime(tt.pre, now, 0.02);
}

/* FX-Einstellungen eines Takes auf die Audio-Knoten anwenden */
function applyTakeFx(t) {
  const n = E.takes.get(t.id);
  if (!n || !n.fx) return;
  const fx = t.fx || { on: false };
  const on = !!fx.on;
  const useChain = on && (fx.eq || fx.comp > 0);
  if (useChain !== n.fxWired) {
    try { n.input.disconnect(); } catch {}
    n.input.connect(useChain ? n.fx.first : n.gain);
    n.fxWired = useChain;
  }
  if (useChain) {
    const eqOn = fx.eq !== false;
    n.fx.hp.frequency.value = eqOn ? 90 : 10;
    n.fx.mud.gain.value = eqOn ? -3 : 0;
    n.fx.pres.gain.value = eqOn ? 3 : 0;
    n.fx.air.gain.value = eqOn ? 3 : 0;
    const c = clamp(fx.comp || 0, 0, 1);
    n.fx.comp.threshold.value = -6 - 26 * c;
    n.fx.comp.ratio.value = 1 + 7 * c;
    n.fx.makeup.gain.value = dbToGain(1 + 5 * c * c);
  }
  const now = E.ctx.currentTime;
  n.revSend.gain.setTargetAtTime(on ? clamp(fx.reverb || 0, 0, 1) * 0.9 : 0, now, 0.03);
  n.dlySend.gain.setTargetAtTime(on ? clamp(fx.delay || 0, 0, 1) * 0.8 : 0, now, 0.03);
  updateFxTempo();
}

/* ---------- Auto-Tune ---------- */
function scaleForKey(key) {
  const m = /^([A-G]#?)(m?)$/.exec(key || "");
  if (!m) return null; // keine Tonart → chromatisch
  const root = NOTE_NAMES.indexOf(m[1]);
  const steps = m[2] ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  return steps.map((x) => (root + x) % 12);
}
function tuneKeyFor(t) {
  return `${(S.song && S.song.key) || "chrom"}|${t.fx && t.fx.tune}|${t.cleanOn && t.clean === "done" ? 1 : 0}`;
}
/* Grund-Audio eines Takes: Original oder "Clean" (Beat entfernt) */
function takeBaseBuffer(t, n) {
  return t.cleanOn && t.clean === "done" && n.cleanBuf ? n.cleanBuf : n.buf;
}
function takePlayBuffer(t, n) {
  if (t.fx && t.fx.on && t.fx.tune && t.fx.tune !== "off" && n.tuned && n.tuned.key === tuneKeyFor(t)) return n.tuned.buf;
  return takeBaseBuffer(t, n);
}

const AUTOTUNE_WORKER_SRC = `
self.onmessage = (ev) => {
  const { id, x, sr, scale, mode } = ev.data;
  const len = x.length;
  // 1) Tonhöhe erkennen (YIN) auf 4x verkleinertem Signal
  const D = 4, dsr = sr / D, dl = Math.floor(len / D);
  const d = new Float32Array(dl);
  for (let i = 0; i < dl; i++) { let v = 0; for (let j = 0; j < D; j++) v += x[i * D + j]; d[i] = v / D; }
  const hopS = 0.005, hop = Math.round(dsr * hopS), W = Math.round(dsr * 0.032);
  const tMin = Math.floor(dsr / 1000), tMax = Math.ceil(dsr / 70);
  const nF = Math.floor((dl - W - tMax) / hop);
  const f0 = new Float32Array(Math.max(0, nF));
  let peak = 0; for (let i = 0; i < len; i += 16) peak = Math.max(peak, Math.abs(x[i]));
  const gate = peak * 0.04;
  const diff = new Float32Array(tMax + 1);
  for (let f = 0; f < nF; f++) {
    const st = f * hop;
    let rms = 0; for (let i = 0; i < W; i++) rms += d[st + i] * d[st + i];
    rms = Math.sqrt(rms / W);
    if (rms < gate * 0.5) { f0[f] = 0; continue; }
    for (let tau = tMin; tau <= tMax; tau++) {
      let s = 0;
      for (let i = 0; i < W; i += 1) { const q = d[st + i] - d[st + i + tau]; s += q * q; }
      diff[tau] = s;
    }
    let run = 0, best = -1;
    for (let tau = tMin; tau <= tMax; tau++) {
      run += diff[tau];
      const cm = run > 0 ? diff[tau] * (tau - tMin + 1) / run : 1;
      if (cm < 0.18) {
        let t2 = tau;
        while (t2 + 1 <= tMax) {
          run += diff[t2 + 1];
          const c2 = diff[t2 + 1] * (t2 + 2 - tMin) / run;
          if (c2 < cm) t2++; else break;
        }
        best = t2; break;
      }
    }
    if (best > tMin && best < tMax) {
      const a = diff[best - 1], b = diff[best], c = diff[best + 1];
      const den = a - 2 * b + c;
      const off = den ? 0.5 * (a - c) / den : 0;
      f0[f] = dsr / (best + off);
    } else f0[f] = 0;
    if ((f & 511) === 0) self.postMessage({ id, progress: 0.6 * f / nF });
  }
  // Ausreisser glätten (Median 5)
  const f0s = new Float32Array(nF);
  for (let f = 0; f < nF; f++) {
    const w = [];
    for (let k = -2; k <= 2; k++) { const v = f0[f + k]; if (v > 0) w.push(v); }
    if (f0[f] > 0 && w.length >= 3) { w.sort((p, q) => p - q); f0s[f] = w[w.length >> 1]; } else f0s[f] = f0[f] > 0 && w.length >= 2 ? f0[f] : 0;
  }
  // 2) Korrektur pro Frame: nächster Ton der Tonleiter
  const hard = mode === "hard";
  const tau = hard ? 0.004 : 0.07;             // Nachführ-Zeit
  const amount = hard ? 1 : 0.85;
  const a = 1 - Math.exp(-hopS / tau);
  const ratio = new Float32Array(nF);
  let sm = 0, last = null;
  for (let f = 0; f < nF; f++) {
    const fr = f0s[f];
    if (!fr) { ratio[f] = 1; sm = 0; last = null; continue; }
    const midi = 69 + 12 * Math.log2(fr / 440);
    let target = Math.round(midi);
    if (scale) {
      let bestD = 99;
      for (let o = Math.floor(midi) - 2; o <= Math.ceil(midi) + 2; o++) {
        if (scale.indexOf(((o % 12) + 12) % 12) === -1) continue;
        const dd = Math.abs(o - midi);
        if (dd < bestD) { bestD = dd; target = o; }
      }
    }
    // kleines Halten, damit es nicht zwischen zwei Tönen flattert
    if (last != null && Math.abs(midi - last) < 0.62 && scale && scale.indexOf(((last % 12) + 12) % 12) !== -1) target = last;
    last = target;
    const want = (target - midi) * amount;
    sm = last === null ? want : sm + a * (want - sm);
    if (f > 0 && !f0s[f - 1]) sm = want;
    ratio[f] = Math.pow(2, sm / 12);
  }
  // 3) TD-PSOLA: Perioden-Marken setzen und neu anordnen
  const H = hop * D; // Frame-Abstand in Original-Samples
  const frameAt = (i) => Math.min(nF - 1, Math.max(0, Math.floor(i / H)));
  const marks = [];
  let i = 0;
  while (i < len) {
    const fr = f0s[frameAt(i)];
    if (fr > 0) {
      const P = sr / fr;
      // lokales Maximum als Marke
      let m = Math.round(i), bm = m, bv = -1;
      const r = Math.round(P * 0.25);
      for (let k = m - r; k <= m + r; k++) { if (k >= 0 && k < len && Math.abs(x[k]) > bv) { bv = Math.abs(x[k]); bm = k; } }
      if (marks.length && bm <= marks[marks.length - 1].pos + P * 0.5) bm = Math.round(marks[marks.length - 1].pos + P);
      marks.push({ pos: bm, P, voiced: true });
      i = bm + P;
    } else {
      const P = Math.round(sr * 0.005);
      marks.push({ pos: Math.round(i), P, voiced: false });
      i += P;
    }
  }
  const y = new Float32Array(len), norm = new Float32Array(len);
  let ts = marks.length ? marks[0].pos : 0, mi = 0;
  while (ts < len && marks.length) {
    while (mi + 1 < marks.length && Math.abs(marks[mi + 1].pos - ts) <= Math.abs(marks[mi].pos - ts)) mi++;
    const mk = marks[mi];
    const P = Math.max(8, Math.round(mk.P));
    const r = mk.voiced ? ratio[frameAt(mk.pos)] : 1;
    const c = Math.round(ts);
    for (let k = -P; k < P; k++) {
      const si = mk.pos + k, di = c + k;
      if (si < 0 || si >= len || di < 0 || di >= len) continue;
      const w = 0.5 + 0.5 * Math.cos(Math.PI * k / P);
      y[di] += x[si] * w; norm[di] += w;
    }
    ts += mk.voiced ? P / r : P;
    if ((mi & 2047) === 0) self.postMessage({ id, progress: 0.6 + 0.4 * ts / len });
  }
  for (let k = 0; k < len; k++) y[k] = norm[k] > 0.2 ? y[k] / norm[k] : y[k];
  self.postMessage({ id, done: true, y }, [y.buffer]);
};
`;

let tuneQueue = [], tuneBusy = false;
function ensureTakeTuned(t) {
  const n = E.takes.get(t.id);
  if (!n || !n.buf || !t.fx || !t.fx.on || !t.fx.tune || t.fx.tune === "off") return;
  const key = tuneKeyFor(t);
  if (n.tuned && n.tuned.key === key) return;
  if (tuneQueue.some((j) => j.t === t && j.key === key)) return;
  tuneQueue.push({ t, key, song: S.song });
  runTuneQueue();
}
function ensureAllTuned() {
  if (!S.song) return;
  S.song.takes.forEach(ensureTakeTuned);
}
function runTuneQueue() {
  if (tuneBusy || !tuneQueue.length) return;
  const job = tuneQueue.shift();
  const { t, key, song } = job;
  const n = E.takes.get(t.id);
  if (S.song !== song || !n || !n.buf || tuneKeyFor(t) !== key) { runTuneQueue(); return; }
  tuneBusy = true;
  const buf = takeBaseBuffer(t, n);
  const x = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = 0; i < d.length; i++) x[i] += d[i] / buf.numberOfChannels;
  }
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob([AUTOTUNE_WORKER_SRC], { type: "text/javascript" }))); }
  catch (err) { console.warn(err); tuneBusy = false; toast("Auto-Tune geht in diesem Browser nicht"); return; }
  setFxBusy(t.id, true);
  w.onmessage = (ev) => {
    const d = ev.data;
    if (d.progress != null) { setFxBusy(t.id, true, d.progress); return; }
    if (d.done) {
      w.terminate();
      tuneBusy = false;
      setFxBusy(t.id, false);
      const out = E.ctx.createBuffer(1, d.y.length, buf.sampleRate);
      out.getChannelData(0).set(d.y);
      n.tuned = { key, buf: out };
      if (S.song === song && tuneKeyFor(t) === key) {
        if (S.playing && !S.recording) play(getPos());
        toast(`Auto-Tune fertig · ${t.name} · ${song.key ? song.key : "chromatisch"}`);
      }
      runTuneQueue();
    }
  };
  w.onerror = (e) => { console.warn(e); w.terminate(); tuneBusy = false; setFxBusy(t.id, false); toast("Auto-Tune fehlgeschlagen"); runTuneQueue(); };
  w.postMessage({ id: 1, x, sr: buf.sampleRate, scale: scaleForKey(song.key), mode: t.fx.tune }, [x.buffer]);
}
function setFxBusy(id, on, p) {
  const b = document.querySelector(`.fx-btn[data-id="${id}"]`);
  if (!b) return;
  b.classList.toggle("busy", on);
  b.style.setProperty("--prog", on && p != null ? `${Math.round(p * 100)}%` : "0%");
}

function toggleTakeFx(t) {
  if (!t.fx) t.fx = defaultFx("melodic");
  else t.fx.on = !t.fx.on;
  haptic(10);
  applyTakeFx(t);
  ensureTakeTuned(t);
  if (S.playing) play(getPos());
  saveSong(); renderTracks();
  toast(t.fx.on ? `FX an · ${FX_PRESETS[t.fx.preset] ? FX_PRESETS[t.fx.preset].label : "Eigene"}` : "FX aus", 1300);
}

function openFxSheet(id) {
  const s = S.song;
  const t = s.takes.find((x) => x.id === id);
  if (!t) return;
  if (!t.fx) { t.fx = defaultFx("melodic"); t.fx.on = true; applyTakeFx(t); ensureTakeTuned(t); }
  const fx = t.fx;
  const commit = (retune) => {
    applyTakeFx(t);
    if (retune) { ensureTakeTuned(t); if (S.playing) play(getPos()); }
    saveSong(); renderTracks();
  };
  openSheet((root) => {
    sheetHeader(root, `FX · ${t.name}`, "");
    const info = el("p", { class: "sheet-sub", style: { margin: "0 0 12px" } });
    const updInfo = () => {
      const tt = fxTempoTimes(fx);
      const scaleTxt = s.key ? `Tonleiter ${s.key.replace(/m$/, "-Moll").replace(/^([A-G]#?)$/, "$1-Dur")}` : "Keine Tonart – Auto-Tune rastet auf Halbtöne";
      info.textContent = `${scaleTxt} · Echo ${fx.delayNote} = ${Math.round(tt.delay * 1000)} ms${s.bpm ? ` bei ${s.bpm} BPM` : ""}`;
    };
    updInfo();
    root.appendChild(info);

    root.appendChild(el("div", { class: "sheet-group" }, [
      toggleRow("FX an", "Der FX-Knopf in der Spur leuchtet bunt", fx.on, (v) => { fx.on = v; commit(true); }),
    ]));

    // Presets
    const presetRow = el("div", { class: "sheet-chips" });
    const drawPresets = () => {
      presetRow.innerHTML = "";
      for (const [k, p] of Object.entries(FX_PRESETS)) {
        const b = el("button", { class: fx.preset === k ? "sel" : "", text: p.label });
        b.addEventListener("click", () => {
          Object.assign(fx, JSON.parse(JSON.stringify(p)), { preset: k, on: true });
          closeSheet(); commit(true); openFxSheet(id);
        });
        presetRow.appendChild(b);
      }
    };
    drawPresets();
    root.appendChild(el("div", { class: "sheet-field" }, [el("div", { class: "sheet-field-label" }, [el("span", { text: "Preset" })]), presetRow]));

    // Auto-Tune
    const tuneRow = el("div", { class: "sheet-chips" });
    const drawTune = () => {
      tuneRow.innerHTML = "";
      for (const [k, lbl] of [["off", "Aus"], ["natural", "Natürlich"], ["hard", "Hart"]]) {
        const b = el("button", { class: fx.tune === k ? "sel" : "", text: lbl });
        b.addEventListener("click", () => { fx.tune = k; fx.preset = "custom"; drawTune(); commit(true); });
        tuneRow.appendChild(b);
      }
    };
    drawTune();
    root.appendChild(el("div", { class: "sheet-field" }, [el("div", { class: "sheet-field-label" }, [el("span", { text: "Auto-Tune (auf die Song-Tonart)" })]), tuneRow]));

    // Slider-Helfer
    const slider = (label, key, fmt) => {
      const lbl = el("b", { text: fmt(fx[key]) });
      const sl = el("input", { type: "range", min: 0, max: 100, value: Math.round((fx[key] || 0) * 100) });
      sl.style.setProperty("--p", sl.value + "%");
      sl.addEventListener("input", () => {
        fx[key] = sl.value / 100; fx.preset = "custom";
        sl.style.setProperty("--p", sl.value + "%");
        lbl.textContent = fmt(fx[key]);
        applyTakeFx(t);
      });
      sl.addEventListener("change", () => saveSong());
      return el("div", { class: "sheet-field" }, [el("div", { class: "sheet-field-label" }, [el("span", { text: label }), lbl]), sl]);
    };
    const pct = (v) => `${Math.round((v || 0) * 100)} %`;
    root.appendChild(el("div", { class: "sheet-group", style: { marginTop: "16px" } }, [
      toggleRow("Vocal-EQ", "Weniger Dröhnen, mehr Präsenz und Glanz", fx.eq !== false, (v) => { fx.eq = v; fx.preset = "custom"; commit(false); }),
    ]));
    root.appendChild(slider("Kompressor", "comp", (v) => (v ? pct(v) : "aus")));
    root.appendChild(slider("Hall", "reverb", (v) => (v ? pct(v) : "aus")));
    root.appendChild(slider("Echo (im Takt)", "delay", (v) => (v ? pct(v) : "aus")));
    const noteRow = el("div", { class: "sheet-chips" });
    const drawNotes = () => {
      noteRow.innerHTML = "";
      for (const k of ["1/16", "1/8", "1/4", "1/2"]) {
        const b = el("button", { class: fx.delayNote === k ? "sel" : "", text: k });
        b.addEventListener("click", () => { fx.delayNote = k; drawNotes(); updInfo(); commit(false); });
        noteRow.appendChild(b);
      }
    };
    drawNotes();
    root.appendChild(el("div", { class: "sheet-field" }, [el("div", { class: "sheet-field-label" }, [el("span", { text: "Echo-Notenwert" })]), noteRow]));
    sheetCancel(root);
  });
}

/* ===================== BEAT AUS VOCAL ENTFERNEN =====================
   Die App kennt den Beat, der beim Aufnehmen lief. Er wird im Frequenzbereich
   (wie eine Echo-Unterdrückung) aus der Vocal-Spur herausgerechnet.
*/
const DEBLEED_WORKER_SRC = `
function fft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
self.onmessage = (ev) => {
  const { y, b, margin, strength } = ev.data;
  const Ly = y.length;
  // 1) Versatz finden: GCC-PHAT (robust, auch wenn die Stimme viel lauter ist)
  const segLen = Math.min(Ly, 44100 * 12);
  let NF = 1; while (NF < segLen + 2 * margin) NF <<= 1;
  const ar = new Float32Array(NF), ai = new Float32Array(NF), cr2 = new Float32Array(NF), ci2 = new Float32Array(NF);
  for (let i = 0; i < segLen; i++) ar[i] = y[i];
  for (let i = 0; i < segLen + 2 * margin && i < b.length; i++) cr2[i] = b[i];
  fft(ar, ai, false); fft(cr2, ci2, false);
  for (let k = 0; k < NF; k++) {
    // Y * conj(B), normalisiert
    const re = ar[k] * cr2[k] + ai[k] * ci2[k], im = ai[k] * cr2[k] - ar[k] * ci2[k];
    const mag = Math.sqrt(re * re + im * im) + 1e-12;
    ar[k] = re / mag; ai[k] = im / mag;
  }
  fft(ar, ai, true);
  // r[lag] beschreibt y[i] ~ b[i + L]; negativer Index = Ende des Arrays
  let fine = margin, bestV = -Infinity;
  for (let L = 0; L <= 2 * margin; L++) {
    const idx = ((NF - L) % NF + NF) % NF;
    if (ar[idx] > bestV) { bestV = ar[idx]; fine = L; }
  }
  const ref = b.subarray(fine, fine + Ly);
  self.postMessage({ progress: 0.1 });
  // 2) STFT
  const N = 4096, H = 1024, bins = N / 2 + 1;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const frames = Math.ceil((Ly + N) / H);
  const spec = (x, f, re, im) => { const st = f * H - N / 2; for (let i = 0; i < N; i++) { const k = st + i; re[i] = (k >= 0 && k < x.length ? x[k] : 0) * win[i]; im[i] = 0; } fft(re, im, false); };
  // Übertragung Lautsprecher → Mikrofon pro Frequenz schätzen: H = Σ Y·B* / Σ |B|²
  const nr = new Float64Array(bins), ni = new Float64Array(bins), dd = new Float64Array(bins);
  const yr = new Float32Array(N), yi = new Float32Array(N), br = new Float32Array(N), bi = new Float32Array(N);
  for (let f = 0; f < frames; f++) {
    spec(y, f, yr, yi); spec(ref, f, br, bi);
    for (let k = 0; k < bins; k++) {
      // Stellen mit lauter Stimme zählen weniger (dort ist die Messung ungenau)
      const py = yr[k] * yr[k] + yi[k] * yi[k], pb = br[k] * br[k] + bi[k] * bi[k];
      const w = pb / (py + 1e-3 * pb + 1e-12);
      nr[k] += w * (yr[k] * br[k] + yi[k] * bi[k]);
      ni[k] += w * (yi[k] * br[k] - yr[k] * bi[k]);
      dd[k] += w * pb;
    }
    if ((f & 127) === 0) self.postMessage({ progress: 0.1 + 0.4 * f / frames });
  }
  const hr = new Float32Array(bins), hi = new Float32Array(bins);
  for (let k = 0; k < bins; k++) { hr[k] = nr[k] / (dd[k] + 1e-9); hi[k] = ni[k] / (dd[k] + 1e-9); }
  // 3) abziehen + Rest unterdrücken
  const out = new Float32Array(Ly + N), wsum = new Float32Array(Ly + N);
  const floor = 0.04, beta = 1 + 2 * strength;
  for (let f = 0; f < frames; f++) {
    spec(y, f, yr, yi); spec(ref, f, br, bi);
    for (let k = 0; k < bins; k++) {
      const er = hr[k] * br[k] - hi[k] * bi[k], ei = hr[k] * bi[k] + hi[k] * br[k];
      let zr = yr[k] - er, zi = yi[k] - ei;
      const pe = er * er + ei * ei, pz = zr * zr + zi * zi;
      const g = Math.max(floor, pz / (pz + beta * pe + 1e-12));
      zr *= g; zi *= g;
      yr[k] = zr; yi[k] = zi;
      if (k > 0 && k < N / 2) { yr[N - k] = zr; yi[N - k] = -zi; }
    }
    fft(yr, yi, true);
    const st = f * H - N / 2;
    for (let i = 0; i < N; i++) {
      const o = st + i; if (o < 0 || o >= Ly) continue;
      out[o] += yr[i] * win[i]; wsum[o] += win[i] * win[i];
    }
    if ((f & 127) === 0) self.postMessage({ progress: 0.5 + 0.5 * f / frames });
  }
  const res = new Float32Array(Ly);
  for (let i = 0; i < Ly; i++) res[i] = wsum[i] > 1e-3 ? out[i] / wsum[i] : 0;
  self.postMessage({ done: true, res, lag: (fine - margin) }, [res.buffer]);
};
`;

/* Beat-Stück holen, das während des Takes lief (in Song-Zeit, gleiche Abtastrate) */
function beatSegmentForTake(t, margin) {
  const s = S.song;
  if (!s.beat || !E.beatBuf) return null;
  const R = beatRate(s), trim = s.beat.trim || 0;
  const baked = E.beatProc && E.beatProc.key === procKey(s) ? E.beatProc.buf : null;
  if (!baked && Math.abs(R - 1) > 0.001) return null;
  const src = baked || E.beatBuf;
  const sr = src.sampleRate;
  const n = E.takes.get(t.id);
  const len = n.buf.length;
  const startSong = t.offset;
  const startBuf = baked ? trim / R + startSong : trim + startSong;
  const s0 = Math.round(startBuf * sr) - margin;
  const out = new Float32Array(len + 2 * margin);
  const chs = [];
  for (let c = 0; c < src.numberOfChannels; c++) chs.push(src.getChannelData(c));
  const endSample = Math.round((baked ? (beatEnd(s) - trim) / R + trim / R : beatEnd(s)) * sr);
  for (let i = 0; i < out.length; i++) {
    const k = s0 + i;
    if (k < 0 || k >= src.length || k >= endSample) continue;
    let v = 0; for (const ch of chs) v += ch[k];
    out[i] = v / chs.length * beatGainValue(s); // ungefähr so laut wie gehört
  }
  return out;
}

async function removeBeatFromTake(t) {
  const s = S.song;
  const n = E.takes.get(t.id);
  if (!n || !n.buf) return;
  if (!s.beat || !E.beatBuf) { sheetAlert("Kein Beat im Song", "Es gibt keinen Beat, der aus der Stimme entfernt werden kann."); return; }
  if (Math.abs(beatRate(s) - 1) > 0.001 && !(E.beatProc && E.beatProc.key === procKey(s))) { toast("Warte kurz, bis der Beat angepasst ist"); return; }
  if (n.buf.sampleRate !== (E.beatProc ? E.beatProc.buf.sampleRate : E.beatBuf.sampleRate)) { toast("Abtastraten passen nicht zusammen"); return; }
  const margin = Math.round(n.buf.sampleRate * 0.35);
  const b = beatSegmentForTake(t, margin);
  if (!b) { toast("Beat-Stück nicht gefunden"); return; }
  const y = new Float32Array(n.buf.length);
  for (let c = 0; c < n.buf.numberOfChannels; c++) { const d = n.buf.getChannelData(c); for (let i = 0; i < d.length; i++) y[i] += d[i] / n.buf.numberOfChannels; }
  let w;
  try { w = new Worker(URL.createObjectURL(new Blob([DEBLEED_WORKER_SRC], { type: "text/javascript" }))); }
  catch (err) { toast("Geht in diesem Browser nicht"); return; }
  t.clean = "processing";
  renderTracks();
  setFxBusy(t.id, true, 0);
  toast("Beat wird aus der Stimme entfernt …", 20000);
  const song = s;
  w.onmessage = async (ev) => {
    const d = ev.data;
    if (d.progress != null) { setFxBusy(t.id, true, d.progress); toast(`Beat wird entfernt … ${Math.round(d.progress * 100)} %`, 20000); return; }
    if (!d.done) return;
    w.terminate();
    setFxBusy(t.id, false);
    const out = E.ctx.createBuffer(1, d.res.length, n.buf.sampleRate);
    out.getChannelData(0).set(d.res);
    n.cleanBuf = out;
    t.clean = "done";
    t.cleanOn = true;
    n.tuned = null;
    try { await Store.putBlob(`take:${t.id}:clean`, encodeWav(out)); } catch (e) { console.warn(e); }
    if (S.song === song) {
      ensureTakeTuned(t);
      if (S.playing && !S.recording) play(getPos());
      saveSong(); renderTracks();
      toast(`Clean · ${t.name} (Original bleibt gespeichert)`, 2600);
    }
  };
  w.onerror = (e) => { console.warn(e); w.terminate(); t.clean = null; setFxBusy(t.id, false); renderTracks(); toast("Entfernen fehlgeschlagen"); };
  w.postMessage({ y, b, margin, strength: 0.6 }, [y.buffer, b.buffer]);
}

function toggleCleanTake(t) {
  t.cleanOn = !t.cleanOn;
  const n = E.takes.get(t.id);
  if (n) n.tuned = null;
  ensureTakeTuned(t);
  if (S.playing) play(getPos());
  saveSong(); renderTracks();
  toast(t.cleanOn ? "Clean (Beat entfernt)" : "Original", 1200);
}

/* ===================== 7. WAVEFORM-ANSICHT ===================== */
const W = {
  canvas: null, ctx: null, w: 0, h: 0, dpr: 1,
  rulerH: 22, flagH: 26, beatH: 96, laneH: 36,
  lanes: [],            // takeId -> Spur-Index
  laneCount: 1,
  drag: null,
  momentum: 0,
  pointers: new Map(),
  pinch: null,
  ov: null, ovCtx: null, ovW: 0, ovH: 0,
};

function layoutLanes() {
  // Takes, die sich zeitlich überlappen, bekommen eigene Spuren
  const takes = (S.song ? S.song.takes : []).slice().sort((a, b) => a.offset - b.offset);
  const laneEnds = [];
  W.lanes = {};
  for (const t of takes) {
    let lane = laneEnds.findIndex((end) => end <= t.offset + 0.01);
    if (lane === -1) { lane = laneEnds.length; laneEnds.push(0); }
    laneEnds[lane] = t.offset + (t.duration || 0);
    W.lanes[t.id] = Math.min(lane, 3);
  }
  W.laneCount = clamp(laneEnds.length + (S.recording ? 1 : 0), 1, 4);
  W.layoutRec = S.recording;
  W.layoutTakes = takes.length;
}

function resizeWave() {
  const c = W.canvas;
  W.dpr = Math.min(3, window.devicePixelRatio || 1);
  layoutLanes();
  const cssH = W.rulerH + W.flagH + W.beatH + 8 + W.laneCount * W.laneH + 8;
  c.style.height = cssH + "px";
  const rect = c.getBoundingClientRect();
  W.w = rect.width; W.h = cssH;
  c.width = Math.round(W.w * W.dpr);
  c.height = Math.round(W.h * W.dpr);

  const ov = W.ov;
  const r2 = ov.getBoundingClientRect();
  W.ovW = r2.width; W.ovH = r2.height;
  ov.width = Math.round(W.ovW * W.dpr);
  ov.height = Math.round(W.ovH * W.dpr);
}

function timeToX(t, pos) { return W.w / 2 + (t - pos) * S.pps; }
function xToTime(x, pos) { return pos + (x - W.w / 2) / S.pps; }

function peakAt(peaks, t0, t1) {
  if (!peaks) return 0;
  const a = Math.max(0, Math.floor(t0 * PEAKS_PER_SEC));
  const b = Math.min(peaks.length, Math.ceil(t1 * PEAKS_PER_SEC));
  let m = 0;
  for (let i = a; i < b; i++) if (peaks[i] > m) m = peaks[i];
  return m;
}

function drawWave(pos = getPos()) {
  const g = W.ctx;
  if (!g || !W.w) return;
  const s = S.song;
  const dpr = W.dpr;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, W.w, W.h);
  if (!s) return;

  const dur = songDuration();
  const tL = xToTime(0, pos), tR = xToTime(W.w, pos);
  const yRuler = 0;
  const yFlags = W.rulerH;
  const yBeat = W.rulerH + W.flagH;
  const yLanes = yBeat + W.beatH + 8;
  const beatMid = yBeat + W.beatH / 2;

  // --- Zeit-Lineal ---
  const steps = [1, 2, 5, 10, 15, 30, 60, 120];
  const minor = steps.find((st) => st * S.pps >= 10) || 120;
  const major = steps.find((st) => st * S.pps >= 70) || 120;
  g.font = "600 10px -apple-system, system-ui, sans-serif";
  g.textBaseline = "top";
  for (let t = Math.max(0, Math.floor(tL / minor) * minor); t <= tR; t += minor) {
    const x = timeToX(t, pos);
    const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    g.fillStyle = isMajor ? "rgba(235,235,245,.55)" : "rgba(235,235,245,.22)";
    g.fillRect(Math.round(x), yRuler + (isMajor ? 12 : 16), 1, isMajor ? 8 : 4);
    if (isMajor) {
      g.fillStyle = "rgba(236,230,255,.5)";
      g.fillText(fmtTime(t), Math.round(x) + 4, yRuler + 1);
    }
  }

  // --- Taktraster (wenn BPM bekannt & genug Zoom) ---
  const spb = beatLen();
  if (spb) {
    const bar = spb * 4, off = gridOffset();
    const gridH = W.beatH + 8 + W.laneCount * W.laneH;
    // Viertel-Schläge (nur bei starkem Zoom)
    if (S.pps * spb > 14) {
      g.fillStyle = "rgba(255,255,255,.035)";
      for (let k = Math.max(0, Math.floor((tL - off) / spb)); off + k * spb <= tR; k++) {
        if (k % 4 === 0) continue;
        g.fillRect(Math.round(timeToX(off + k * spb, pos)), yBeat, 1, gridH);
      }
    }
    // Takte + Taktnummern
    const every = S.pps * bar > 26 ? 1 : S.pps * bar * 4 > 26 ? 4 : 16;
    g.font = "700 9px -apple-system, system-ui, sans-serif";
    g.textBaseline = "bottom";
    for (let k = Math.max(0, Math.floor((tL - off) / bar)); off + k * bar <= tR; k++) {
      if (k % every) continue;
      const x = Math.round(timeToX(off + k * bar, pos));
      const phrase = k % 4 === 0;
      g.fillStyle = phrase ? "rgba(255,255,255,.11)" : "rgba(255,255,255,.06)";
      g.fillRect(x, yBeat, 1, gridH);
      g.fillStyle = phrase ? "rgba(236,230,255,.45)" : "rgba(236,230,255,.25)";
      g.fillText(String(k + 1), x + 3, yBeat + W.beatH - 2);
    }
    g.textBaseline = "top";
  }

  // --- Songteile (farbige Bereiche + Fähnchen) ---
  const secs = sortedSections();
  const loopSec = getLoopSection();
  const nowSec = sectionAt(pos);
  secs.forEach((sec) => {
    const r = sectionRange(sec);
    const x0 = timeToX(r.start, pos), x1 = timeToX(r.end, pos);
    if (x1 < 0 || x0 > W.w) return;
    const col = typeColor(sec.type);
    const band = g.createLinearGradient(0, yBeat, 0, yBeat + W.beatH);
    const editing = S.editSecId && S.editSecId === sec.id;
    const a0 = editing ? 0.34 : S.editSecId ? 0.04 : loopSec && loopSec.id === sec.id ? 0.22 : 0.10;
    band.addColorStop(0, hexA(col, a0));
    band.addColorStop(1, hexA(col, 0));
    g.fillStyle = band;
    g.fillRect(x0, yBeat, x1 - x0, W.beatH);
    const line = g.createLinearGradient(0, yFlags, 0, yBeat + W.beatH);
    line.addColorStop(0, hexA(col, 0.9));
    line.addColorStop(1, hexA(col, 0));
    g.fillStyle = line;
    g.fillRect(Math.round(x0), yFlags + 4, 1.5, W.flagH + W.beatH - 4);
  });
  // Fähnchen zuletzt, damit sie über den Linien liegen
  g.font = "700 12px -apple-system, system-ui, sans-serif";
  g.textBaseline = "middle";
  W.flagHits = [];
  secs.forEach((sec) => {
    const r = sectionRange(sec);
    let x0 = timeToX(r.start, pos);
    const x1 = timeToX(r.end, pos);
    if (x1 < 0 || x0 > W.w) return;
    const label = sec.label + (loopSec && loopSec.id === sec.id ? "  ⟲" : "");
    const tw = g.measureText(label).width + 18;
    // Fähnchen "klebt" am linken Rand, solange der Teil sichtbar ist
    if (x0 < 0) x0 = Math.min(0, x1 - tw);
    const col = typeColor(sec.type);
    const isNow = nowSec && nowSec.id === sec.id;
    g.fillStyle = isNow ? col : hexA(col, 0.2);
    roundRect(g, x0, yFlags + 2, tw, W.flagH - 6, (W.flagH - 6) / 2);
    g.fill();
    if (!isNow) { g.strokeStyle = hexA(col, 0.55); g.lineWidth = 1; g.stroke(); }
    g.fillStyle = isNow ? "#0b0912" : "#fff";
    g.fillText(label, x0 + 9, yFlags + 2 + (W.flagH - 6) / 2 + 0.5);
    W.flagHits.push({ id: sec.id, x0, x1: x0 + tw });
  });

  // --- Beat-Wellenform (Balken wie Sprachmemos) ---
  const barW = 3, gap = 2, stepPx = barW + gap;
  const playedGrad = g.createLinearGradient(0, yBeat + 6, 0, yBeat + W.beatH - 6);
  playedGrad.addColorStop(0, "#ff7ad9");
  playedGrad.addColorStop(0.5, "#b86bff");
  playedGrad.addColorStop(1, "#6d5cff");
  const trim = s.beat ? s.beat.trim || 0 : 0;
  const R = beatRate(s);
  if (E.beatPeaks) {
    const pend = S.trimMode && W.trimPending != null ? W.trimPending : 0; // Anfang beim Ziehen
    const beatDur = (beatEnd(s) - trim) / R;
    const fullEnd = ((E.beatBuf ? E.beatBuf.duration : 0) - trim) / R;
    const startX = Math.max(0, timeToX(S.trimMode ? -trim / R : 0, pos));
    const endX = Math.min(W.w, timeToX(S.trimMode ? fullEnd : beatDur, pos));
    const cutA = timeToX(pend, pos), cutB = timeToX(beatDur, pos);
    const phase = ((timeToX(0, pos) % stepPx) + stepPx) % stepPx;
    for (let x = Math.floor((startX - phase) / stepPx) * stepPx + phase; x < endX; x += stepPx) {
      if (x < startX - 0.01) continue;
      const t0 = trim + xToTime(x, pos) * R, t1 = trim + xToTime(x + stepPx, pos) * R;
      const v = peakAt(E.beatPeaks, t0, t1);
      const hh = Math.max(1.5, v * (W.beatH / 2 - 6));
      const past = x + barW / 2 < W.w / 2;
      const cut = S.trimMode && (x < cutA || x >= cutB);
      g.fillStyle = cut ? "rgba(236,230,255,.10)" : beatSilent(s) ? "rgba(236,230,255,.12)" : past ? playedGrad : "rgba(236,230,255,.26)";
      roundRect(g, x, beatMid - hh, barW, hh * 2, 1.5);
      g.fill();
    }
  } else {
    g.fillStyle = "rgba(236,230,255,.14)";
    for (let x = 0; x < W.w; x += 5) { roundRect(g, x, beatMid - 1.5, 3, 3, 1.5); g.fill(); }
  }

  // --- Vocal-Spuren ---
  g.textBaseline = "top";
  g.font = "600 10px -apple-system, system-ui, sans-serif";
  W.takeHits = [];
  for (let i = 0; i < W.laneCount; i++) {
    g.fillStyle = "rgba(255,255,255,.035)";
    roundRect(g, 8, yLanes + i * W.laneH + 2, W.w - 16, W.laneH - 4, 10);
    g.fill();
  }
  const solo = anySolo();
  for (const t of s.takes) {
    const lane = W.lanes[t.id] || 0;
    const y = yLanes + lane * W.laneH + 2;
    const hh = W.laneH - 4;
    const x0 = timeToX(t.offset, pos), x1 = timeToX(t.offset + (t.duration || 0), pos);
    if (x1 < 0 || x0 > W.w) continue;
    const dim = t.muted || (solo && !t.solo);
    const col = t.color || TAKE_COLORS[0];
    const sel = S.selTakeId === t.id;
    const tg = g.createLinearGradient(0, y, 0, y + hh);
    tg.addColorStop(0, hexA(col, dim ? 0.1 : sel ? 0.42 : 0.28));
    tg.addColorStop(1, hexA(col, dim ? 0.04 : sel ? 0.2 : 0.1));
    g.fillStyle = tg;
    roundRect(g, x0, y, x1 - x0, hh, 10);
    g.fill();
    g.strokeStyle = hexA(col, sel ? 1 : 0.35); g.lineWidth = sel ? 1.5 : 1; g.stroke();
    const n = E.takes.get(t.id);
    if (n && n.peaks) {
      g.fillStyle = dim ? "rgba(235,235,245,.25)" : col;
      const a = Math.max(x0, 0), b = Math.min(x1, W.w);
      for (let x = a; x < b; x += 3) {
        const tt0 = xToTime(x, pos) - t.offset, tt1 = xToTime(x + 3, pos) - t.offset;
        const v = peakAt(n.peaks, tt0, tt1);
        const vh = Math.max(1, v * (hh / 2 - 3));
        g.fillRect(x, y + hh / 2 - vh, 2, vh * 2);
      }
    }
    g.fillStyle = dim ? "rgba(235,235,245,.4)" : "#fff";
    g.fillText(t.name, Math.max(x0, 0) + 6, y + 3);
    W.takeHits.push({ id: t.id, x0, x1, y0: y, y1: y + hh });
  }

  // --- Live-Aufnahme (rot) ---
  if (S.recording && Rec.livePeaks.length) {
    const lane = W.laneCount - 1;
    const y = yLanes + lane * W.laneH + 2;
    const hh = W.laneH - 4;
    const st = Rec.recStartSongPos != null ? Rec.recStartSongPos : Rec.startPos;
    const x0 = timeToX(st, pos), x1 = timeToX(pos, pos);
    g.fillStyle = "rgba(255,59,78,.22)";
    roundRect(g, x0, y, x1 - x0, hh, 10);
    g.fill();
    g.fillStyle = "#ff453a";
    let lastX = -99;
    for (const p of Rec.livePeaks) {
      const x = timeToX(p.t, pos);
      if (x < 0 || x - lastX < 3) continue;
      lastX = x;
      const vh = Math.max(1, Math.min(1, p.v * 1.4) * (hh / 2 - 3));
      g.fillRect(x, y + hh / 2 - vh, 2, vh * 2);
    }
  }

  // --- Ende-Linie ---
  if (dur > 0) {
    const xe = timeToX(dur, pos);
    if (xe < W.w) { g.fillStyle = "rgba(235,235,245,.15)"; g.fillRect(xe, yBeat, 1, W.h - yBeat); }
  }

  // --- Bearbeiten-Modus: Griffe am Anfang/Ende des Songteils ---
  W.handleHits = [];
  const eSec = S.editSecId && S.song.sections.find((x) => x.id === S.editSecId);
  if (eSec) {
    const list = sortedSections();
    const i = list.findIndex((x) => x.id === eSec.id);
    const next = list[i + 1];
    const r = sectionRange(eSec);
    const col = typeColor(eSec.type);
    const xs = timeToX(r.start, pos), xe = timeToX(r.end, pos);
    // Rahmen um den Teil
    g.strokeStyle = hexA(col, 0.9);
    g.lineWidth = 1.5;
    g.setLineDash([5, 4]);
    roundRect(g, xs, yBeat + 1, xe - xs, W.beatH - 2, 8);
    g.stroke();
    g.setLineDash([]);
    const drawHandle = (x, which) => {
      if (x < -30 || x > W.w + 30) return;
      const cy = yBeat + W.beatH / 2;
      const active = W.hdrag && W.hdrag.which === which;
      g.save();
      g.shadowColor = hexA(col, 0.9);
      g.shadowBlur = active ? 18 : 10;
      g.fillStyle = col;
      g.fillRect(x - 1.5, yFlags + 2, 3, W.flagH + W.beatH - 2);
      g.beginPath(); g.arc(x, cy, active ? 16 : 13, 0, Math.PI * 2); g.fill();
      g.restore();
      g.strokeStyle = "#fff"; g.lineWidth = 2.5;
      g.beginPath(); g.arc(x, cy, active ? 16 : 13, 0, Math.PI * 2); g.stroke();
      // Griff-Pfeile ‹ ›
      g.strokeStyle = "#fff"; g.lineWidth = 2; g.lineCap = "round"; g.lineJoin = "round";
      g.beginPath();
      g.moveTo(x - 3, cy - 4); g.lineTo(x - 7, cy); g.lineTo(x - 3, cy + 4);
      g.moveTo(x + 3, cy - 4); g.lineTo(x + 7, cy); g.lineTo(x + 3, cy + 4);
      g.stroke();
      W.handleHits.push({ which, x, line: x });
    };
    drawHandle(xs, "start");
    if (next) drawHandle(xe, "end");
  }

  // --- Trimm-Modus: abgeschnittene Bereiche + Griffe ---
  if (S.trimMode && s.beat && E.beatBuf) {
    const trim = s.beat.trim || 0;
    const a = W.trimPending != null ? W.trimPending : 0;
    const b = (beatEnd(s) - trim) / beatRate(s);
    const xa = timeToX(a, pos), xb = timeToX(b, pos);
    const h = W.h - yBeat;
    // Streifen-Muster für "weg"
    g.save();
    g.fillStyle = "rgba(0,0,0,.45)";
    g.fillRect(0, yBeat, Math.max(0, xa), h);
    g.fillRect(xb, yBeat, Math.max(0, W.w - xb), h);
    g.strokeStyle = "rgba(255,255,255,.06)";
    g.lineWidth = 6;
    g.beginPath();
    for (let x = -h; x < W.w; x += 16) {
      if (x + h > 0 && x < xa) { g.moveTo(Math.max(x, -h), yBeat + h); g.lineTo(Math.min(x + h, xa), yBeat + h - Math.min(h, xa - x)); }
    }
    g.stroke();
    g.restore();
    const col = "#ffd23f";
    const drawTrimHandle = (x, which) => {
      if (x < -30 || x > W.w + 30) return;
      const cy = yBeat + W.beatH / 2;
      const active = W.hdrag && W.hdrag.which === which;
      g.save();
      g.shadowColor = "rgba(255,210,63,.8)"; g.shadowBlur = active ? 18 : 10;
      g.fillStyle = col;
      g.fillRect(x - 1.5, yFlags + 2, 3, W.flagH + W.beatH - 2);
      roundRect(g, x - (which === "trimStart" ? 0 : 22), cy - 18, 22, 36, 8);
      g.fill();
      g.restore();
      // Klammer-Symbol [ oder ]
      g.strokeStyle = "#1a1500"; g.lineWidth = 2.4; g.lineCap = "round";
      const bx = which === "trimStart" ? x + 8 : x - 8;
      const dir = which === "trimStart" ? 1 : -1;
      g.beginPath();
      g.moveTo(bx + 5 * dir, cy - 8); g.lineTo(bx, cy - 8); g.lineTo(bx, cy + 8); g.lineTo(bx + 5 * dir, cy + 8);
      g.stroke();
      W.handleHits.push({ which, x: x + (which === "trimStart" ? 11 : -11), line: x });
    };
    drawTrimHandle(xa, "trimStart");
    drawTrimHandle(xb, "trimEnd");
    g.font = "700 10px -apple-system, system-ui, sans-serif";
    g.fillStyle = "rgba(255,210,63,.9)";
    g.textBaseline = "top";
    if (xa > 60) g.fillText("wird abgeschnitten", Math.max(6, xa / 2 - 44), yBeat + 6);
  }

  // --- Playhead (Mitte) ---
  const cx = Math.round(W.w / 2);
  const phCol = S.recording ? "#ff3b4e" : "#ffffff";
  g.save();
  g.shadowColor = S.recording ? "rgba(255,59,78,.9)" : "rgba(184,107,255,.95)";
  g.shadowBlur = 14;
  g.fillStyle = phCol;
  g.fillRect(cx - 1, yRuler + 12, 2, W.h - 16);
  g.beginPath(); g.arc(cx, yRuler + 10, 5, 0, Math.PI * 2); g.fill();
  g.restore();
}

function drawOverview(pos = getPos()) {
  const g = W.ovCtx;
  if (!g || !W.ovW) return;
  const s = S.song;
  g.setTransform(W.dpr, 0, 0, W.dpr, 0, 0);
  g.clearRect(0, 0, W.ovW, W.ovH);
  g.fillStyle = "rgba(255,255,255,.05)";
  roundRect(g, 0, 0, W.ovW, W.ovH, 10); g.fill();
  const dur = songDuration();
  if (!s || dur <= 0) return;
  const k = W.ovW / dur;
  // Teile
  for (const sec of sortedSections()) {
    const r = sectionRange(sec);
    g.fillStyle = hexA(typeColor(sec.type), 0.85);
    g.fillRect(r.start * k, W.ovH - 4, Math.max(2, (r.end - r.start) * k - 1), 4);
  }
  // Beat
  const trim = s.beat ? s.beat.trim || 0 : 0;
  const R = beatRate(s);
  if (E.beatPeaks) {
    g.fillStyle = "rgba(235,235,245,.35)";
    const mid = (W.ovH - 4) / 2;
    for (let x = 0; x < W.ovW; x += 2) {
      const v = peakAt(E.beatPeaks, trim + (x / k) * R, trim + ((x + 2) / k) * R);
      const hh = Math.max(0.5, v * (mid - 3));
      g.fillRect(x, mid - hh, 1, hh * 2);
    }
  }
  // Takes
  for (const t of s.takes) {
    g.fillStyle = hexA(t.color || TAKE_COLORS[0], t.muted ? 0.3 : 0.9);
    g.fillRect(t.offset * k, W.ovH - 8, Math.max(2, (t.duration || 0) * k), 3);
  }
  // sichtbarer Bereich
  const vw = (W.w / S.pps) * k;
  const vx = pos * k - vw / 2;
  g.fillStyle = "rgba(184,107,255,.14)";
  roundRect(g, vx, 0, vw, W.ovH, 8); g.fill();
  g.strokeStyle = "rgba(184,107,255,.6)";
  g.lineWidth = 1;
  roundRect(g, vx + 0.5, 0.5, vw - 1, W.ovH - 1, 8); g.stroke();
  g.fillStyle = S.recording ? "#ff3b4e" : "#ffffff";
  g.fillRect(pos * k - 1, 0, 2, W.ovH);
}

function hexA(hex, a) {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}
function roundRect(g, x, y, w, h, r) {
  r = Math.min(r, Math.abs(w) / 2, h / 2);
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/* ---------- Gesten: Wischen = spulen, 2 Finger = zoomen, Tippen = auswählen ---------- */
function setupWaveGestures() {
  const c = W.canvas;
  let wasPlaying = false;
  let lastMoves = [];

  c.addEventListener("pointerdown", (e) => {
    c.setPointerCapture(e.pointerId);
    W.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    cancelAnimationFrame(W.momentum);
    if (W.pointers.size === 2) {
      const [a, b] = [...W.pointers.values()];
      W.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), pps: S.pps };
      W.drag = null;
      return;
    }
    if (S.recording) { W.drag = { tapOnly: true, x: e.clientX, y: e.clientY, moved: false }; return; }
    // Trimm-Griff anfassen?
    if (S.trimMode) {
      const r = c.getBoundingClientRect();
      const lx = e.clientX - r.left, ly = e.clientY - r.top;
      let hit = null, best = 28;
      for (const h of W.handleHits || []) {
        const d = Math.abs(lx - h.x);
        if (d < best && ly >= W.rulerH && ly <= W.rulerH + W.flagH + W.beatH + 10) { best = d; hit = h; }
      }
      if (hit) {
        if (S.playing) pause();
        W.hdrag = { which: hit.which, lastT: null, grab: lx - hit.line };
        if (hit.which === "trimStart") W.trimPending = 0;
        W.drag = null;
        haptic(8);
        renderFrame(S.pos);
        return;
      }
    }
    // Griff eines Songteils anfassen?
    if (S.editSecId) {
      const r = c.getBoundingClientRect();
      const lx = e.clientX - r.left, ly = e.clientY - r.top;
      const yTop = W.rulerH, yBot = W.rulerH + W.flagH + W.beatH + 6;
      let hit = null, best = 26;
      for (const h of W.handleHits || []) {
        const d = Math.abs(lx - h.x);
        if (d < best && ly >= yTop && ly <= yBot) { best = d; hit = h; }
      }
      // auch das Fähnchen selbst ziehen = Anfang verschieben
      if (!hit) {
        const f = (W.flagHits || []).find((h) => h.id === S.editSecId && lx >= h.x0 && lx <= h.x1 && ly < W.rulerH + W.flagH + 4);
        if (f) hit = { which: "start" };
      }
      if (hit) {
        if (S.playing) pause();
        const list = sortedSections();
        const i = list.findIndex((x) => x.id === S.editSecId);
        const target = hit.which === "start" ? list[i] : list[i + 1];
        W.hdrag = { which: hit.which, id: target.id, lastT: target.time, grab: hit.line != null ? lx - hit.line : 0 };
        W.drag = null;
        haptic(8);
        renderFrame(S.pos);
        return;
      }
    }
    wasPlaying = S.playing;
    W.drag = { x: e.clientX, y: e.clientY, pos: getPos(), moved: false, t: performance.now() };
    lastMoves = [{ x: e.clientX, t: performance.now() }];
  });

  c.addEventListener("pointermove", (e) => {
    if (!W.pointers.has(e.pointerId)) return;
    W.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (W.pinch && W.pointers.size >= 2) {
      const [a, b] = [...W.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      setZoom(W.pinch.pps * (d / W.pinch.d));
      return;
    }
    if (W.hdrag) { moveHandle(e); return; }
    const dr = W.drag;
    if (!dr) return;
    const dx = e.clientX - dr.x;
    if (!dr.moved && Math.abs(dx) > 5) {
      dr.moved = true;
      if (dr.tapOnly) return;
      if (S.playing) { pause(); }
    }
    if (dr.moved && !dr.tapOnly) {
      S.pos = clamp(dr.pos - dx / S.pps, minPos(), Math.max(0, maxPos()));
      lastMoves.push({ x: e.clientX, t: performance.now() });
      if (lastMoves.length > 5) lastMoves.shift();
      renderFrame(S.pos);
    }
  });

  const end = (e) => {
    if (!W.pointers.has(e.pointerId)) return;
    W.pointers.delete(e.pointerId);
    if (W.pinch) {
      if (W.pointers.size < 2) W.pinch = null;
      return;
    }
    if (W.hdrag) {
      const which = W.hdrag.which;
      W.hdrag = null;
      if (which === "trimStart") {
        const shift = W.trimPending || 0;
        W.trimPending = null;
        if (Math.abs(shift) > 0.001) applyTrimShift(shift);
        updateTrimBar(); renderAll();
        return;
      }
      if (which === "trimEnd") { saveSong(); updateTrimBar(); renderTracks(); renderAll(); return; }
      saveSong(); renderSections(); renderLyrics(); updateSecEditBar(); renderAll();
      return;
    }
    const dr = W.drag;
    W.drag = null;
    if (!dr) return;
    if (!dr.moved) { handleWaveTap(e); return; }
    if (dr.tapOnly) return;
    // Schwung
    const first = lastMoves[0], last = lastMoves[lastMoves.length - 1];
    const dt = Math.max(1, last.t - first.t);
    let v = -((last.x - first.x) / dt) * 1000 / S.pps; // Sekunden pro Sekunde
    if (Math.abs(v) > 1.5 && performance.now() - last.t < 80) {
      let prev = performance.now();
      const step = (now) => {
        const dts = (now - prev) / 1000; prev = now;
        S.pos = clamp(S.pos + v * dts, minPos(), maxPos());
        v *= Math.pow(0.04, dts);
        renderFrame(S.pos);
        if (Math.abs(v) > 0.3 && S.pos > minPos() && S.pos < maxPos()) W.momentum = requestAnimationFrame(step);
        else { renderAll(); if (wasPlaying) play(S.pos); }
      };
      W.momentum = requestAnimationFrame(step);
    } else {
      renderAll();
      if (wasPlaying) play(S.pos);
    }
  };
  c.addEventListener("pointerup", end);
  c.addEventListener("pointercancel", end);

  // Desktop: Mausrad = spulen, Ctrl/Pinch-Trackpad = zoomen
  c.addEventListener("wheel", (e) => {
    e.preventDefault();
    if (e.ctrlKey) { setZoom(S.pps * Math.exp(-e.deltaY * 0.01)); return; }
    if (S.recording) return;
    const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
    seek(getPos() + d / S.pps);
  }, { passive: false });

  // Übersicht: tippen/ziehen = springen
  const ov = W.ov;
  let ovDrag = false;
  const ovSeek = (e) => {
    const r = ov.getBoundingClientRect();
    const d = songDuration();
    if (d <= 0 || S.recording) return;
    const t = clamp(((e.clientX - r.left) / r.width) * d, 0, d);
    if (S.playing) { S.pos = t; E.startPos = t; }
    seek(t);
  };
  ov.addEventListener("pointerdown", (e) => { ovDrag = true; ov.setPointerCapture(e.pointerId); ovSeek(e); });
  ov.addEventListener("pointermove", (e) => { if (ovDrag) ovSeek(e); });
  ov.addEventListener("pointerup", () => { ovDrag = false; });
  ov.addEventListener("pointercancel", () => { ovDrag = false; });
}

/* ================= SONGTEIL BEARBEITEN (direkt auf der Waveform) ================= */
function sectionNeighbours(id) {
  const list = sortedSections();
  const i = list.findIndex((x) => x.id === id);
  return { list, i, prev: list[i - 1], next: list[i + 1], sec: list[i] };
}

/* Anfang eines Songteils setzen – bleibt zwischen Nachbarn */
function setSectionTime(id, t) {
  const { prev, next, sec } = sectionNeighbours(id);
  if (!sec) return false;
  const min = prev ? prev.time + 0.05 : 0;
  const max = next ? next.time - 0.05 : Math.max(0, songDuration() - 0.05);
  const v = Math.round(clamp(t, min, max) * 1000) / 1000;
  if (v === sec.time) return false;
  sec.time = v;
  return true;
}

/* Einrasten auf Schläge (für Trimmen) */
function snapToBeat(t) {
  const s = S.song, spb = beatLen();
  if (!s || !spb || s.snap === false) return t;
  const off = gridOffset();
  return off + Math.round((t - off) / spb) * spb;
}

function moveHandle(e) {
  const r = W.canvas.getBoundingClientRect();
  let lx = e.clientX - r.left - (W.hdrag.grab || 0);
  // am Rand automatisch weiterscrollen
  if (lx < 36) S.pos = Math.max(minPos(), S.pos - (36 - lx) * 0.012 / (S.pps / 60));
  if (lx > W.w - 36) S.pos = Math.min(songDuration() + (S.trimMode ? 30 : 0), S.pos + (lx - (W.w - 36)) * 0.012 / (S.pps / 60));
  let t = xToTime(lx, S.pos);
  if (W.hdrag.which === "trimStart" || W.hdrag.which === "trimEnd") {
    const s = S.song, trim = s.beat.trim || 0, R = beatRate(s);
    const full = E.beatBuf.duration;
    if (S.song.trimSnap) t = snapToBeat(t);
    if (W.hdrag.which === "trimStart") {
      const endSong = (beatEnd(s) - trim) / R;
      W.trimPending = clamp(t, -trim / R, endSong - 1);
    } else {
      const fullSong = (full - trim) / R;
      const v = clamp(t, 1, fullSong);
      s.beat.trimEnd = v >= fullSong - 0.01 ? null : Math.round((trim + v * R) * 1000) / 1000;
    }
    if (W.hdrag.lastT == null || Math.abs(t - W.hdrag.lastT) > 0.01) { haptic(4); W.hdrag.lastT = t; }
    updateTrimBar();
    renderFrame(S.pos);
    return;
  }
  t = snapToBar(t);
  if (setSectionTime(W.hdrag.id, t)) {
    if (Math.abs(t - W.hdrag.lastT) > 0.01) haptic(5);
    W.hdrag.lastT = t;
  }
  updateSecEditBar();
  renderFrame(S.pos);
}

/* ================= BEAT TRIMMEN ================= */
let silenceCache = { buf: null, val: null };
function detectSilenceCached() {
  if (silenceCache.buf !== E.beatBuf) silenceCache = { buf: E.beatBuf, val: detectSilence(E.beatBuf) };
  return silenceCache.val;
}
/* Beat-Anfang um "shift" Sekunden verschieben – Takes, Teile, Raster bleiben am Beat */
function applyTrimShift(shift) {
  const s = S.song;
  if (!s.beat) return;
  if (S.playing) pause();
  const R = beatRate(s);
  const newTrim = Math.max(0, Math.round(((s.beat.trim || 0) + shift * R) * 1000) / 1000);
  shift = (newTrim - (s.beat.trim || 0)) / R;
  s.beat.trim = newTrim;
  s.takes.forEach((t) => (t.offset = Math.round((t.offset - shift) * 1000) / 1000));
  s.sections.forEach((x) => (x.time = Math.max(0, Math.round((x.time - shift) * 1000) / 1000)));
  if (s.gridOffset != null) s.gridOffset -= shift;
  S.pos = S.pos - shift;
  if (!S.trimMode) S.pos = Math.max(0, S.pos);
  saveSong(); renderSections(); renderLyrics(); renderTracks();
}

/* Stille am Anfang / Ende finden (Beat-Zeit) */
function detectSilence(buf) {
  const chs = [];
  for (let c = 0; c < Math.min(2, buf.numberOfChannels); c++) chs.push(buf.getChannelData(c));
  let peak = 0;
  for (const ch of chs) for (let i = 0; i < ch.length; i += 8) { const a = Math.abs(ch[i]); if (a > peak) peak = a; }
  const thr = Math.max(0.002, peak * 0.03); // ca. -30 dB unter dem Maximum
  const n = buf.length;
  let first = 0, last = n - 1;
  outer1: for (let i = 0; i < n; i++) { for (const ch of chs) if (Math.abs(ch[i]) > thr) { first = i; break outer1; } }
  outer2: for (let i = n - 1; i > first; i--) { for (const ch of chs) if (Math.abs(ch[i]) > thr) { last = i; break outer2; } }
  return { start: Math.max(0, first / buf.sampleRate - 0.01), end: Math.min(buf.duration, last / buf.sampleRate + 0.05) };
}

function enterTrimMode() {
  const s = S.song;
  if (!s || !s.beat || !E.beatBuf) { toast("Zuerst einen Beat laden"); return; }
  exitSectionEdit();
  if (S.playing) pause();
  S.trimMode = true;
  W.trimPending = null;
  closeSheet();
  setTab("studio");
  // Anfang in die Mitte holen, etwas herauszoomen
  if (S.pps > 40) S.pps = 40;
  S.pos = 0;
  $("#trim-edit").classList.remove("hidden");
  updateTrimBar();
  resizeWave();
  renderAll();
  $("#wave-wrap").scrollIntoView({ block: "start", behavior: "smooth" });
}

function exitTrimMode() {
  if (!S.trimMode) return;
  S.trimMode = false;
  W.trimPending = null;
  W.hdrag = null;
  if (S.pos < 0) S.pos = 0;
  $("#trim-edit").classList.add("hidden");
  saveSong(); renderTracks(); renderAll();
}

function updateTrimBar() {
  const s = S.song;
  if (!s || !s.beat || !S.trimMode) return;
  const trim = (s.beat.trim || 0) + (W.trimPending || 0) * beatRate(s);
  const end = beatEnd(s);
  const full = E.beatBuf ? E.beatBuf.duration : s.beat.duration;
  const f = (t) => `${fmtTime(t)},${String(Math.floor((t % 1) * 100)).padStart(2, "0")}`;
  $("#trim-start-val").textContent = f(trim);
  $("#trim-end-val").textContent = s.beat.trimEnd ? `–${f(full - end)}` : "voll";
  $("#trim-len-val").textContent = fmtTime((end - trim) / beatRate(s));
  updateTrimSnapUI();
}

function updateTrimSnapUI() {
  const on = !!(S.song && S.song.trimSnap && beatLen());
  const b = $("#trim-snap");
  b.classList.toggle("on", on);
  b.querySelector("span").textContent = on ? "Schlag" : "Frei";
}

function trimAutoSilence() {
  const s = S.song;
  const sil = detectSilence(E.beatBuf);
  const shift = (sil.start - (s.beat.trim || 0)) / beatRate(s);
  const tailCut = E.beatBuf.duration - sil.end > 0.3;
  if (Math.abs(shift) < 0.02 && !tailCut) { toast("Keine Stille gefunden"); return; }
  if (Math.abs(shift) >= 0.02) applyTrimShift(shift);
  if (tailCut) s.beat.trimEnd = Math.round(sil.end * 1000) / 1000;
  // erster Ton liegt jetzt bei 0:00 → dort ist Takt 1
  if (beatLen() && Math.abs(gridOffset()) < 0.08) s.gridOffset = 0;
  haptic(10);
  saveSong(); updateTrimBar(); renderTracks(); renderAll();
  toast(`Stille entfernt${sil.start > 0.02 ? ` · ${sil.start.toFixed(2).replace(".", ",")} s am Anfang` : ""}`);
}

function trimToDownbeat() {
  const s = S.song;
  if (!beatLen()) { toast("Kein Tempo erkannt – tippe oben auf BPM"); return; }
  const off = gridOffset();
  // die erste 1 nach der Stille
  const R = beatRate(s);
  const sil = (detectSilence(E.beatBuf).start - (s.beat.trim || 0)) / R;
  const bar = beatLen() * 4;
  let t = off;
  while (t < sil - 0.05) t += bar;
  while (t - bar >= -(s.beat.trim || 0) / R - 0.001 && t - bar >= sil - 0.05) t -= bar;
  applyTrimShift(t);
  s.gridOffset = 0;
  haptic(10);
  saveSong(); updateTrimBar(); renderAll();
  toast("Beat startet jetzt auf der 1");
}

function trimReset() {
  const s = S.song;
  if (s.beat.trim) applyTrimShift(-(s.beat.trim || 0));
  s.beat.trimEnd = null;
  saveSong(); updateTrimBar(); renderTracks(); renderAll();
  toast("Beat wieder komplett");
}

function enterSectionEdit(id) {
  exitTrimMode();
  const sec = S.song && S.song.sections.find((x) => x.id === id);
  if (!sec) return;
  S.editSecId = id;
  haptic(8);
  // Anfang sichtbar machen
  const x = timeToX(sec.time, getPos());
  if (x < 24 || x > W.w - 24) seek(sec.time);
  $("#sec-edit").classList.remove("hidden");
  updateSecEditBar();
  renderSections();
  renderAll();
}

function exitSectionEdit() {
  if (!S.editSecId) return;
  S.editSecId = null;
  W.hdrag = null;
  $("#sec-edit").classList.add("hidden");
  renderSections();
  renderAll();
}

function updateSecEditBar() {
  const s = S.song;
  const sec = s && S.editSecId && s.sections.find((x) => x.id === S.editSecId);
  if (!sec) { $("#sec-edit").classList.add("hidden"); return; }
  const r = sectionRange(sec);
  const col = typeColor(sec.type);
  $("#sec-edit").style.setProperty("--c", col);
  $("#sec-edit-name").textContent = sec.label;
  let range;
  if (beatLen()) {
    const b0 = barInfo(r.start), b1 = barInfo(Math.max(r.start, r.end - 0.05));
    const bars = Math.round((r.end - r.start) / (beatLen() * 4) * 10) / 10;
    const from = b0.pickup ? "Auftakt" : b0.bar;
    range = `T. ${from}${b1.bar !== b0.bar ? "–" + b1.bar : ""} · ${String(bars).replace(".", ",")} Takt${bars === 1 ? "" : "e"}`;
  } else {
    range = `${fmtTime(r.start)} – ${fmtTime(r.end)}`;
  }
  $("#sec-edit-range").textContent = range;
  $("#sec-edit-loop").classList.toggle("on", s.loopSectionId === sec.id);
  updateSnapUI();
}

function updateSnapUI() {
  const s = S.song;
  const snap = !!(s && s.snap !== false && beatLen());
  const b = $("#sec-edit-snap");
  b.classList.toggle("on", snap);
  b.querySelector("span").textContent = snap ? "Takt" : "Frei";
  $("#sec-edit-prev").lastChild.textContent = snap ? "1 Takt" : "0,1 s";
  $("#sec-edit-next").firstChild.textContent = snap ? "1 Takt" : "0,1 s";
  $("#sec-edit-hint").textContent = snap
    ? "Ziehe die runden Griffe – sie rasten auf jeden Takt ein. „Frei“ = stufenlos."
    : "Frei: Griffe stufenlos ziehen, Knöpfe verschieben um 0,1 s.";
}

function nudgeSection(dir) {
  const s = S.song;
  const sec = s.sections.find((x) => x.id === S.editSecId);
  if (!sec) return;
  const step = s.snap !== false && beatLen() ? beatLen() * 4 : 0.1;
  const t = s.snap === false || !beatLen() ? sec.time + dir * step : snapToBar(sec.time + dir * step);
  if (setSectionTime(sec.id, t)) {
    haptic(6);
    saveSong(); renderSections(); renderLyrics(); updateSecEditBar(); renderAll();
  } else toast("Weiter geht nicht – da liegt ein anderer Teil", 1400);
}

function handleWaveTap(e) {
  const r = W.canvas.getBoundingClientRect();
  const x = e.clientX - r.left, y = e.clientY - r.top;
  // Fähnchen?
  if (y < W.rulerH + W.flagH + 4) {
    const hit = (W.flagHits || []).find((h) => x >= h.x0 && x <= h.x1);
    if (hit) { enterSectionEdit(hit.id); return; }
  }
  // Im Bearbeiten-Modus: Tippen daneben = fertig
  if (S.editSecId) { exitSectionEdit(); return; }
  // Take?
  const th = (W.takeHits || []).find((h) => x >= h.x0 && x <= h.x1 && y >= h.y0 && y <= h.y1);
  if (th) {
    if (S.selTakeId === th.id) openTakeSheet(th.id);
    else { S.selTakeId = th.id; renderTracks(); renderAll(); }
    return;
  }
  if (S.recording) return;
  // Sonst: an diese Stelle springen
  seek(xToTime(x, getPos()));
}

let zoomBadgeTimer = 0;
function setZoom(pps) {
  S.pps = clamp(pps, 8, 400);
  const b = $("#zoom-badge");
  b.textContent = `${Math.round((S.pps / 60) * 100)} %`;
  b.classList.add("show");
  clearTimeout(zoomBadgeTimer);
  zoomBadgeTimer = setTimeout(() => b.classList.remove("show"), 900);
  renderFrame(getPos());
}

/* ===================== 8. OBERFLÄCHE ===================== */

/* ---------- Songteile (Arrangement-Tags) ---------- */
function sortedSections() {
  return S.song ? S.song.sections.slice().sort((a, b) => a.time - b.time) : [];
}
function sectionRange(sec) {
  const list = sortedSections();
  const i = list.findIndex((s) => s.id === sec.id);
  const next = list[i + 1];
  const end = next ? next.time : Math.max(songDuration(), sec.time + 1);
  return { start: sec.time, end };
}
function sectionAt(t) {
  const list = sortedSections();
  let cur = null;
  for (const s of list) { if (s.time <= t + 0.001) cur = s; else break; }
  return cur;
}
function getLoopSection() {
  const s = S.song;
  if (!s || !s.loopSectionId) return null;
  return s.sections.find((x) => x.id === s.loopSectionId) || null;
}

function nextSectionLabel(type) {
  const def = SECTION_TYPES[type] || SECTION_TYPES.custom;
  if (!def.numbered) return def.label;
  const count = S.song.sections.filter((s) => s.type === type).length;
  return `${def.label} ${count + 1}`;
}

function addSectionAt(type, label) {
  const s = S.song;
  if (!s) return;
  const raw = Math.max(0, S.playing ? getPos() : S.pos);
  const t = snapToBar(raw);
  // gleicher Zeitpunkt? → ersetzen statt doppelt
  const same = s.sections.find((x) => Math.abs(x.time - t) < 0.25);
  if (same) s.sections = s.sections.filter((x) => x !== same);
  const sec = { id: uid(), type, label: label || nextSectionLabel(type), time: Math.round(t * 1000) / 1000 };
  s.sections.push(sec);
  s._lastSectionId = sec.id;
  haptic(12);
  saveSong();
  renderSections();
  renderLyrics();
  renderAll();
  toast(`${sec.label} bei ${beatLen() ? barLabel(sec.time).replace(/\.1$/, "") : fmtTime(sec.time)}`, 1300);
}

function renderSections() {
  const strip = $("#section-strip");
  strip.innerHTML = "";
  const s = S.song;
  if (!s) return;
  const nowSec = sectionAt(getPos());
  for (const sec of sortedSections()) {
    const chip = el("button", {
      class: "sec-chip" + (nowSec && nowSec.id === sec.id ? " now" : "") + (s.loopSectionId === sec.id ? " loop" : ""),
      style: { "--c": typeColor(sec.type) },
      "data-id": sec.id,
    }, [el("span", { class: "dot" }), sec.label, el("small", { text: beatLen() && !barInfo(sec.time).pickup ? `T. ${barInfo(sec.time).bar}` : fmtTime(sec.time) })]);
    chip.style.setProperty("--c", typeColor(sec.type));
    let lp = null;
    chip.addEventListener("pointerdown", () => { lp = setTimeout(() => { lp = "done"; haptic(); openSectionSheet(sec.id); }, 480); });
    chip.addEventListener("pointerup", () => { if (lp !== "done") { clearTimeout(lp); jumpToSection(sec.id); enterSectionEdit(sec.id); } lp = null; });
    chip.addEventListener("pointercancel", () => { clearTimeout(lp); lp = null; });
    chip.addEventListener("contextmenu", (e) => e.preventDefault());
    strip.appendChild(chip);
  }
  $("#chip-loop").classList.toggle("on", !!getLoopSection());
}

function jumpToSection(id) {
  const sec = S.song.sections.find((x) => x.id === id);
  if (!sec) return;
  haptic();
  if (S.song.loopSectionId && S.song.loopSectionId !== id) S.song.loopSectionId = id; // Loop folgt
  seek(sec.time);
  renderSections();
}

function renderTagGrid() {
  const grid = $("#tag-grid");
  grid.innerHTML = "";
  const order = ["intro", "verse", "pre", "hook", "bridge", "interlude", "outro"];
  for (const type of order) {
    const b = el("button", { class: "tag-btn", text: SECTION_TYPES[type].label });
    b.style.setProperty("--c", typeColor(type));
    b.addEventListener("click", () => { flash(b); addSectionAt(type); });
    grid.appendChild(b);
  }
  const custom = el("button", { class: "tag-btn custom", text: "+ Eigener" });
  custom.addEventListener("click", async () => {
    const name = await sheetPrompt("Eigener Songteil", "", "z. B. Adlib, Drop, Spoken");
    if (name) addSectionAt("custom", name.trim());
  });
  grid.appendChild(custom);
}
function flash(b) { b.classList.add("flash"); setTimeout(() => b.classList.remove("flash"), 220); }

/* ---------- Spuren (Beat + Takes) ---------- */
const ICONS = {
  more: '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>',
  speakerLow: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/></svg>',
  speakerHigh: '<svg viewBox="0 0 24 24"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>',
  music: '<svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>',
  mic: '<svg viewBox="0 0 24 24"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 14 0"/><path d="M12 17v4"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
  share: '<svg viewBox="0 0 24 24"><path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>',
  trash: '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/><path d="M9 7V4h6v3"/></svg>',
  pencil: '<svg viewBox="0 0 24 24"><path d="M4 20h4L19 9l-4-4L4 16z"/></svg>',
  flag: '<svg viewBox="0 0 24 24"><path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/></svg>',
  scissors: '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/></svg>',
  loop: '<svg viewBox="0 0 24 24"><path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/></svg>',
  sparkle: '<svg viewBox="0 0 24 24"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg>',
  wave: '<svg viewBox="0 0 24 24"><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 11v2"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
  copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  up: '<svg viewBox="0 0 24 24"><path d="m6 15 6-6 6 6"/></svg>',
  down: '<svg viewBox="0 0 24 24"><path d="m6 9 6 6 6-6"/></svg>',
  jump: '<svg viewBox="0 0 24 24"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>',
  undo: '<svg viewBox="0 0 24 24"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg>',
  file: '<svg viewBox="0 0 24 24"><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/></svg>',
};

/* =========================================================
   MIX-FADER wie in Logic Pro:
   Lautstärke-Regler liegt direkt auf dem Pegelmeter.
   Skala: -∞ … 0 dB (bei 70 %) … +12 dB
   ========================================================= */
const FADER_UNITY = 0.7;   // Position von 0 dB
const FADER_MAX_DB = 12;
const FADER_MIN_DB = -60;  // darunter = -∞ (stumm)

function dbToPos(db) {
  if (!isFinite(db) || db <= FADER_MIN_DB) return 0;
  if (db >= 0) return FADER_UNITY + (Math.min(db, FADER_MAX_DB) / FADER_MAX_DB) * (1 - FADER_UNITY);
  return FADER_UNITY - Math.sqrt(db / FADER_MIN_DB) * FADER_UNITY;
}
function posToDb(p) {
  p = clamp(p, 0, 1);
  if (p <= 0.005) return -Infinity;
  if (p >= FADER_UNITY) return ((p - FADER_UNITY) / (1 - FADER_UNITY)) * FADER_MAX_DB;
  const r = (FADER_UNITY - p) / FADER_UNITY;
  return FADER_MIN_DB * r * r;
}
function fmtFaderDb(db) {
  if (!isFinite(db)) return "–∞";
  const r = Math.round(db * 10) / 10;
  return (r > 0 ? "+" : "") + r.toFixed(1).replace(".", ",");
}
// Farbgrenzen im Meter (grün bis -12 dB, gelb bis -3 dB, rot darüber)
const METER_STOPS = { y: dbToPos(-12) * 100, r: dbToPos(-3) * 100 };

/*
  makeFader({ id, db, onChange })
  - Ziehen = Lautstärke ändern (relativ, wie Logic – kein Springen)
  - Doppeltippen = zurück auf 0 dB
*/
function makeFader({ id, db, onChange, label }) {
  const knob = el("div", { class: "mf-knob" });
  const fill = el("div", { class: "mf-meter-fill" });
  const peak = el("div", { class: "mf-peak" });
  const meter = el("div", { class: "mf-meter" }, [fill, peak]);
  const ticks = el("div", { class: "mf-ticks" });
  for (const d of [-40, -20, -10, -5, 0, 6, 12]) {
    const t = el("i", { class: d === 0 ? "unity" : "" });
    t.style.left = dbToPos(d) * 100 + "%";
    ticks.appendChild(t);
  }
  const track = el("div", { class: "mf-track", role: "slider", tabindex: "0", "aria-label": label || "Lautstärke" }, [meter, ticks, knob]);
  const val = el("span", { class: "mf-val" });
  const wrap = el("div", { class: "mf", id }, [track, val]);
  wrap.style.setProperty("--y", METER_STOPS.y + "%");
  wrap.style.setProperty("--r", METER_STOPS.r + "%");
  wrap.style.setProperty("--u", FADER_UNITY * 100 + "%");

  let cur = db;
  const show = () => {
    const p = dbToPos(cur);
    knob.style.left = p * 100 + "%";
    wrap.style.setProperty("--k", p * 100 + "%");
    val.textContent = fmtFaderDb(cur);
    val.classList.toggle("hot", isFinite(cur) && cur > 0.05);
    track.setAttribute("aria-valuetext", fmtFaderDb(cur) + " dB");
  };
  const set = (d, fire = true) => {
    // 0 dB "rastet" leicht ein
    if (isFinite(d) && Math.abs(d) < 0.4) d = 0;
    cur = d;
    show();
    if (fire) onChange(cur);
  };
  show();

  let drag = null, lastTap = 0;
  track.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    track.setPointerCapture(e.pointerId);
    drag = { x: e.clientX, p: dbToPos(cur), w: track.getBoundingClientRect().width, moved: false };
    wrap.classList.add("active");
  });
  track.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 3) return;
    drag.moved = true;
    set(posToDb(drag.p + dx / drag.w));
  });
  const end = (e) => {
    if (!drag) return;
    const wasMoved = drag.moved;
    drag = null;
    wrap.classList.remove("active");
    if (!wasMoved) {
      const now = performance.now();
      if (now - lastTap < 350) { set(0); haptic(10); }
      lastTap = now;
    }
  };
  track.addEventListener("pointerup", end);
  track.addEventListener("pointercancel", end);
  track.addEventListener("click", (e) => e.stopPropagation());
  track.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 3 : 0.5;
    const base = isFinite(cur) ? cur : FADER_MIN_DB;
    if (e.key === "ArrowRight" || e.key === "ArrowUp") { e.preventDefault(); set(Math.min(FADER_MAX_DB, base + step)); }
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") { e.preventDefault(); set(base - step <= FADER_MIN_DB ? -Infinity : base - step); }
  });
  wrap._fill = fill;
  wrap._peak = peak;
  wrap._pk = 0; wrap._pkT = 0;
  return wrap;
}

/* dB-Wert speichern (JSON kennt kein -Infinity) */
const dbStore = (d) => (isFinite(d) ? d : -999);
const dbLoad = (d) => (d == null ? 0 : d <= -999 ? -Infinity : d);
function beatDb(s) {
  if (s.beatGainDb == null) s.beatGainDb = dbStore(gainToDb(s.beatVolume == null ? 0.85 : s.beatVolume));
  return dbLoad(s.beatGainDb);
}
const beatGainValue = (s) => { const d = beatDb(s); return isFinite(d) ? dbToGain(d) : 0; };
const takeGainValue = (t) => { const d = dbLoad(t.gainDb); return isFinite(d) ? dbToGain(d) : 0; };

function renderTracks() {
  const list = $("#track-list");
  list.innerHTML = "";
  const s = S.song;
  if (!s) return;

  // Beat
  if (s.beat) {
    const fader = makeFader({
      id: "meter-beat", db: beatDb(s), label: "Beat-Lautstärke",
      onChange: (d) => { s.beatGainDb = dbStore(d); applyMix(); saveSong(); },
    });
    const mBtn = el("button", { class: "ms-btn" + (s.beatMuted ? " on-m" : ""), text: "M", "aria-label": "Beat stumm" });
    mBtn.addEventListener("click", () => { s.beatMuted = !s.beatMuted; applyMix(); saveSong(); renderTracks(); renderAll(); });
    const sBtn = el("button", { class: "ms-btn" + (s.beatSolo ? " on-s" : ""), text: "S", "aria-label": "Beat solo" });
    sBtn.addEventListener("click", () => { s.beatSolo = !s.beatSolo; haptic(); applyMix(); saveSong(); renderTracks(); renderAll(); });
    const more = el("button", { class: "more-btn", html: ICONS.more, "aria-label": "Beat-Optionen" });
    more.addEventListener("click", openBeatSheet);
    const row = el("div", { class: "track" + (beatSilent(s) ? " muted" : "") }, [
      el("span", { class: "track-color", style: { background: "linear-gradient(135deg, #6d7cff, #9b5cff)" }, html: ICONS.music }),
      el("div", { class: "track-main" }, [
        el("span", { class: "track-name", text: s.beat.name || "Beat" }),
        el("div", { class: "track-meta" }, [
          el("span", { text: fmtTime(((s.beat.duration || 0) - (s.beat.trim || 0)) / beatRate(s)) }),
          beatRate(s) !== 1 || s.transpose ? el("span", { class: "fx-tag", text: [beatRate(s) !== 1 ? `${Math.round(s.bpmExact)} BPM` : "", s.transpose ? `${s.transpose > 0 ? "+" : ""}${s.transpose} HT` : ""].filter(Boolean).join(" · ") }) : null,
          s.beat.trim ? el("span", { text: `Start ab ${fmtTime(s.beat.trim)}` }) : null,
        ]),
      ]),
      el("div", { class: "track-btns" }, [mBtn, sBtn, more]),
    ]);
    const card = el("div", { class: "track-card" + (beatSilent(s) ? " muted" : "") }, [row, fader]);
    const trimBtn = el("button", { class: "mini-action", html: `${ICONS.scissors}<span>Trimmen</span>` });
    trimBtn.addEventListener("click", (e) => { e.stopPropagation(); enterTrimMode(); });
    const actions = el("div", { class: "track-actions" }, [trimBtn]);
    if (E.beatBuf && !S.trimMode) {
      const sil = detectSilenceCached(s);
      const lead = (sil.start - (s.beat.trim || 0)) / beatRate(s);
      if (lead > 0.25) {
        const fix = el("button", { class: "mini-action warn", html: `<span>${lead.toFixed(1).replace(".", ",")} s Stille am Anfang · Entfernen</span>` });
        fix.addEventListener("click", (e) => { e.stopPropagation(); applyTrimShift(lead); S.pos = 0; renderAll(); toast("Stille entfernt"); });
        actions.appendChild(fix);
      }
    }
    card.appendChild(actions);
    list.appendChild(card);
  } else {
    const add = el("button", { class: "track-add", html: `${ICONS.plus}<span>Beat laden</span>` });
    add.addEventListener("click", pickBeat);
    list.appendChild(add);
  }

  // Takes
  if (!s.takes.length) {
    list.appendChild(el("div", { class: "track-empty", text: "Noch keine Takes. Tippe auf den roten Knopf, um aufzunehmen." }));
    return;
  }
  const solo = anySolo();
  s.takes.forEach((t) => {
    const mBtn = el("button", { class: "ms-btn" + (t.muted ? " on-m" : ""), text: "M", "aria-label": "Stumm" });
    mBtn.addEventListener("click", (e) => { e.stopPropagation(); t.muted = !t.muted; applyMix(); saveSong(); renderTracks(); renderAll(); });
    const sBtn = el("button", { class: "ms-btn" + (t.solo ? " on-s" : ""), text: "S", "aria-label": "Solo" });
    sBtn.addEventListener("click", (e) => { e.stopPropagation(); t.solo = !t.solo; haptic(); applyMix(); saveSong(); renderTracks(); renderAll(); });
    const more = el("button", { class: "more-btn", html: ICONS.more, "aria-label": "Take-Optionen" });
    more.addEventListener("click", (e) => { e.stopPropagation(); openTakeSheet(t.id); });
    const name = el("button", { class: "track-name", text: t.name });
    name.addEventListener("click", async (e) => {
      e.stopPropagation();
      const v = await sheetPrompt("Take umbenennen", t.name, "Name");
      if (v && v.trim()) { t.name = v.trim(); saveSong(); renderTracks(); renderAll(); }
    });
    const fader = makeFader({
      id: `meter-${t.id}`, db: dbLoad(t.gainDb), label: `${t.name} Lautstärke`,
      onChange: (d) => { t.gainDb = dbStore(d); applyMix(); saveSong(); },
    });
    const row = el("div", { class: "track" + (S.selTakeId === t.id ? " selected" : "") + (t.muted || (solo && !t.solo) ? " muted" : "") }, [
      el("span", { class: "track-color", style: { background: `linear-gradient(135deg, ${t.color}, ${hexA(t.color, 0.55)})` }, html: ICONS.mic }),
      el("div", { class: "track-main" }, [
        name,
        el("div", { class: "track-meta" }, [
          el("span", { text: `Start ${fmtTime(Math.max(0, t.offset))}` }),
          el("span", { text: `Länge ${fmtTime(t.duration)}` }),

        ]),
      ]),
      el("div", { class: "track-btns" }, [mBtn, sBtn, more]),
    ]);
    row.addEventListener("click", () => {
      S.selTakeId = t.id;
      seek(Math.max(0, t.offset));
      renderTracks();
    });
    const muted = t.muted || (solo && !t.solo);
    const fxOn = !!(t.fx && t.fx.on);
    const fxBtn = el("button", { class: "fx-btn" + (fxOn ? " on" : ""), "data-id": t.id, "aria-label": "FX", "aria-pressed": String(fxOn) }, [
      el("span", { text: "FX" }),
    ]);
    let lpFx = null;
    fxBtn.addEventListener("pointerdown", (e) => { e.stopPropagation(); lpFx = setTimeout(() => { lpFx = "done"; haptic(12); openFxSheet(t.id); }, 450); });
    fxBtn.addEventListener("pointerup", (e) => { e.stopPropagation(); if (lpFx !== "done") { clearTimeout(lpFx); toggleTakeFx(t); } lpFx = null; });
    fxBtn.addEventListener("pointercancel", () => { clearTimeout(lpFx); lpFx = null; });
    fxBtn.addEventListener("click", (e) => e.stopPropagation());
    fxBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    const fxInfo = fxOn ? el("span", { class: "fx-info", text: [
      FX_PRESETS[t.fx.preset] ? FX_PRESETS[t.fx.preset].label : "Eigene FX",
      t.fx.tune !== "off" ? `Tune ${s.key || "chrom."}` : "",
    ].filter(Boolean).join(" · ") }) : null;
    if (t.clean === "done" || t.clean === "processing") {
      const cBtn = el("button", { class: "clean-btn" + (t.cleanOn && t.clean === "done" ? " on" : ""), "aria-label": "Clean an/aus", text: t.clean === "processing" ? "…" : "Clean" });
      cBtn.addEventListener("click", (e) => { e.stopPropagation(); if (t.clean === "done") toggleCleanTake(t); });
      fader.appendChild(cBtn);
    }
    fader.appendChild(fxBtn);
    const card = el("div", { class: "track-card" + (S.selTakeId === t.id ? " selected" : "") + (muted ? " muted" : "") }, [row, fader]);
    if (fxInfo) card.appendChild(fxInfo);
    list.appendChild(card);
  });
}

/* Pegel der Spuren beim Abspielen (grün/gelb/rot) */
const meterBuf = new Float32Array(1024);
function updateTrackMeters() {
  if (!S.song || S.tab !== "studio") return;
  const setM = (id, analyser) => {
    const m = document.getElementById(id);
    if (!m) return;
    let peak = 0;
    if (analyser && S.playing) {
      analyser.getFloatTimeDomainData(meterBuf);
      for (let i = 0; i < meterBuf.length; i++) { const a = Math.abs(meterBuf[i]); if (a > peak) peak = a; }
    }
    const pos = dbToPos(gainToDb(peak)) * 100;
    const now = performance.now();
    if (pos >= m._pk || now - m._pkT > 1500) { m._pk = pos; m._pkT = now; }
    if (m._fill) {
      m._fill.style.setProperty("--lvl", pos + "%");
      m._peak.style.left = m._pk + "%";
      m._peak.classList.toggle("on", m._pk > 1);
      m._peak.classList.toggle("clip", m._pk >= FADER_UNITY * 100 - 0.5);
    }
  };
  setM("meter-beat", E.beatAnalyser);
  for (const t of S.song.takes) {
    const n = E.takes.get(t.id);
    setM(`meter-${t.id}`, n && n.analyser);
  }
}

/* ---------- Beat laden ---------- */
let pendingNewSongForBeat = false;
function pickBeat(newSong = false) {
  pendingNewSongForBeat = newSong === true;
  const inp = $("#beat-input");
  inp.value = "";
  inp.click();
}

async function onBeatFile(file) {
  if (!file) return;
  if (pendingNewSongForBeat || !S.song) {
    pendingNewSongForBeat = false;
    S.tab = "studio";
    await openSong(await createSong());
  }
  const s = S.song;
  toast("Beat wird geladen …", 4000);
  $("#chip-bpm").classList.add("analyzing");
  $("#chip-key").classList.add("analyzing");
  try {
    ensureCtx();
    const buf = await decodeBlob(file);
    if (S.playing) pause();
    E.beatBuf = buf;
    E.beatPeaks = computePeaks(buf);
    E.beatProc = null;
    const cleanName = file.name.replace(/\.[^.]+$/, "");
    s.beat = { name: cleanName, duration: buf.duration, trim: 0, type: file.type };
    if (/^Neuer Song|^Neue Aufnahme/.test(s.name)) s.name = cleanName;
    S.pos = 0;
    await Store.putBlob(`beat:${s.id}`, file);
    saveSongNow();
    renderSong();
    // Analyse im Hintergrund
    setTimeout(() => {
      try {
        if (!s.bpmManual) {
          const bpm = estimateBpm(buf);
          if (bpm) {
            s.bpm = bpm;
            const grid = analyzeGrid(buf, bpm);
            if (grid) { s.bpmExact = grid.bpm; s.bpm = Math.round(grid.bpm); s.gridOffset = grid.offset - (s.beat.trim || 0); s.snap = true; }
            s.beat.origBpm = s.bpmExact || s.bpm;
          }
        }
        if (!s.keyManual) { const key = estimateKey(buf); if (key) { s.key = key; s.beat.origKey = key; } }
        s.transpose = 0;
      } catch (err) { console.warn(err); }
      $("#chip-bpm").classList.remove("analyzing");
      $("#chip-key").classList.remove("analyzing");
      saveSong();
      renderChips();
      renderAll();
      toast(`Beat erkannt${s.bpm ? " · " + s.bpm + " BPM · 4/4" : ""}${s.key ? " · " + s.key : ""}`, 3000);
    }, 60);
  } catch (err) {
    console.warn(err);
    $("#chip-bpm").classList.remove("analyzing");
    $("#chip-key").classList.remove("analyzing");
    sheetAlert("Beat konnte nicht geladen werden", "Diese Datei kann nicht gelesen werden. Versuch es mit MP3, WAV oder M4A.");
  }
}

/* ---------- Song-Liste ---------- */
async function loadSongs() {
  S.songs = (await Store.allSongs()).sort((a, b) => b.updatedAt - a.updatedAt);
}

function renderLibrary() {
  const list = $("#lib-list");
  const q = ($("#lib-search").value || "").trim().toLowerCase();
  list.innerHTML = "";
  const songs = S.songs.filter((s) => !q || s.name.toLowerCase().includes(q));
  $("#lib-empty").classList.toggle("hidden", S.songs.length > 0);
  for (const s of songs) {
    const tags = el("span", { class: "song-row-tags" }, [
      s.bpm ? el("span", { class: "song-tag", text: `${s.bpm} BPM` }) : null,
      s.key ? el("span", { class: "song-tag", text: s.key }) : null,
    ]);
    const seed = s.id.split("").reduce((a, c) => a + c.charCodeAt(0), 0);
    const hues = [275, 305, 335, 250, 215, 15];
    const hue = hues[seed % hues.length];
    const art = el("span", { class: "song-art", style: { background: `linear-gradient(135deg, hsl(${hue} 85% 62%), hsl(${(hue + 40) % 360} 80% 42%))` } });
    for (let i = 0; i < 7; i++) {
      const h = 8 + Math.abs(Math.sin(seed * 0.37 + i * 1.1)) * 26;
      art.appendChild(el("i", { style: { height: h + "px" } }));
    }
    const row = el("button", { class: "song-row" }, [
      art,
      el("div", { class: "song-row-main" }, [
        el("div", { class: "song-row-title", text: s.name }),
        el("div", { class: "song-row-meta" }, [
          el("span", { text: fmtDate(s.updatedAt) }),
          el("span", { text: fmtTime(s.duration || 0) }),
          s.takes && s.takes.length ? el("span", { text: `${s.takes.length} Take${s.takes.length > 1 ? "s" : ""}` }) : null,
        ]),
      ]),
      tags,
    ]);
    let lp = null;
    row.addEventListener("pointerdown", () => { lp = setTimeout(() => { lp = "done"; haptic(); openSongRowSheet(s); }, 500); });
    row.addEventListener("pointerup", () => { if (lp !== "done") clearTimeout(lp); });
    row.addEventListener("pointercancel", () => clearTimeout(lp));
    row.addEventListener("contextmenu", (e) => e.preventDefault());
    row.addEventListener("click", () => { if (lp === "done") { lp = null; return; } openSong(s); });
    list.appendChild(row);
  }
  if (q && !songs.length) list.appendChild(el("div", { class: "track-empty", text: `Kein Song mit „${q}“.` }));
}

async function createSong(name) {
  const s = newSong(name);
  S.songs.unshift(s);
  await Store.putSong(s);
  return s;
}

async function openSong(song) {
  S.editSecId = null;
  S.trimMode = false;
  if ($("#trim-edit")) $("#trim-edit").classList.add("hidden");
  if ($("#sec-edit")) $("#sec-edit").classList.add("hidden");
  if (S.playing) pause();
  S.song = song;
  S.pos = 0;
  S.selTakeId = null;
  E.beatBuf = null;
  E.beatPeaks = null;
  E.beatProc = null;
  E.takes.forEach((n) => { try { n.gain && n.gain.disconnect(); n.analyser && n.analyser.disconnect(); } catch {} });
  E.takes = new Map();
  showScreen("song");
  setTab(S.tab || "studio");
  renderSong();

  // Audio laden
  ensureCtx();
  const loads = [];
  if (song.beat) {
    loads.push((async () => {
      const blob = await Store.getBlob(`beat:${song.id}`);
      if (!blob) return;
      const buf = await decodeBlob(blob);
      if (S.song !== song) return;
      E.beatBuf = buf;
      E.beatPeaks = computePeaks(buf);
      song.beat.duration = buf.duration;
    })().catch((e) => console.warn("Beat laden", e)));
  }
  for (const t of song.takes) {
    loads.push((async () => {
      const blob = await Store.getBlob(`take:${t.id}`);
      if (!blob) return;
      const buf = await decodeBlob(blob);
      if (S.song !== song) return;
      const n = ensureTakeNodes(t.id);
      n.buf = buf;
      n.peaks = computePeaks(buf);
      t.duration = buf.duration;
      if (t.clean === "done") {
        const cb = await Store.getBlob(`take:${t.id}:clean`);
        if (cb) n.cleanBuf = await decodeBlob(cb); else t.clean = null;
      }
    })().catch((e) => console.warn("Take laden", e)));
  }
  await Promise.all(loads);
  if (S.song === song) {
    applyMix(); renderSong(); ensureBeatProcessed();
    song.takes.forEach((t) => applyTakeFx(t));
    ensureAllTuned();
  }
  return song;
}

function closeSong() {
  exitSectionEdit();
  exitTrimMode();
  if (S.recording) stopRecording();
  if (S.playing) pause();
  closeLive();
  saveSongNow().then(async () => {
    await loadSongs();
    renderLibrary();
  });
  showScreen("library");
}

function showScreen(name) {
  $("#screen-library").classList.toggle("active", name === "library");
  $("#screen-song").classList.toggle("active", name === "song");
}

/* ---------- Song-Ansicht ---------- */
function renderSong() {
  const s = S.song;
  if (!s) return;
  $("#song-title").textContent = s.name;
  renderChips();
  updateMetroButton();
  renderSections();
  renderTagGrid();
  renderTracks();
  renderLyrics();
  $("#ideas-text").value = s.notes || "";
  $("#wave-empty").classList.toggle("hidden", !!(s.beat || s.takes.length));
  requestAnimationFrame(() => { resizeWave(); renderAll(); });
}

function renderChips() {
  const s = S.song;
  $("#bpm-val").textContent = s.bpm ? s.bpm : "–";
  $("#key-val").textContent = s.key || "–";
  const tempoChanged = s.beat && Math.abs(beatRate(s) - 1) > 0.0005;
  $("#chip-bpm").classList.toggle("on", !!tempoChanged);
  $("#chip-key").classList.toggle("on", !!(s.beat && s.transpose));
  $("#chip-key .chip-unit").textContent = s.beat && s.transpose ? `${s.transpose > 0 ? "+" : ""}${s.transpose} HT` : "Tonart";
}

function setTab(tab) {
  S.tab = tab;
  $$("#song-tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $("#song-tabs").classList.toggle("right", tab === "lyrics");
  $("#view-studio").classList.toggle("active", tab === "studio");
  $("#view-lyrics").classList.toggle("active", tab === "lyrics");
  if (tab === "studio") requestAnimationFrame(() => { resizeWave(); renderAll(); });
  if (tab === "lyrics") { renderLyrics(); requestAnimationFrame(autosizeAll); }
}

let lastSectionIdShown = undefined;
function renderFrame(pos) {
  const d = songDuration();
  if (S.tab === "studio") {
    if (W.layoutRec !== S.recording || W.layoutTakes !== (S.song ? S.song.takes.length : 0)) resizeWave();
    drawWave(pos);
    drawOverview(pos);
    $("#big-time").textContent = fmtTime(Math.max(0, pos), true);
    updateTrackMeters();
  }
  const sec = sectionAt(pos);
  const secId = sec ? sec.id : null;
  const rem = (d > 0 ? `–${fmtTime(Math.max(0, d - pos))}` : "") + (beatLen() && pos >= 0 ? ` &nbsp; <span class="bar-pos">${barLabel(pos)}</span>` : "");
  $("#time-sub").innerHTML = pos < 0
    ? `<b>Einzählen …</b>`
    : sec ? `<b style="color:${typeColor(sec.type)}">${escapeHtml(sec.label)}</b> &nbsp; ${rem}` : rem || "&nbsp;";
  $("#now-time").textContent = `${fmtTime(Math.max(0, pos))} / ${fmtTime(d)}`;
  if (secId !== lastSectionIdShown) {
    lastSectionIdShown = secId;
    $("#now-section").textContent = sec ? sec.label : (S.song && S.song.sections.length ? "Vor dem ersten Teil" : "Keine Songteile");
    $("#now-dot").style.background = sec ? typeColor(sec.type) : "";
    $$(".sec-chip").forEach((c) => c.classList.toggle("now", c.dataset.id === secId));
    highlightLyricsSection(sec);
  }
  if (S.liveOpen) renderLive(pos);
}

function renderAll() {
  if (!S.song) return;
  renderFrame(getPos());
  $("#wave-empty").classList.toggle("hidden", !!(S.song.beat || S.song.takes.length || S.recording));
}

function updatePlayButtons() {
  ["#btn-play", "#dock-play", "#live-play"].forEach((sel) => $(sel).classList.toggle("playing", S.playing));
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- LYRICS ---------- */
/*
  Lyrics sind in Blöcke aufgeteilt (Intro, Verse 1, Hook …).
  Ein Block gehört zu einem Songteil mit demselben Namen.
  Beispiel: Tag "Hook" im Beat (auch mehrfach) → Block "Hook".
*/
function lyricsBlockForSection(sec) {
  if (!sec || !S.song) return null;
  const blocks = S.song.lyrics;
  const lbl = sec.label.trim().toLowerCase();
  return blocks.find((b) => b.label.trim().toLowerCase() === lbl)
    || (sec.type !== "custom" ? blocks.find((b) => b.type === sec.type) : null)
    || null;
}

function sectionsForBlock(block) {
  if (!S.song) return [];
  return sortedSections().filter((sec) => lyricsBlockForSection(sec) === block);
}

function newLyricsBlock(type, label) {
  const def = SECTION_TYPES[type] || SECTION_TYPES.custom;
  let lbl = label;
  if (!lbl) {
    if (def.numbered) {
      const n = S.song.lyrics.filter((b) => b.type === type).length + 1;
      lbl = `${def.label} ${n}`;
    } else {
      lbl = def.label;
      const same = S.song.lyrics.filter((b) => b.label === lbl).length;
      if (same) lbl = `${def.label} ${same + 1}`;
    }
  }
  return { id: uid(), type, label: lbl, text: "" };
}

function renderLyrics() {
  const wrap = $("#lyr-blocks");
  if (!wrap || !S.song) return;
  const s = S.song;
  wrap.innerHTML = "";

  // Hinweis: Tags im Beat ohne Lyrics-Block
  const missing = [];
  const seen = new Set();
  for (const sec of sortedSections()) {
    const key = sec.label.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    if (!lyricsBlockForSection(sec)) missing.push(sec);
  }
  const hint = $("#lyr-sync-hint");
  if (missing.length) {
    hint.classList.remove("hidden");
    hint.innerHTML = "";
    hint.appendChild(el("span", { class: "flex1", text: `${missing.length} Songteil${missing.length > 1 ? "e" : ""} aus dem Beat ohne Lyrics.` }));
    const b = el("button", { text: "Übernehmen" });
    b.addEventListener("click", () => {
      for (const sec of missing) s.lyrics.push({ id: uid(), type: sec.type, label: sec.label, text: "" });
      // nach Zeit sortieren
      s.lyrics.sort((a, b2) => blockOrderTime(a) - blockOrderTime(b2));
      saveSong();
      renderLyrics();
      requestAnimationFrame(autosizeAll);
    });
    hint.appendChild(b);
  } else hint.classList.add("hidden");

  if (!s.lyrics.length) {
    wrap.appendChild(el("div", { class: "track-empty", text: "Füge unten einen Teil hinzu – z. B. Verse oder Hook – und schreib los." }));
  }

  for (const block of s.lyrics) {
    const col = typeColor(block.type);
    const ta = el("textarea", { class: "lyr-text", rows: 2, placeholder: "Schreib deine Zeilen …", spellcheck: "false" });
    ta.value = block.text;
    const foot = el("div", { class: "lyr-foot" });
    const updFoot = () => {
      const lines = block.text.split("\n").filter((l) => l.trim()).length;
      foot.textContent = "";
      foot.appendChild(el("span", { text: lines ? `${lines} Zeile${lines > 1 ? "n" : ""}` : "" }));
      foot.appendChild(el("span", { text: lines ? `${countSyllables(block.text)} Silben` : "" }));
    };
    ta.addEventListener("input", () => { block.text = ta.value; autosize(ta); updFoot(); saveSong(); });
    updFoot();

    const secs = sectionsForBlock(block);
    const timeBadges = secs.slice(0, 3).map((sec) => {
      const b = el("button", { class: "lyr-time", text: fmtTime(sec.time) });
      b.addEventListener("click", () => { seek(sec.time); haptic(); });
      return b;
    });
    const label = el("button", { class: "lyr-label", text: block.label });
    label.addEventListener("click", () => openLyricsBlockSheet(block));
    const more = el("button", { class: "more-btn", html: ICONS.more, "aria-label": "Optionen" });
    more.addEventListener("click", () => openLyricsBlockSheet(block));

    const card = el("div", { class: "lyr-block", "data-id": block.id }, [
      el("div", { class: "lyr-block-head" }, [label, el("span", { class: "lyr-now-badge", text: "Jetzt" }), ...timeBadges, el("span", { class: "flex1" }), more]),
      ta,
      foot,
    ]);
    card.style.setProperty("--c", col);
    wrap.appendChild(card);
  }

  // Schnell-Hinzufügen
  const row = $("#lyr-add-row");
  row.innerHTML = "";
  for (const type of ["intro", "verse", "pre", "hook", "bridge", "outro", "custom"]) {
    const b = el("button", { text: type === "custom" ? "Eigener" : SECTION_TYPES[type].label });
    b.style.setProperty("--c", typeColor(type));
    b.addEventListener("click", async () => {
      let label = null;
      if (type === "custom") {
        label = await sheetPrompt("Eigener Teil", "", "z. B. Adlibs, Spoken Word");
        if (!label) return;
      }
      const blk = newLyricsBlock(type, label && label.trim());
      s.lyrics.push(blk);
      saveSong();
      renderLyrics();
      requestAnimationFrame(() => {
        autosizeAll();
        const ta = $(`.lyr-block[data-id="${blk.id}"] textarea`);
        if (ta) { ta.focus(); ta.scrollIntoView({ block: "center", behavior: "smooth" }); }
      });
    });
    row.appendChild(b);
  }
  lastSectionIdShown = undefined;
  highlightLyricsSection(sectionAt(getPos()));
  $("#lyr-follow").classList.toggle("on", !!Settings.follow);
}

function blockOrderTime(block) {
  const secs = sectionsForBlock(block);
  return secs.length ? secs[0].time : 1e9;
}

function autosize(ta) {
  ta.style.height = "auto";
  ta.style.height = ta.scrollHeight + "px";
}
function autosizeAll() { $$(".lyr-text").forEach(autosize); }

function highlightLyricsSection(sec) {
  const block = lyricsBlockForSection(sec);
  let active = null;
  $$(".lyr-block").forEach((c) => {
    const on = block && c.dataset.id === block.id;
    c.classList.toggle("now", !!on);
    if (on) active = c;
  });
  if (active && Settings.follow && S.playing && S.tab === "lyrics" && !(document.activeElement && document.activeElement.classList.contains("lyr-text"))) {
    active.scrollIntoView({ block: "start", behavior: "smooth" });
  }
}

/* Silben zählen (grob, für Deutsch/Englisch/Schweizerdeutsch) */
function countSyllables(text) {
  const words = text.toLowerCase().match(/[a-zäöüàéèß']+/g) || [];
  let n = 0;
  for (const w of words) {
    const groups = w.match(/[aeiouyäöüàéè]+/g);
    n += Math.max(1, groups ? groups.length : 1);
  }
  return n;
}

/* ---------- LIVE-MODUS (Karaoke / Teleprompter) ---------- */
let liveState = { secId: undefined, line: -1, manualScrollUntil: 0 };

function openLive() {
  if (!S.song) return;
  S.liveOpen = true;
  $("#live").classList.remove("hidden");
  document.documentElement.style.setProperty("--live-size", Settings.liveSize + "px");
  $("#live").style.setProperty("--live-size", Settings.liveSize + "px");
  liveState = { secId: undefined, line: -1, manualScrollUntil: 0 };
  renderLive(getPos(), true);
  // Wake Lock: Bildschirm bleibt an
  try { if (navigator.wakeLock) navigator.wakeLock.request("screen").then((l) => (liveState.lock = l)).catch(() => {}); } catch {}
}

function closeLive() {
  S.liveOpen = false;
  $("#live").classList.add("hidden");
  try { liveState.lock && liveState.lock.release(); } catch {}
}

function renderLive(pos, force = false) {
  const s = S.song;
  if (!s) return;
  const body = $("#live-body");
  const d = songDuration();
  $("#live-time").textContent = fmtTime(Math.max(0, pos));
  const secs = sortedSections();
  const sec = sectionAt(pos);

  // --- Kein Arrangement: Teleprompter mit allen Lyrics ---
  if (!secs.length) {
    if (force || liveState.secId !== "all") {
      liveState.secId = "all";
      body.innerHTML = "";
      $("#live-section").textContent = "Alle Lyrics";
      $("#live").style.setProperty("--c", "var(--accent)");
      $("#live-next").textContent = "Tipp: Setze im Studio Songteile, dann läuft der Text automatisch mit.";
      if (!s.lyrics.some((b) => b.text.trim())) {
        body.appendChild(el("div", { class: "live-empty", text: "Noch keine Lyrics geschrieben." }));
      }
      for (const b of s.lyrics) {
        if (!b.text.trim()) continue;
        const lab = el("div", { class: "live-sec-label", text: b.label });
        lab.style.setProperty("--c", typeColor(b.type));
        body.appendChild(lab);
        b.text.split("\n").filter((l) => l.trim()).forEach((l) => body.appendChild(el("div", { class: "live-line next1", text: l })));
      }
    }
    $("#live-progress-fill").style.width = d ? `${(pos / d) * 100}%` : "0";
    if (S.playing && d > 0 && performance.now() > liveState.manualScrollUntil) {
      const max = body.scrollHeight - body.clientHeight;
      body.style.scrollBehavior = "auto";
      body.scrollTop = (pos / d) * max;
    }
    return;
  }

  // --- Mit Arrangement: aktueller Teil, Zeile für Zeile ---
  const secId = sec ? sec.id : null;
  const block = lyricsBlockForSection(sec);
  const lines = block ? block.text.split("\n").filter((l) => l.trim()) : [];
  const r = sec ? sectionRange(sec) : { start: 0, end: secs[0].time };
  const local = clamp((pos - r.start) / Math.max(0.1, r.end - r.start), 0, 0.9999);
  const lineIdx = lines.length ? Math.floor(local * lines.length) : -1;
  $("#live-progress-fill").style.width = `${local * 100}%`;

  if (force || secId !== liveState.secId) {
    liveState.secId = secId;
    liveState.line = -1;
    body.innerHTML = "";
    const col = sec ? typeColor(sec.type) : "#8e8e93";
    $("#live").style.setProperty("--c", col);
    $("#live-section").textContent = sec ? sec.label : "Vor dem ersten Teil";
    const list = sortedSections();
    const i = sec ? list.findIndex((x) => x.id === sec.id) : -1;
    const nxt = list[i + 1];
    $("#live-next").textContent = nxt ? `Als Nächstes: ${nxt.label}` : sec ? "Letzter Teil" : `Startet mit ${list[0].label}`;
    if (!sec) {
      const first = lyricsBlockForSection(list[0]);
      const preview = first ? first.text.split("\n").filter((l) => l.trim()).slice(0, 2) : [];
      body.appendChild(el("div", { class: "live-empty", text: `${list[0].label} startet bei ${fmtTime(list[0].time)}` }));
      preview.forEach((l) => body.appendChild(el("div", { class: "live-line next1", text: l })));
    } else if (!lines.length) {
      body.appendChild(el("div", { class: "live-empty", text: block ? `Noch kein Text für ${sec.label}.` : `Kein Lyrics-Block „${sec.label}“. Im Lyrics-Tab auf „Übernehmen“ tippen.` }));
    } else {
      lines.forEach((l, k) => body.appendChild(el("div", { class: "live-line", "data-k": k, text: l })));
    }
  }
  if (lines.length && lineIdx !== liveState.line) {
    liveState.line = lineIdx;
    $$(".live-line", body).forEach((n) => {
      const k = +n.dataset.k;
      n.className = "live-line" + (k < lineIdx ? " past" : k === lineIdx ? " active" : k === lineIdx + 1 ? " next1" : "");
    });
    const act = $(`.live-line[data-k="${lineIdx}"]`, body);
    if (act && performance.now() > liveState.manualScrollUntil) {
      body.style.scrollBehavior = "smooth";
      body.scrollTop = act.offsetTop - body.clientHeight * 0.32;
    }
  }
}

function liveJump(dir) {
  const list = sortedSections();
  if (!list.length) { seek(getPos() + dir * 15); return; }
  const pos = getPos();
  const cur = sectionAt(pos);
  let i = cur ? list.findIndex((x) => x.id === cur.id) : -1;
  // Zurück: erst an den Anfang des aktuellen Teils, dann zum vorherigen
  if (!(dir < 0 && cur && pos - cur.time > 1.5)) i = i + dir;
  i = clamp(i, 0, list.length - 1);
  haptic();
  seek(list[i].time);
}

/* ===================== 9. SHEETS ===================== */
let sheetResolve = null;
function openSheet(build) {
  const content = $("#sheet-content");
  content.innerHTML = "";
  build(content);
  $("#sheet").classList.remove("hidden");
  $("#sheet-backdrop").classList.remove("hidden");
}
function closeSheet(result) {
  $("#sheet").classList.add("hidden");
  $("#sheet-backdrop").classList.add("hidden");
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  const r = sheetResolve;
  sheetResolve = null;
  if (r) r(result);
}

function sheetItem(icon, label, onClick, opts = {}) {
  const b = el("button", { class: "sheet-item" + (opts.danger ? " danger" : "") + (opts.disabled ? " disabled" : ""), html: (ICONS[icon] || "") });
  b.appendChild(el("span", { text: label }));
  if (opts.note) b.appendChild(el("span", { class: "sheet-item-note", text: opts.note }));
  b.addEventListener("click", () => {
    if (opts.disabled) return;
    if (opts.keepOpen) onClick(); else { closeSheet(); onClick && onClick(); }
  });
  return b;
}

function sheetHeader(root, title, sub) {
  root.appendChild(el("h3", { text: title }));
  if (sub) root.appendChild(el("p", { class: "sheet-sub", text: sub }));
}

function sheetCancel(root, label = "Fertig") {
  const b = el("button", { class: "sheet-cancel", text: label });
  b.addEventListener("click", () => closeSheet(null));
  root.appendChild(b);
}

function sheetPrompt(title, value = "", placeholder = "") {
  return new Promise((resolve) => {
    sheetResolve = resolve;
    openSheet((root) => {
      sheetHeader(root, title);
      const inp = el("input", { class: "sheet-input", type: "text", placeholder, autocomplete: "off" });
      inp.value = value;
      root.appendChild(inp);
      const ok = el("button", { class: "primary", text: "Sichern" });
      const cancel = el("button", { text: "Abbrechen" });
      ok.addEventListener("click", () => closeSheet(inp.value));
      cancel.addEventListener("click", () => closeSheet(null));
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") closeSheet(inp.value); });
      root.appendChild(el("div", { class: "sheet-row" }, [cancel, ok]));
      setTimeout(() => { inp.focus(); inp.select(); }, 60);
    });
  });
}

function sheetConfirm(title, text, okLabel = "Löschen", danger = true) {
  return new Promise((resolve) => {
    sheetResolve = resolve;
    openSheet((root) => {
      sheetHeader(root, title, text);
      const ok = el("button", { class: danger ? "danger" : "primary", text: okLabel });
      const cancel = el("button", { text: "Abbrechen" });
      ok.addEventListener("click", () => closeSheet(true));
      cancel.addEventListener("click", () => closeSheet(false));
      root.appendChild(el("div", { class: "sheet-row" }, [cancel, ok]));
    });
  });
}

function sheetAlert(title, text) {
  openSheet((root) => { sheetHeader(root, title, text); sheetCancel(root, "OK"); });
}

function toggleRow(label, sub, value, onChange) {
  const sw = el("button", { class: "switch" + (value ? " on" : ""), "aria-label": label, role: "switch", "aria-checked": String(!!value) });
  sw.addEventListener("click", () => {
    value = !value;
    sw.classList.toggle("on", value);
    sw.setAttribute("aria-checked", String(value));
    onChange(value);
  });
  return el("div", { class: "toggle-row" }, [el("div", {}, [label, sub ? el("small", { text: sub }) : null]), sw]);
}

/* ---------- Song-Menü ---------- */
function openSongMenu() {
  const s = S.song;
  openSheet((root) => {
    sheetHeader(root, s.name);
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("pencil", "Song umbenennen", renameSong),
      sheetItem("music", s.beat ? "Beat ersetzen" : "Beat laden", pickBeat),
      sheetItem("mic", "Audiodatei als Take laden", pickTakeFile),
      sheetItem("share", "Mix exportieren (WAV)", exportMix, { disabled: !(s.beat || s.takes.length) }),
      sheetItem("copy", "Lyrics kopieren", copyLyrics),
      sheetItem("gear", "Einstellungen", openSettingsSheet),
    ]));
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("trash", "Song löschen", deleteCurrentSong, { danger: true }),
    ]));
    sheetCancel(root, "Abbrechen");
  });
}

async function renameSong() {
  const v = await sheetPrompt("Song umbenennen", S.song.name, "Songname");
  if (v && v.trim()) { S.song.name = v.trim(); $("#song-title").textContent = S.song.name; saveSong(); }
}

async function deleteCurrentSong() {
  const s = S.song;
  const ok = await sheetConfirm("Song löschen?", `„${s.name}“ mit Beat, allen Takes und Lyrics wird gelöscht.`);
  if (!ok) return;
  if (S.playing) pause();
  await Store.deleteSong(s);
  S.songs = S.songs.filter((x) => x.id !== s.id);
  S.song = null;
  renderLibrary();
  showScreen("library");
  toast("Song gelöscht");
}

function openSongRowSheet(song) {
  openSheet((root) => {
    sheetHeader(root, song.name);
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("pencil", "Umbenennen", async () => {
        const v = await sheetPrompt("Song umbenennen", song.name, "Songname");
        if (v && v.trim()) { song.name = v.trim(); await Store.putSong(song); renderLibrary(); }
      }),
      sheetItem("trash", "Löschen", async () => {
        const ok = await sheetConfirm("Song löschen?", `„${song.name}“ wird komplett gelöscht.`);
        if (!ok) return;
        await Store.deleteSong(song);
        S.songs = S.songs.filter((x) => x.id !== song.id);
        renderLibrary();
      }, { danger: true }),
    ]));
    sheetCancel(root, "Abbrechen");
  });
}

/* ---------- BPM ---------- */
function openBpmSheet() {
  const s = S.song;
  let bpm = s.bpm || 90;
  const taps = [];
  openSheet((root) => {
    const orig = s.beat ? (s.beat.origBpm || s.bpmExact || s.bpm) : 0;
    sheetHeader(root, "Tempo & Takt", s.beat
      ? `Original: ${String(Math.round(orig * 10) / 10).replace(".", ",")} BPM. Ändern macht den Beat schneller oder langsamer – die Tonart bleibt gleich.`
      : "Fürs Metronom und das Taktraster.");
    const val = el("span", { class: "stepper-val", text: bpm });
    const set = (v) => { bpm = clamp(Math.round(v), 40, 240); val.textContent = bpm; };
    const minus = el("button", { text: "–" }); minus.addEventListener("click", () => set(bpm - 1));
    const plus = el("button", { text: "+" }); plus.addEventListener("click", () => set(bpm + 1));
    root.appendChild(el("div", { class: "stepper" }, [minus, val, plus]));
    const quick = [];
    if (s.beat) {
      const o = el("button", { text: `Original ${Math.round(orig)}` }); o.addEventListener("click", () => set(orig));
      const m5 = el("button", { text: "−5" }); m5.addEventListener("click", () => set(bpm - 5));
      const p5 = el("button", { text: "+5" }); p5.addEventListener("click", () => set(bpm + 5));
      quick.push(m5, o, p5);
    } else {
      const half = el("button", { text: "½ halb" }); half.addEventListener("click", () => set(bpm / 2));
      const dbl = el("button", { text: "2× doppelt" }); dbl.addEventListener("click", () => set(bpm * 2));
      quick.push(half, dbl);
    }
    root.appendChild(el("div", { class: "sheet-chips", style: { marginTop: "12px" } }, quick));
    if (s.beat && s.takes.length) root.appendChild(el("p", { class: "sheet-sub", style: { margin: "10px 0 0" }, text: "Achtung: Bereits aufgenommene Takes werden nicht mit gestreckt." }));
    const tap = el("button", { class: "tap-btn", text: "Im Takt tippen" });
    tap.addEventListener("pointerdown", () => {
      const now = performance.now();
      if (taps.length && now - taps[taps.length - 1] > 2000) taps.length = 0;
      taps.push(now);
      if (taps.length > 8) taps.shift();
      if (taps.length >= 3) {
        const iv = (taps[taps.length - 1] - taps[0]) / (taps.length - 1);
        set(60000 / iv);
      }
      haptic(5);
    });
    root.appendChild(tap);

    // --- Taktraster ---
    const info = el("span", { text: "" });
    const updInfo = () => {
      const off = gridOffset();
      info.textContent = beatLen() ? `Takt 1 beginnt bei ${fmtTime(off)},${String(Math.round((off % 1) * 100)).padStart(2, "0")}` : "Noch kein Tempo";
    };
    updInfo();
    const shift = (beats) => {
      if (!beatLen()) return;
      s.gridOffset = gridOffset() + beats * beatLen();
      updInfo(); saveSong(); renderSections(); renderAll();
      if (S.playing && s.metronome) startMetronome(false);
    };
    const here = el("button", { text: "Takt 1 = Playhead" });
    here.addEventListener("click", () => { if (!beatLen()) return; s.gridOffset = getPos(); updInfo(); saveSong(); renderSections(); renderAll(); haptic(); toast("Die 1 liegt jetzt hier"); });
    const minusBeat = el("button", { text: "‹ 1 Schlag" }); minusBeat.addEventListener("click", () => shift(-1));
    const plusBeat = el("button", { text: "1 Schlag ›" }); plusBeat.addEventListener("click", () => shift(1));
    root.appendChild(el("div", { class: "sheet-field" }, [
      el("div", { class: "sheet-field-label" }, [el("span", { text: "Taktraster 4/4" }), el("b", {}, [info])]),
      el("div", { class: "nudge" }, [minusBeat, here, plusBeat]),
    ]));
    const reBtn = s.beat && E.beatBuf ? sheetItem("wave", "Beat neu analysieren", () => {
      const est = estimateBpm(E.beatBuf);
      const grid = est ? analyzeGrid(E.beatBuf, est) : null;
      if (grid) {
        const R = beatRate(s);
        s.beat.origBpm = grid.bpm;
        s.bpmExact = grid.bpm * R; s.bpm = Math.round(s.bpmExact);
        s.gridOffset = (grid.offset - (s.beat.trim || 0)) / R; s.bpmManual = false;
      }
      saveSong(); renderChips(); renderSections(); renderAll();
      toast(grid ? `Neu erkannt · ${s.bpm} BPM` : "Kein klarer Beat gefunden");
    }) : null;
    root.appendChild(el("div", { class: "sheet-group", style: { marginTop: "14px" } }, [
      toggleRow("Songteile am Takt einrasten", "Tags landen immer auf der 1", s.snap !== false, (v) => { s.snap = v; saveSong(); }),
    ]));
    const fixBtn = s.beat ? sheetItem("pencil", "Erkanntes Tempo korrigieren", openOrigBpmSheet, { note: `${Math.round(orig)} BPM` }) : null;
    if (reBtn || fixBtn) root.appendChild(el("div", { class: "sheet-group" }, [fixBtn, reBtn].filter(Boolean)));

    const ok = el("button", { class: "primary", text: "Übernehmen" });
    const cancel = el("button", { text: "Abbrechen" });
    ok.addEventListener("click", () => {
      if (bpm !== s.bpm) {
        if (s.beat) {
          // Beat schneller/langsamer machen (Tonart bleibt)
          const target = Math.abs(bpm - orig) < 0.51 ? orig : bpm;
          const R = target / (s.beat.origBpm || orig);
          if (R < 0.5 || R > 2) { toast("Maximal halbes bis doppeltes Tempo"); return; }
          closeSheet();
          setSongTempo(target);
          if (R < 0.75 || R > 1.33) toast("Starke Änderung – der Klang kann leiden", 2500);
          return;
        }
        const off = gridOffset();
        s.bpm = bpm; s.bpmExact = bpm; s.bpmManual = true; s.gridOffset = off;
      }
      updateFxTempo();
      closeSheet();
      renderChips(); renderSections(); saveSong(); renderAll();
      if (S.playing && s.metronome) startMetronome(false);
    });
    cancel.addEventListener("click", () => closeSheet());
    root.appendChild(el("div", { class: "sheet-row" }, [cancel, ok]));
  });
}

/* ---------- Erkanntes Tempo korrigieren (ohne den Beat zu verändern) ---------- */
function openOrigBpmSheet() {
  const s = S.song;
  let v = Math.round((s.beat.origBpm || s.bpmExact || s.bpm || 90) * 10) / 10;
  openSheet((root) => {
    sheetHeader(root, "Erkanntes Tempo", "Nur korrigieren, falls die Erkennung falsch lag (z. B. halb oder doppelt). Der Beat klingt danach gleich.");
    const val = el("span", { class: "stepper-val", text: String(v).replace(".", ",") });
    const set = (x) => { v = clamp(Math.round(x * 10) / 10, 40, 240); val.textContent = String(v).replace(".", ","); };
    const minus = el("button", { text: "–" }); minus.addEventListener("click", () => set(v - 1));
    const plus = el("button", { text: "+" }); plus.addEventListener("click", () => set(v + 1));
    root.appendChild(el("div", { class: "stepper" }, [minus, val, plus]));
    const half = el("button", { text: "½ halb" }); half.addEventListener("click", () => set(v / 2));
    const dbl = el("button", { text: "2× doppelt" }); dbl.addEventListener("click", () => set(v * 2));
    root.appendChild(el("div", { class: "sheet-chips", style: { marginTop: "12px" } }, [half, dbl]));
    const ok = el("button", { class: "primary", text: "Übernehmen" });
    const cancel = el("button", { text: "Abbrechen" });
    ok.addEventListener("click", () => {
      const R = beatRate(s);
      const off = gridOffset();
      s.beat.origBpm = v;
      s.bpmExact = v * R; s.bpm = Math.round(s.bpmExact); s.bpmManual = true; s.gridOffset = off;
      closeSheet(); renderChips(); renderSections(); saveSong(); renderAll();
      if (S.playing && s.metronome) startMetronome(false);
    });
    cancel.addEventListener("click", () => closeSheet());
    root.appendChild(el("div", { class: "sheet-row" }, [cancel, ok]));
  });
}

/* ---------- Tonart: transponieren + erkannte Tonart korrigieren ---------- */
function openKeySheet() {
  const s = S.song;
  const hasBeat = !!s.beat;
  let orig = hasBeat ? (s.beat.origKey || s.key || "") : (s.key || "");
  let tr = hasBeat ? (s.transpose || 0) : 0;
  let root0 = 9, minor = true;
  const parse = () => { const m = /^([A-G]#?)(m?)$/.exec(orig || ""); if (m) { root0 = NOTE_NAMES.indexOf(m[1]); minor = !!m[2]; } };
  parse();
  openSheet((root) => {
    sheetHeader(root, "Tonart", hasBeat ? "Halbtöne ändern macht den Beat höher oder tiefer – das Tempo bleibt gleich." : "");
    const big = el("span", { class: "stepper-val" });
    const sub = el("p", { class: "sheet-sub", style: { margin: "6px 0 0" } });
    const upd = () => {
      const o = NOTE_NAMES[root0] + (minor ? "m" : "");
      big.textContent = hasBeat ? transposeKey(o, tr) : o;
      sub.textContent = hasBeat ? (tr ? `${tr > 0 ? "+" : ""}${tr} Halbtöne · Original ${o}` : `Original ${o}`) : "";
      renderGrid();
    };
    if (hasBeat) {
      const minus = el("button", { text: "–" }); minus.addEventListener("click", () => { tr = Math.max(-6, tr - 1); upd(); });
      const plus = el("button", { text: "+" }); plus.addEventListener("click", () => { tr = Math.min(6, tr + 1); upd(); });
      root.appendChild(el("div", { class: "stepper" }, [minus, big, plus]));
      root.appendChild(sub);
      const reset = el("button", { text: "Original" }); reset.addEventListener("click", () => { tr = 0; upd(); });
      root.appendChild(el("div", { class: "sheet-chips", style: { marginTop: "10px" } }, [reset]));
    }
    const grid = el("div", { class: "key-grid" });
    const modeRow = el("div", { class: "sheet-chips", style: { marginTop: "10px" } });
    function renderGrid() {
      grid.innerHTML = "";
      NOTE_NAMES.forEach((n, i) => {
        const b = el("button", { class: i === root0 ? "sel" : "", text: n + (minor ? "m" : "") });
        b.addEventListener("click", () => { root0 = i; upd(); });
        grid.appendChild(b);
      });
      modeRow.innerHTML = "";
      const maj = el("button", { class: !minor ? "sel" : "", text: "Dur" });
      const mi = el("button", { class: minor ? "sel" : "", text: "Moll" });
      maj.addEventListener("click", () => { minor = false; upd(); });
      mi.addEventListener("click", () => { minor = true; upd(); });
      modeRow.append(maj, mi);
    }
    root.appendChild(el("div", { class: "sheet-field" }, [
      el("div", { class: "sheet-field-label" }, [el("span", { text: hasBeat ? "Erkannte Tonart des Beats (nur korrigieren, falls falsch)" : "Tonart" })]),
      grid, modeRow,
    ]));
    upd();
    const ok = el("button", { class: "primary", text: "Übernehmen" });
    const cancel = el("button", { text: "Abbrechen" });
    ok.addEventListener("click", () => {
      const o = NOTE_NAMES[root0] + (minor ? "m" : "");
      s.keyManual = true;
      closeSheet();
      if (hasBeat) {
        s.beat.origKey = o;
        if (tr !== (s.transpose || 0)) setTranspose(tr);
        else { s.key = transposeKey(o, tr); saveSong(); renderChips(); }
      } else {
        s.key = o; saveSong(); renderChips();
      }
      ensureAllTuned(); renderTracks();
    });
    cancel.addEventListener("click", () => closeSheet());
    root.appendChild(el("div", { class: "sheet-row" }, [cancel, ok]));
  });
}

/* ---------- Beat-Menü ---------- */
function openBeatSheet() {
  const s = S.song;
  openSheet((root) => {
    sheetHeader(root, s.beat.name || "Beat", `${fmtTime(s.beat.duration)}${s.beat.trim ? ` · startet ab ${fmtTime(s.beat.trim)}` : ""}`);
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("scissors", "Beat trimmen", enterTrimMode, { note: s.beat.trim || s.beat.trimEnd ? "getrimmt" : "" }),
      sheetItem("flag", "Beat-Anfang hier setzen", setBeatStartHere, { note: fmtTime((s.beat.trim || 0) + getPos()) }),
      sheetItem("music", "Beat ersetzen", pickBeat),
    ].filter(Boolean)));
    root.appendChild(el("div", { class: "sheet-group" }, [sheetItem("trash", "Beat entfernen", removeBeat, { danger: true })]));
    root.appendChild(el("p", { class: "sheet-sub", style: { marginTop: "12px" }, text: "Beat-Anfang: Stille oder Intro am Anfang des Beats abschneiden. Das Metronom zählt ab dem neuen Anfang." }));
    sheetCancel(root);
  });
}

function setBeatStartHere() {
  applyTrimShift(getPos());
  S.pos = 0;
  renderSong();
  toast("Beat startet jetzt hier");
}
function resetBeatStart() {
  trimReset();
  S.pos = 0;
  renderSong();
}
async function removeBeat() {
  const ok = await sheetConfirm("Beat entfernen?", "Takes, Lyrics und Songteile bleiben erhalten.", "Entfernen");
  if (!ok) return;
  const s = S.song;
  if (S.playing) pause();
  await Store.deleteBlob(`beat:${s.id}`);
  s.beat = null;
  E.beatBuf = null; E.beatPeaks = null; E.beatProc = null;
  S.pos = 0;
  saveSong(); renderSong();
}

/* ---------- Take-Menü ---------- */
function openTakeSheet(id) {
  const s = S.song;
  const t = s.takes.find((x) => x.id === id);
  if (!t) return;
  S.selTakeId = id;
  renderTracks();
  openSheet((root) => {
    sheetHeader(root, t.name, `ab ${fmtTime(Math.max(0, t.offset))} · ${fmtTime(t.duration)} lang`);

    root.appendChild(el("p", { class: "sheet-sub", text: `Lautstärke: ${fmtFaderDb(dbLoad(t.gainDb))} dB – direkt am Regler in der Spur ändern.` }));

    // Sync-Korrektur
    const nudgeLbl = el("b", { text: "" });
    const updN = () => (nudgeLbl.textContent = `Start bei ${t.offset.toFixed(2).replace(".", ",")} s`);
    updN();
    const nb = (lbl, d) => {
      const b = el("button", { text: lbl });
      b.addEventListener("click", () => { t.offset = Math.round((t.offset + d) * 1000) / 1000; updN(); saveSong(); if (S.playing) play(getPos()); renderAll(); });
      return b;
    };
    root.appendChild(el("div", { class: "sheet-field" }, [
      el("div", { class: "sheet-field-label" }, [el("span", { text: "Timing verschieben (wenn Take zu spät/früh ist)" }), nudgeLbl]),
      el("div", { class: "nudge" }, [nb("–50 ms", -0.05), nb("–10 ms", -0.01), nb("+10 ms", 0.01), nb("+50 ms", 0.05)]),
    ]));

    root.appendChild(el("div", { class: "sheet-group", style: { marginTop: "16px" } }, [
      sheetItem("pencil", "Umbenennen", async () => {
        const v = await sheetPrompt("Take umbenennen", t.name, "Name");
        if (v && v.trim()) { t.name = v.trim(); saveSong(); renderTracks(); renderAll(); }
      }),
      sheetItem("jump", "Zum Anfang springen", () => seek(Math.max(0, t.offset))),
      t.clean === "done"
        ? sheetItem("sparkle", t.cleanOn ? "Original hören (mit Beat-Rest)" : "Clean hören (Beat entfernt)", () => toggleCleanTake(t), { note: t.cleanOn ? "Clean an" : "Original" })
        : sheetItem("sparkle", "Beat aus Vocal entfernen", () => removeBeatFromTake(t), { note: t.clean === "processing" ? "läuft …" : "" }),
      t.clean === "done" ? sheetItem("sparkle", "Beat nochmal entfernen (neu berechnen)", () => removeBeatFromTake(t)) : null,
      sheetItem("wave", "FX: EQ, Kompressor, Hall, Echo, Auto-Tune", () => openFxSheet(t.id), { note: t.fx && t.fx.on ? "an" : "aus" }),
      sheetItem("share", "Take teilen / sichern", () => shareTake(t)),
    ]));
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("trash", "Take löschen", () => deleteTake(t), { danger: true }),
    ]));
    sheetCancel(root);
  });
}
function fmtDb(v) { return v === 0 ? "0 dB" : `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`; }

async function deleteTake(t) {
  const ok = await sheetConfirm(`${t.name} löschen?`, "Die Aufnahme wird endgültig gelöscht.");
  if (!ok) return;
  const s = S.song;
  s.takes = s.takes.filter((x) => x.id !== t.id);
  const n = E.takes.get(t.id);
  try { n && n.gain && n.gain.disconnect(); } catch {}
  E.takes.delete(t.id);
  await Store.deleteBlob(`take:${t.id}`);
  await Store.deleteBlob(`take:${t.id}:clean`);
  if (S.playing) play(getPos());
  saveSong(); renderTracks(); renderAll();
  toast(`${t.name} gelöscht`);
}

/* ---------- Songteil-Menü ---------- */
function openSectionSheet(id) {
  const s = S.song;
  const sec = s.sections.find((x) => x.id === id);
  if (!sec) return;
  const r = sectionRange(sec);
  const isLoop = s.loopSectionId === id;
  openSheet((root) => {
    sheetHeader(root, sec.label, `${fmtTime(r.start)} – ${fmtTime(r.end)}`);
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("jump", "Hierhin springen", () => jumpToSection(id)),
      sheetItem("loop", isLoop ? "Wiederholen aus" : "Diesen Teil wiederholen", () => {
        s.loopSectionId = isLoop ? null : id;
        saveSong(); renderSections(); renderAll();
        if (!isLoop) { seek(sec.time); toast(`${sec.label} wird wiederholt`); }
      }),
      sheetItem("flag", "Auf aktuelle Position setzen", () => {
        sec.time = Math.round(snapToBar(getPos()) * 1000) / 1000;
        saveSong(); renderSections(); renderLyrics(); renderAll();
      }, { note: fmtTime(getPos()) }),
      sheetItem("pencil", "Umbenennen", async () => {
        const v = await sheetPrompt("Songteil umbenennen", sec.label, "Name");
        if (v && v.trim()) {
          // passenden Lyrics-Block mit umbenennen
          const blk = lyricsBlockForSection(sec);
          const shared = s.sections.filter((x) => x.label === sec.label).length > 1;
          if (blk && !shared) blk.label = v.trim();
          sec.label = v.trim();
          saveSong(); renderSections(); renderLyrics(); renderAll();
        }
      }),
    ]));
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("trash", "Songteil entfernen", () => {
        s.sections = s.sections.filter((x) => x.id !== id);
        if (s.loopSectionId === id) s.loopSectionId = null;
        saveSong(); renderSections(); renderLyrics(); renderAll();
      }, { danger: true }),
    ]));
    sheetCancel(root);
  });
}

function openTagMenu() {
  const s = S.song;
  openSheet((root) => {
    sheetHeader(root, "Songteile", "Tippe beim Abspielen auf Intro, Verse, Hook … – der Teil startet dort, wo der Playhead ist.");
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("undo", "Letzten Teil rückgängig", () => {
        const id = s._lastSectionId || (sortedSections().slice(-1)[0] || {}).id;
        if (!id) return;
        const sec = s.sections.find((x) => x.id === id);
        s.sections = s.sections.filter((x) => x.id !== id);
        if (s.loopSectionId === id) s.loopSectionId = null;
        s._lastSectionId = null;
        saveSong(); renderSections(); renderLyrics(); renderAll();
        if (sec) toast(`${sec.label} entfernt`);
      }, { disabled: !s.sections.length }),
      sheetItem("loop", "Wiederholen ausschalten", () => { s.loopSectionId = null; saveSong(); renderSections(); renderAll(); }, { disabled: !s.loopSectionId }),
    ]));
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("trash", "Alle Songteile löschen", async () => {
        const ok = await sheetConfirm("Alle Songteile löschen?", "Die Lyrics bleiben erhalten.");
        if (!ok) return;
        s.sections = []; s.loopSectionId = null;
        saveSong(); renderSections(); renderLyrics(); renderAll();
      }, { danger: true, disabled: !s.sections.length }),
    ]));
    sheetCancel(root);
  });
}

function toggleLoopQuick() {
  const s = S.song;
  if (s.loopSectionId) { s.loopSectionId = null; toast("Wiederholen aus"); }
  else {
    const sec = sectionAt(getPos());
    if (!sec) { toast("Setze zuerst Songteile – dann kannst du einen Teil wiederholen."); return; }
    s.loopSectionId = sec.id;
    toast(`${sec.label} wird wiederholt`);
  }
  haptic();
  saveSong(); renderSections(); renderAll();
}

/* ---------- Lyrics-Block-Menü ---------- */
function openLyricsBlockSheet(block) {
  const s = S.song;
  const i = s.lyrics.indexOf(block);
  openSheet((root) => {
    sheetHeader(root, block.label);
    const typeRow = el("div", { class: "sheet-chips" });
    for (const [type, def] of Object.entries(SECTION_TYPES)) {
      if (type === "custom") continue;
      const b = el("button", { class: block.type === type ? "sel" : "", text: def.label });
      b.addEventListener("click", () => {
        block.type = type;
        if (!/\d$/.test(block.label) || !SECTION_TYPES[type].numbered) block.label = def.label;
        closeSheet(); saveSong(); renderLyrics(); requestAnimationFrame(autosizeAll);
      });
      typeRow.appendChild(b);
    }
    root.appendChild(el("div", { class: "sheet-field" }, [el("div", { class: "sheet-field-label" }, [el("span", { text: "Art" })]), typeRow]));
    root.appendChild(el("div", { class: "sheet-group", style: { marginTop: "16px" } }, [
      sheetItem("pencil", "Umbenennen", async () => {
        const v = await sheetPrompt("Teil umbenennen", block.label, "z. B. Verse 2");
        if (v && v.trim()) { block.label = v.trim(); saveSong(); renderLyrics(); requestAnimationFrame(autosizeAll); }
      }),
      sheetItem("up", "Nach oben", () => { if (i > 0) { s.lyrics.splice(i, 1); s.lyrics.splice(i - 1, 0, block); saveSong(); renderLyrics(); requestAnimationFrame(autosizeAll); } }, { disabled: i === 0 }),
      sheetItem("down", "Nach unten", () => { if (i < s.lyrics.length - 1) { s.lyrics.splice(i, 1); s.lyrics.splice(i + 1, 0, block); saveSong(); renderLyrics(); requestAnimationFrame(autosizeAll); } }, { disabled: i === s.lyrics.length - 1 }),
      sheetItem("copy", "Duplizieren", () => {
        const copy = { ...block, id: uid(), label: block.label + " (Kopie)" };
        s.lyrics.splice(i + 1, 0, copy); saveSong(); renderLyrics(); requestAnimationFrame(autosizeAll);
      }),
    ]));
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("trash", "Teil löschen", async () => {
        if (block.text.trim()) {
          const ok = await sheetConfirm(`${block.label} löschen?`, "Der Text in diesem Teil wird gelöscht.");
          if (!ok) return;
        }
        s.lyrics = s.lyrics.filter((b) => b !== block); saveSong(); renderLyrics(); requestAnimationFrame(autosizeAll);
      }, { danger: true }),
    ]));
    sheetCancel(root);
  });
}

function openLyricsMore() {
  openSheet((root) => {
    sheetHeader(root, "Lyrics");
    root.appendChild(el("div", { class: "sheet-group" }, [
      sheetItem("copy", "Alle Lyrics kopieren", copyLyrics),
      sheetItem("share", "Als Text teilen", shareLyrics),
    ]));
    root.appendChild(el("div", { class: "sheet-group" }, [
      toggleRow("Beim Abspielen mitscrollen", "Springt zum Teil, der gerade läuft", Settings.follow, (v) => { Settings.follow = v; saveSettings(); $("#lyr-follow").classList.toggle("on", v); }),
    ]));
    sheetCancel(root);
  });
}

function lyricsAsText() {
  const s = S.song;
  const parts = s.lyrics.filter((b) => b.text.trim()).map((b) => `[${b.label}]\n${b.text.trim()}`);
  return `${s.name}${s.bpm ? ` · ${s.bpm} BPM` : ""}${s.key ? ` · ${s.key}` : ""}\n\n${parts.join("\n\n")}`;
}
async function copyLyrics() {
  try { await navigator.clipboard.writeText(lyricsAsText()); toast("Lyrics kopiert"); }
  catch { sheetAlert("Kopieren nicht möglich", "Markiere den Text manuell im Lyrics-Tab."); }
}
async function shareLyrics() {
  const text = lyricsAsText();
  if (navigator.share) { try { await navigator.share({ title: S.song.name, text }); return; } catch (e) { if (e && e.name === "AbortError") return; } }
  copyLyrics();
}

/* ---------- Einstellungen ---------- */
function openSettingsSheet() {
  openSheet((root) => {
    sheetHeader(root, "Einstellungen");
    root.appendChild(el("div", { class: "sheet-group" }, [
      toggleRow("Einzählen", "1 Takt Metronom vor der Aufnahme (braucht BPM)", Settings.countIn, (v) => { Settings.countIn = v; saveSettings(); }),
      toggleRow("Beat leiser bei Aufnahme", "Hilft, wenn du ohne Kopfhörer aufnimmst", Settings.duckOnRec, (v) => { Settings.duckOnRec = v; saveSettings(); }),
    ]));
    // Latenz
    const lbl = el("b", { text: `${Settings.latencyMs} ms` });
    const sl = el("input", { type: "range", min: -200, max: 300, step: 5, value: Settings.latencyMs });
    const setP = () => sl.style.setProperty("--p", `${((sl.value - -200) / 500) * 100}%`);
    setP();
    sl.addEventListener("input", () => { Settings.latencyMs = +sl.value; lbl.textContent = `${sl.value} ms`; setP(); saveSettings(); });
    root.appendChild(el("div", { class: "sheet-field" }, [
      el("div", { class: "sheet-field-label" }, [el("span", { text: "Aufnahme-Sync (wenn neue Takes zu spät sind: erhöhen)" }), lbl]),
      sl,
    ]));
    const ml = el("b", { text: `${Math.round(Settings.metroVolume * 100)} %` });
    const ms = el("input", { type: "range", min: 0, max: 100, value: Math.round(Settings.metroVolume * 100) });
    ms.style.setProperty("--p", ms.value + "%");
    ms.addEventListener("input", () => {
      Settings.metroVolume = ms.value / 100; ml.textContent = ms.value + " %"; ms.style.setProperty("--p", ms.value + "%");
      if (E.metroGain) E.metroGain.gain.value = Settings.metroVolume; saveSettings();
    });
    root.appendChild(el("div", { class: "sheet-field" }, [el("div", { class: "sheet-field-label" }, [el("span", { text: "Metronom-Lautstärke" }), ml]), ms]));
    root.appendChild(el("p", { class: "sheet-sub", style: { marginTop: "16px" }, text: Store.ok ? "Songs werden auf diesem Gerät gespeichert. Tipp: Flowcess zum Home-Bildschirm hinzufügen, damit Safari nichts löscht." : "Achtung: Speichern ist in diesem Browser nicht möglich (privater Modus?). Songs gehen beim Schliessen verloren." }));
    sheetCancel(root);
  });
}

/* ===================== 10. EXPORT ===================== */
async function shareFile(blob, filename) {
  // 1) Xcode-App: an Swift übergeben (Teilen-Dialog)
  const wk = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.flowcessShare;
  if (wk) {
    const b64 = await new Promise((res) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1]);
      r.readAsDataURL(blob);
    });
    wk.postMessage({ name: filename, mime: blob.type, base64: b64 });
    return;
  }
  // 2) iPhone/Safari: Teilen-Dialog
  try {
    const file = new File([blob], filename, { type: blob.type });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: filename });
      return;
    }
  } catch (e) { if (e && e.name === "AbortError") return; }
  // 3) Download
  const url = URL.createObjectURL(blob);
  const a = el("a", { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 4000);
}

function extForMime(m) {
  if (!m) return "m4a";
  if (m.includes("mp4") || m.includes("aac")) return "m4a";
  if (m.includes("webm")) return "webm";
  if (m.includes("ogg")) return "ogg";
  if (m.includes("wav")) return "wav";
  return "audio";
}

async function shareTake(t) {
  const blob = await Store.getBlob(`take:${t.id}`);
  if (!blob) { toast("Take-Datei nicht gefunden."); return; }
  await shareFile(blob, `${S.song.name} - ${t.name}.${extForMime(blob.type)}`);
}

async function exportMix() {
  const s = S.song;
  const d = songDuration();
  if (d <= 0) return;
  toast("Mix wird erstellt …", 8000);
  try {
    const sr = 44100;
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new OAC(2, Math.ceil(d * sr), sr);
    const outLim = makeLimiter(off);
    outLim.connect(off.destination);
    const solo = anySolo();
    if (E.beatBuf && s.beat && !beatSilent(s)) {
      const src = off.createBufferSource();
      const g = off.createGain();
      g.gain.value = beatGainValue(s);
      const R = beatRate(s), trim = s.beat.trim || 0;
      const baked = E.beatProc && E.beatProc.key === procKey(s) ? E.beatProc.buf : null;
      src.connect(g); g.connect(outLim);
      if (baked) { src.buffer = baked; src.start(0, trim / R); }
      else { src.buffer = E.beatBuf; src.playbackRate.value = R; src.start(0, trim); }
      src.stop((beatEnd(s) - trim) / R);
    }
    // Hall/Echo-Busse im Export
    let oRev = null, oDly = null;
    if (s.takes.some((t) => t.fx && t.fx.on)) {
      oRev = off.createGain();
      const pre = off.createDelay(1), conv = off.createConvolver();
      conv.buffer = E.revConv ? E.revConv.buffer : makeReverbIR(off);
      const tt0 = fxTempoTimes((s.takes.find((x) => x.fx && x.fx.on && x.fx.delay > 0) || {}).fx);
      pre.delayTime.value = tt0.pre;
      oRev.connect(pre); pre.connect(conv); conv.connect(outLim);
      oDly = off.createGain();
      const dl = off.createDelay(4), fb = off.createGain(), fl = off.createBiquadFilter();
      dl.delayTime.value = tt0.delay; fb.gain.value = 0.32; fl.type = "bandpass"; fl.frequency.value = 1800; fl.Q.value = 0.5;
      oDly.connect(dl); dl.connect(fl); fl.connect(fb); fb.connect(dl); fl.connect(outLim);
    }
    for (const t of s.takes) {
      const n = E.takes.get(t.id);
      if (!n || !n.buf || t.muted || (solo && !t.solo)) continue;
      const src = off.createBufferSource();
      const g = off.createGain();
      g.gain.value = takeGainValue(t);
      src.buffer = takePlayBuffer(t, n);
      g.connect(outLim);
      if (t.fx && t.fx.on) {
        const ch = buildFxNodes(off, g);
        const fx = t.fx, c = clamp(fx.comp || 0, 0, 1), eqOn = fx.eq !== false;
        ch.hp.frequency.value = eqOn ? 90 : 10; ch.mud.gain.value = eqOn ? -3 : 0; ch.pres.gain.value = eqOn ? 3 : 0; ch.air.gain.value = eqOn ? 3 : 0;
        ch.comp.threshold.value = -6 - 26 * c; ch.comp.ratio.value = 1 + 7 * c; ch.makeup.gain.value = dbToGain(1 + 5 * c * c);
        src.connect(ch.first);
        const rs = off.createGain(); rs.gain.value = clamp(fx.reverb || 0, 0, 1) * 0.9; g.connect(rs); rs.connect(oRev);
        const ds = off.createGain(); ds.gain.value = clamp(fx.delay || 0, 0, 1) * 0.8; g.connect(ds); ds.connect(oDly);
      } else {
        src.connect(g);
      }
      if (t.offset >= 0) src.start(t.offset);
      else src.start(0, -t.offset);
    }
    const rendered = await new Promise((resolve, reject) => {
      off.oncomplete = (e) => resolve(e.renderedBuffer);
      const p = off.startRendering();
      if (p && p.then) p.then(resolve, reject);
    });
    const wav = encodeWav(rendered);
    toast("Mix fertig");
    await shareFile(wav, `${s.name} - Mix.wav`);
  } catch (err) {
    console.warn(err);
    sheetAlert("Export fehlgeschlagen", "Der Mix konnte nicht erstellt werden. Versuch es nochmal oder exportiere einzelne Takes.");
  }
}

function encodeWav(buf) {
  const ch = buf.numberOfChannels, sr = buf.sampleRate, len = buf.length;
  const bytes = 44 + len * ch * 2;
  const ab = new ArrayBuffer(bytes);
  const v = new DataView(ab);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, "RIFF"); v.setUint32(4, bytes - 8, true); w(8, "WAVE");
  w(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
  w(36, "data"); v.setUint32(40, len * ch * 2, true);
  const data = [];
  for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const x = clamp(data[c][i], -1, 1);
      v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
      o += 2;
    }
  }
  return new Blob([ab], { type: "audio/wav" });
}

/* ===================== 11. CLEAN VOCAL (Server vorbereitet) ===================== */
function getCleanVocalApiUrl() {
  // Später hier deinen Server eintragen, z. B.:
  // return "https://dein-server.com/process-vocal";
  return "";
}

async function cleanVocal(t) {
  const apiUrl = getCleanVocalApiUrl();
  if (!apiUrl) {
    t.clean = "ready";
    saveSong(); renderTracks();
    sheetAlert("Clean Vocal ist vorbereitet", "Stimme vom Beat trennen braucht einen Server (KI). Sobald ein Server eingetragen ist (getCleanVocalApiUrl in script.js), funktioniert dieser Knopf.");
    return;
  }
  try {
    t.clean = "processing"; renderTracks();
    toast("Clean Vocal läuft …", 10000);
    const blob = await Store.getBlob(`take:${t.id}`);
    const fd = new FormData();
    fd.append("audio", blob, `${t.name}.${extForMime(blob.type)}`);
    fd.append("key", S.song.key || "Auto");
    fd.append("bpm", String(S.song.bpm || ""));
    fd.append("takeName", t.name);
    const res = await fetch(apiUrl, { method: "POST", body: fd });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const out = await res.blob();
    const buf = await decodeBlob(out);
    await Store.putBlob(`take:${t.id}`, out);
    const n = ensureTakeNodes(t.id);
    n.buf = buf; n.peaks = computePeaks(buf);
    t.duration = buf.duration;
    t.clean = "done";
    saveSong(); renderTracks(); renderAll();
    toast("Clean Vocal fertig");
  } catch (err) {
    console.warn(err);
    t.clean = null; renderTracks();
    sheetAlert("Clean Vocal fehlgeschlagen", "Der Server hat nicht geantwortet. Prüfe die Adresse und die Internetverbindung.");
  }
}

/* ===================== DEMO-SONG ===================== */
function synthDemoBeat(sr = 44100) {
  const bpm = 92, spb = 60 / bpm, bars = 12, dur = bars * 4 * spb;
  const n = Math.floor(dur * sr);
  const L = new Float32Array(n), R = new Float32Array(n);
  const chords = [[220, 261.63, 329.63], [174.61, 220, 261.63], [196, 246.94, 293.66], [164.81, 207.65, 246.94]];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
  for (let bar = 0; bar < bars; bar++) {
    const ch = chords[bar % 4];
    const a = Math.floor(bar * 4 * spb * sr), b = Math.min(n, Math.floor((bar + 1) * 4 * spb * sr));
    for (let i = a; i < b; i++) {
      const t = i / sr, lt = (i - a) / sr;
      const env = Math.min(1, lt * 4) * 0.9;
      let v = 0;
      for (const f of ch) v += Math.sin(2 * Math.PI * f * t) + 0.3 * Math.sin(4 * Math.PI * f * t);
      v *= 0.035 * env;
      L[i] += v; R[i] += v;
    }
    // Bass
    const root = ch[0] / 2;
    for (let i = a; i < b; i++) {
      const lt = ((i - a) / sr) % (2 * spb);
      const v = 0.18 * Math.sin(2 * Math.PI * root * (i / sr)) * Math.exp(-lt * 1.6);
      L[i] += v; R[i] += v;
    }
  }
  const beats = Math.floor(dur / spb);
  for (let k = 0; k < beats; k++) {
    const st = Math.floor(k * spb * sr);
    const intro = k < 8;
    if (!intro && (k % 4 === 0 || k % 4 === 2 || (k % 8 === 7))) { // Kick
      for (let j = 0; j < sr * 0.22 && st + j < n; j++) {
        const t = j / sr, v = 0.85 * Math.sin(2 * Math.PI * (48 + 90 * Math.exp(-t * 35)) * t) * Math.exp(-t * 14);
        L[st + j] += v; R[st + j] += v;
      }
    }
    if (!intro && k % 2 === 1) { // Snare
      for (let j = 0; j < sr * 0.18 && st + j < n; j++) {
        const t = j / sr, v = (0.4 * rnd() + 0.25 * Math.sin(2 * Math.PI * 190 * t)) * Math.exp(-t * 22);
        L[st + j] += v; R[st + j] += v * 0.9;
      }
    }
    for (const off of [0, 0.5]) { // Hi-Hats
      const hs = Math.floor((k + off) * spb * sr);
      for (let j = 0; j < sr * 0.04 && hs + j < n; j++) {
        const v = 0.12 * rnd() * Math.exp(-(j / sr) * 110);
        L[hs + j] += v * 0.8; R[hs + j] += v;
      }
    }
  }
  let m = 0;
  for (let i = 0; i < n; i++) m = Math.max(m, Math.abs(L[i]), Math.abs(R[i]));
  const g = 0.9 / (m || 1);
  for (let i = 0; i < n; i++) { L[i] *= g; R[i] *= g; }
  return { L, R, sr, bpm, spb };
}

async function createDemoSong() {
  ensureCtx();
  const d = synthDemoBeat(E.ctx.sampleRate || 44100);
  const buf = E.ctx.createBuffer(2, d.L.length, d.sr);
  buf.getChannelData(0).set(d.L);
  buf.getChannelData(1).set(d.R);
  const s = newSong("Demo · Nachtfahrt");
  const bar = d.spb * 4;
  s.bpm = 92; s.bpmExact = 92; s.gridOffset = 0; s.snap = true; s.key = "Am"; s.transpose = 0;
  s.beat = { name: "Demo-Beat (92 BPM)", duration: buf.duration, trim: 0, type: "audio/wav", origBpm: 92, origKey: "Am" };
  const secs = [["intro", "Intro", 0], ["verse", "Verse 1", 2], ["hook", "Hook", 6], ["verse", "Verse 2", 8]];
  s.sections = secs.map(([type, label, b]) => ({ id: uid(), type, label, time: Math.round(b * bar * 1000) / 1000 }));
  s.lyrics = [
    { id: uid(), type: "intro", label: "Intro", text: "Yeah\nFlowcess, lass laufen" },
    { id: uid(), type: "verse", label: "Verse 1", text: "Stadt schläft, doch ich bin wach um drei\nJede Ampel grün, als wär die Strasse frei\nKopf voll mit Zeilen, der Beat im Ohr\nIch schreib das hier für mich, nicht für den Chor\nNotizen im Handy, die Hälfte verloren\nDoch die guten Ideen werden nachts geboren\nLeise im Zimmer, laut in mir drin\nJede Silbe ein Schritt, ich weiss, wo ich hin will" },
    { id: uid(), type: "hook", label: "Hook", text: "Nachtfahrt, alles in Bewegung\nNachtfahrt, keine Überlegung\nFenster runter, Stimme laut\nDas ist der Sound, auf den ich bau" },
    { id: uid(), type: "verse", label: "Verse 2", text: "Zweiter Anlauf, gleiche Energie\nWas ich heute schreib, das vergess ich nie" },
  ];
  s.notes = "Reime auf \"Nacht\": gemacht, bewacht, entfacht, Pracht\nFlow-Idee: Hook doppeln, zweite Hälfte flüstern";
  S.songs.unshift(s);
  try { await Store.putBlob(`beat:${s.id}`, encodeWav(buf)); } catch (e) { console.warn(e); }
  s.duration = buf.duration;
  await Store.putSong(s);
  await openSong(s);
  toast("Demo-Song geladen");
}

/* ===================== 12. START ===================== */
async function importLegacy() {
  // Alte Flowcess-Version (CodePen) hat Lyrics im localStorage gespeichert
  try {
    if (localStorage.getItem("fc2_imported")) return;
    localStorage.setItem("fc2_imported", "1");
    const lyr = JSON.parse(localStorage.getItem("fc_lyrics") || "{}") || {};
    const mind = localStorage.getItem("fc_mind") || "";
    const secs = JSON.parse(localStorage.getItem("fc_arrangement_sections") || "[]") || [];
    const hasLyrics = Object.values(lyr).some((v) => String(v || "").trim());
    if (!hasLyrics && !mind.trim()) return;
    const s = newSong("Importiert aus alter Version");
    for (const [name, text] of Object.entries(lyr)) {
      if (!String(text || "").trim()) continue;
      const low = name.toLowerCase();
      const type = Object.keys(SECTION_TYPES).find((k) => low.startsWith(k)) || (low.startsWith("pre") ? "pre" : "custom");
      s.lyrics.push({ id: uid(), type, label: name, text: String(text) });
    }
    s.notes = mind;
    for (const sec of secs) {
      const name = sec.name || sec.label || "";
      const low = name.toLowerCase();
      const type = Object.keys(SECTION_TYPES).find((k) => low.startsWith(k)) || "custom";
      if (typeof sec.start === "number") s.sections.push({ id: uid(), type, label: name, time: sec.start });
    }
    await Store.putSong(s);
  } catch (err) { console.warn("Import alte Version", err); }
}

function bindUI() {
  // Ton beim allerersten Tipp irgendwo freischalten
  const firstTouch = () => {
    unlockAudio();
    document.removeEventListener("touchend", firstTouch, true);
    document.removeEventListener("click", firstTouch, true);
  };
  document.addEventListener("touchend", firstTouch, true);
  document.addEventListener("click", firstTouch, true);

  // Bibliothek
  $("#lib-search").addEventListener("input", renderLibrary);
  $("#lib-new-btn").addEventListener("click", () => {
    openSheet((root) => {
      sheetHeader(root, "Neuer Song");
      root.appendChild(el("div", { class: "sheet-group" }, [
        sheetItem("music", "Mit Beat starten", () => pickBeat(true)),
        sheetItem("mic", "Ohne Beat (nur Aufnahme)", async () => { await openSong(await createSong()); }),
        sheetItem("pencil", "Nur Lyrics schreiben", async () => {
          const s = await createSong();
          s.lyrics.push(newLyricsBlockFor(s, "verse"), newLyricsBlockFor(s, "hook"));
          S.tab = "lyrics";
          await openSong(s);
        }),
      ]));
      sheetCancel(root, "Abbrechen");
    });
  });
  $("#lib-empty-beat").addEventListener("click", () => pickBeat(true));
  $("#lib-rec-btn").addEventListener("click", async () => {
    // Schnell-Aufnahme wie Sprachmemos
    await unlockAudio();
    const n = S.songs.filter((s) => /^Neue Aufnahme/.test(s.name)).length + 1;
    const s = await createSong(`Neue Aufnahme ${n}`);
    S.tab = "studio";
    await openSong(s);
    startRecording();
  });

  // Song
  $("#song-back").addEventListener("click", closeSong);
  $("#song-title").addEventListener("click", renameSong);
  $("#song-menu-btn").addEventListener("click", openSongMenu);
  $$("#song-tabs button").forEach((b) => b.addEventListener("click", () => { haptic(4); setTab(b.dataset.tab); }));
  $("#chip-bpm").addEventListener("click", openBpmSheet);
  $("#chip-key").addEventListener("click", openKeySheet);
  $("#chip-loop").addEventListener("click", toggleLoopQuick);
  $("#wave-empty-beat").addEventListener("click", pickBeat);
  $("#btn-play").addEventListener("click", togglePlay);
  $("#dock-play").addEventListener("click", togglePlay);
  $("#btn-back15").addEventListener("click", () => { if (!S.recording) seek(getPos() - 15); });
  $("#btn-fwd15").addEventListener("click", () => { if (!S.recording) seek(getPos() + 15); });
  $("#rec-btn").addEventListener("click", toggleRecord);
  $("#dock-metro").addEventListener("click", toggleMetronome);
  $("#tag-menu-btn").addEventListener("click", openTagMenu);
  $("#sec-edit-done").addEventListener("click", exitSectionEdit);
  $("#sec-edit-snap").addEventListener("click", () => {
    const s = S.song;
    if (!beatLen()) { toast("Kein Tempo – Raster geht erst mit BPM"); return; }
    s.snap = s.snap === false;
    haptic();
    saveSong(); updateSnapUI();
    toast(s.snap ? "Einrasten am Takt" : "Frei bewegen", 1200);
  });
  $("#trim-done").addEventListener("click", exitTrimMode);
  $("#trim-auto").addEventListener("click", trimAutoSilence);
  $("#trim-one").addEventListener("click", trimToDownbeat);
  $("#trim-reset").addEventListener("click", trimReset);
  $("#trim-snap").addEventListener("click", () => {
    const s = S.song;
    if (!beatLen()) { toast("Kein Tempo – Einrasten geht erst mit BPM"); return; }
    s.trimSnap = !s.trimSnap;
    haptic(); saveSong(); updateTrimSnapUI();
    toast(s.trimSnap ? "Griffe rasten auf Schläge ein" : "Griffe frei bewegen", 1300);
  });
  $("#sec-edit-prev").addEventListener("click", () => nudgeSection(-1));
  $("#sec-edit-next").addEventListener("click", () => nudgeSection(1));
  $("#sec-edit-more").addEventListener("click", () => S.editSecId && openSectionSheet(S.editSecId));
  $("#sec-edit-name").addEventListener("click", async () => {
    const sec = S.song.sections.find((x) => x.id === S.editSecId);
    if (!sec) return;
    const v = await sheetPrompt("Songteil umbenennen", sec.label, "Name");
    if (v && v.trim()) {
      const blk = lyricsBlockForSection(sec);
      const shared = S.song.sections.filter((x) => x.label === sec.label).length > 1;
      if (blk && !shared) blk.label = v.trim();
      sec.label = v.trim();
      saveSong(); renderSections(); renderLyrics(); updateSecEditBar(); renderAll();
    }
  });
  $("#sec-edit-loop").addEventListener("click", () => {
    const s = S.song;
    const sec = s.sections.find((x) => x.id === S.editSecId);
    if (!sec) return;
    s.loopSectionId = s.loopSectionId === sec.id ? null : sec.id;
    haptic();
    saveSong(); renderSections(); updateSecEditBar(); renderAll();
    toast(s.loopSectionId ? `${sec.label} wird wiederholt` : "Wiederholen aus", 1300);
  });
  $("#sec-edit-del").addEventListener("click", () => {
    const s = S.song;
    const sec = s.sections.find((x) => x.id === S.editSecId);
    if (!sec) return;
    s.sections = s.sections.filter((x) => x.id !== sec.id);
    if (s.loopSectionId === sec.id) s.loopSectionId = null;
    s._undoSection = sec;
    exitSectionEdit();
    saveSong(); renderSections(); renderLyrics(); renderAll();
    toast(`${sec.label} entfernt`);
  });
  $("#beat-input").addEventListener("change", (e) => onBeatFile(e.target.files && e.target.files[0]));
  $("#take-input").addEventListener("change", (e) => onTakeFile(e.target.files && e.target.files[0]));
  $("#lib-empty-demo").addEventListener("click", createDemoSong);

  // Lyrics
  $$("#lyr-seg button").forEach((b) => b.addEventListener("click", () => {
    S.lyrSub = b.dataset.sub;
    $$("#lyr-seg button").forEach((x) => x.classList.toggle("active", x === b));
    $("#lyr-pane-lyrics").classList.toggle("hidden", S.lyrSub !== "lyrics");
    $("#lyr-pane-ideas").classList.toggle("hidden", S.lyrSub !== "ideas");
    if (S.lyrSub === "lyrics") requestAnimationFrame(autosizeAll);
  }));
  $("#ideas-text").addEventListener("input", (e) => { if (S.song) { S.song.notes = e.target.value; saveSong(); } });
  $("#lyr-follow").addEventListener("click", () => {
    Settings.follow = !Settings.follow; saveSettings();
    $("#lyr-follow").classList.toggle("on", Settings.follow);
    toast(Settings.follow ? "Mitscrollen an" : "Mitscrollen aus", 1200);
  });
  $("#lyr-more").addEventListener("click", openLyricsMore);
  $("#lyr-live-btn").addEventListener("click", openLive);

  // Live
  $("#live-close").addEventListener("click", closeLive);
  $("#live-play").addEventListener("click", togglePlay);
  $("#live-rec").addEventListener("click", toggleRecord);
  $("#live-prev").addEventListener("click", () => liveJump(-1));
  $("#live-next-btn").addEventListener("click", () => liveJump(1));
  $("#live-size").addEventListener("click", () => {
    const sizes = [26, 34, 44, 56];
    Settings.liveSize = sizes[(sizes.indexOf(Settings.liveSize) + 1) % sizes.length] || 34;
    $("#live").style.setProperty("--live-size", Settings.liveSize + "px");
    saveSettings();
    renderLive(getPos(), true);
  });
  const lb = $("#live-body");
  const manual = () => (liveState.manualScrollUntil = performance.now() + 2500);
  lb.addEventListener("touchmove", manual, { passive: true });
  lb.addEventListener("wheel", manual, { passive: true });

  // Sheets
  $("#sheet-backdrop").addEventListener("click", () => closeSheet(null));

  // Tastatur (Mac/PC): Leertaste = Play, R = Aufnahme
  document.addEventListener("keydown", (e) => {
    if (!S.song || !$("#screen-song").classList.contains("active")) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.code === "Space") { e.preventDefault(); togglePlay(); }
    else if (e.key === "r" || e.key === "R") toggleRecord();
    else if (e.key === "ArrowLeft") seek(getPos() - 5);
    else if (e.key === "ArrowRight") seek(getPos() + 5);
  });

  window.addEventListener("resize", debounce(() => { if (S.song) { resizeWave(); renderAll(); } }, 120));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) { saveSongNow(); }
    else if (E.ctx && E.ctx.state !== "running" && S.playing) E.ctx.resume().catch(() => {});
  });
  window.addEventListener("pagehide", () => saveSongNow());
}

function newLyricsBlockFor(song, type) {
  const prev = S.song;
  S.song = song;
  const b = newLyricsBlock(type);
  S.song = prev;
  return b;
}

async function boot() {
  W.canvas = $("#wave-canvas");
  W.ctx = W.canvas.getContext("2d");
  W.ov = $("#overview-canvas");
  W.ovCtx = W.ov.getContext("2d");
  bindUI();
  setupWaveGestures();
  await Store.open();
  await importLegacy();
  await loadSongs();
  renderLibrary();
  if (!Store.ok) toast("Speichern nicht möglich – privater Modus?", 3500);
  // In der Claude-Vorschau: gleich mit einem Demo-Song starten
  if (window.FLOWCESS_DEMO && !S.songs.length) {
    try { await createDemoSong(); } catch (e) { console.warn(e); }
  }
}

boot();
