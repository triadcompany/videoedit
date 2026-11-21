import express from "express";
import multer from "multer";
import ffmpegPath from "ffmpeg-static";
import ffprobe from "ffprobe-static";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { buildAss, FONTS_DIR, FONTS } from "./edit.js";
import { setupAuth } from "./auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const DIRS = {
  raw: path.join(DATA, "raw"),
  clips: path.join(DATA, "clips"), // normalizados
  out: path.join(DATA, "output"),
  tmp: path.join(DATA, "tmp"),
  refs: path.join(DATA, "refs"),
};
Object.values(DIRS).forEach((d) => fs.mkdirSync(d, { recursive: true }));
const DB = path.join(DATA, "db.json");

const TYPES = ["hook", "body", "cta"];
const VIBE = "/Applications/vibe.app/Contents/MacOS/vibe-server";
// Transcrição: whisper.cpp (servidor/Docker: WHISPER_BIN + modelo) ou, no Mac, o Whisper do Vibe
const WHISPER_BIN = process.env.WHISPER_BIN || "";
const WHISPER_MODEL_PATH = process.env.WHISPER_MODEL_PATH || path.join(DATA, "models", `ggml-${process.env.WHISPER_MODEL || "small"}.bin`);
const VIBE_CONFIG = path.join(process.env.HOME, "Library/Application Support/github.com.thewh1teagle.vibe/app_config.json");
const W = 1080, H = 1920, FPS = 30;

// ---------- persistência simples ----------
const load = () =>
  fs.existsSync(DB)
    ? JSON.parse(fs.readFileSync(DB, "utf8"))
    : { clips: [], variations: [] };
const save = (db) => fs.writeFileSync(DB, JSON.stringify(db, null, 2));
let db = load();
db.refs ||= [];
// estilo padrão das legendas (editável no painel e salvo junto com os dados)
const CAPTION_DEFAULTS = { preset: "classica", font: "Poppins Medium", size: 68, yPct: 64, color: "#FFE600", wordsPerLine: 3, upper: false };
db.defaults ||= { captions: { ...CAPTION_DEFAULTS } };
// Projetos: cada um guarda seus clipes e variações (referências e estilo padrão são compartilhados).
// Dados de antes dos projetos existirem entram num primeiro projeto.
db.projects ||= [];
{
  const orphans = [...db.clips, ...db.variations].filter((x) => !x.project || !db.projects.some((p) => p.id === x.project));
  if (orphans.length) {
    let first = db.projects[0];
    if (!first) {
      first = { id: crypto.randomUUID(), name: "Meu primeiro projeto", createdAt: Date.now(), updatedAt: Date.now() };
      db.projects.push(first);
    }
    orphans.forEach((x) => { x.project = first.id; });
  }
  db.projects.forEach((p) => { p.owner ||= "admin"; });
}
// jobs que ficaram "processing" de uma execução anterior viram erro
db.clips.forEach((c) => c.status === "processing" && (c.status = "error", c.error = "interrompido"));
db.refs.forEach((r) => r.status === "processing" && (r.status = "error", r.error = "interrompido"));
db.variations.forEach((v) => delete v.prog);
db.clips.forEach((c) => delete c.prog);
// clipes de antes do tratamento existir: contam como já tratados (sem corte nem ganho)
db.clips.forEach((c) => {
  if (c.status === "ready" && c.reviewed === undefined) { c.reviewed = true; c.trim = { start: 0, end: 0 }; c.gainDb = 0; c.rendered = { start: 0, end: 0, gainDb: 0 }; }
});
db.variations.forEach((v) => v.cap === "processing" && (v.cap = "error", v.capError = "interrompido"));
db.variations.forEach((v) => (v.status === "processing" || v.status === "queued") && (v.status = "error", v.error = "interrompido"));
save(db);

// ---------- ffmpeg ----------
// ---------- trabalhos de edição canceláveis ----------
// A fila roda um trabalho por vez, então "currentJob" é o único trabalho de variação em execução.
// Todo processo (ffmpeg/whisper) iniciado durante ele é registrado para poder ser encerrado ao cancelar.
const jobs = new Map();   // id da variação -> trabalho (na fila ou rodando)
let currentJob = null;
function track(p) {
  const job = currentJob;
  if (!job) return p;
  job.procs.add(p);
  p.on("close", () => job.procs.delete(p));
  if (job.cancelled) { try { p.kill("SIGKILL"); } catch {} }
  return p;
}
const checkCancel = () => { if (currentJob?.cancelled) throw new Error("cancelado"); };
// apaga um arquivo antigo só quando o trabalho termina bem (se cancelar/falhar, ele ainda é necessário)
function trashFile(f) {
  if (currentJob) currentJob.trash.push(f);
  else fs.rmSync(path.join(DIRS.out, f), { force: true });
}
function queueVariationJob(v, fn) {
  const job = { id: v.id, cancelled: false, started: false, procs: new Set(), files: [], trash: [] };
  jobs.set(v.id, job);
  v.cap = "processing";
  v.prog = { pct: 0, stage: "Na fila" };
  delete v.capError;
  enqueue(async () => {
    if (job.cancelled) { if (jobs.get(v.id) === job) jobs.delete(v.id); return; }
    job.started = true;
    currentJob = job;
    const snap = { file: v.file, parts: v.parts ? structuredClone(v.parts) : undefined, baseFile: v.baseFile ?? null, capFile: v.capFile ?? null, cutInfo: v.cutInfo, edit: v.edit ? structuredClone(v.edit) : v.edit };
    try {
      await fn();
    } catch (e) {
      if (!job.cancelled) { v.cap = "error"; v.capError = e.message; }
    } finally {
      currentJob = null;
      if (job.cancelled || v.cap === "error") {
        // volta ao estado de antes e apaga o que este trabalho criou pela metade
        for (const f of job.files) fs.rmSync(path.join(DIRS.out, f), { force: true });
        v.file = snap.file;
        if (snap.parts === undefined) delete v.parts; else v.parts = snap.parts;
        v.baseFile = snap.baseFile;
        v.capFile = snap.capFile;
        v.edit = snap.edit;
        if (snap.cutInfo === undefined) delete v.cutInfo; else v.cutInfo = snap.cutInfo;
        if (job.cancelled) { v.cap = "idle"; delete v.capError; }
      } else {
        for (const f of job.trash) fs.rmSync(path.join(DIRS.out, f), { force: true });
      }
      delete v.prog;
      if (jobs.get(v.id) === job) jobs.delete(v.id);
      save(db);
    }
  });
}

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = track(spawn(bin, args));
    let err = "", out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.split("\n").slice(-6).join("\n")))
    );
  });
}

// roda e devolve stderr (ffmpeg escreve silencedetect/showinfo lá), sem rejeitar em código != 0
function runAll(bin, args) {
  return new Promise((resolve, reject) => {
    const p = track(spawn(bin, args));
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, err }));
  });
}

// ---------- progresso ----------
// Divide o trabalho em etapas com pesos; cada etapa informa sua fração (0..1) e o total vira uma porcentagem.
// Fica só na memória (holder.prog): não grava em disco a cada atualização.
function progress(holder, steps) {
  const total = steps.reduce((a, s) => a + s.w, 0) || 1;
  let base = 0, idx = 0;
  const set = (pct, stage) => { holder.prog = { pct: Math.max(0, Math.min(99, Math.round(pct))), stage }; };
  return {
    start(i) { idx = Math.min(i, steps.length - 1); base = steps.slice(0, idx).reduce((a, s) => a + s.w, 0); set((base / total) * 100, steps[idx].label); },
    frac(f) { const x = Math.min(1, Math.max(0, f || 0)); set(((base + steps[idx].w * x) / total) * 100, steps[idx].label); },
    end() { delete holder.prog; },
  };
}

// ffmpeg com progresso real: lê out_time de "-progress pipe:1" e divide pela duração esperada da saída
function runFfmpegProgress(args, totalSec, onFrac, opts = {}) {
  return new Promise((resolve, reject) => {
    const p = track(spawn(ffmpegPath, ["-progress", "pipe:1", "-nostats", ...args], opts));
    let err = "", buf = "";
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
        if (m && totalSec > 0 && onFrac) onFrac(Math.min(1, +m[1] / 1e6 / totalSec));
      }
    });
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.split("\n").slice(-6).join("\n")))));
  });
}

// como run(), mas deixa ver o stderr enquanto roda (whisper imprime o progresso lá)
function runStream(bin, args, onErr) {
  return new Promise((resolve, reject) => {
    const p = track(spawn(bin, args));
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => { err += d; onErr?.(String(d)); });
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.split("\n").slice(-6).join("\n")))));
  });
}

async function hasAudio(file) {
  const out = await run(ffprobe.path, [
    "-v", "error", "-select_streams", "a", "-show_entries", "stream=index", "-of", "csv=p=0", file,
  ]);
  return out.trim().length > 0;
}

async function duration(file) {
  const out = await run(ffprobe.path, ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file]);
  return parseFloat(out) || 0;
}

// Normaliza todo clipe pro mesmo formato (1080x1920, 30fps, aac) -> concatenação sem reencode
async function normalize(input, output, onFrac = null) {
  const audio = await hasAudio(input);
  const total = await duration(input);
  const vf = `scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${FPS},format=yuv420p`;
  const args = ["-y", "-i", input];
  if (!audio) args.push("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo");
  args.push(
    "-map", "0:v:0", "-map", audio ? "0:a:0" : "1:a:0",
    "-vf", vf,
    "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS),
    "-c:a", "aac", "-ar", "44100", "-ac", "2", "-b:a", "160k",
    "-shortest", "-movflags", "+faststart", output
  );
  await runFfmpegProgress(args, total, onFrac);
}

async function concat(files, output) {
  const list = output + ".txt";
  fs.writeFileSync(list, files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
  try {
    await run(ffmpegPath, ["-y", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", "-movflags", "+faststart", output]);
  } finally {
    fs.rmSync(list, { force: true });
  }
}

// ---------- fila única (um ffmpeg por vez) ----------
const queue = [];
let busy = false;
function enqueue(fn) {
  queue.push(fn);
  pump();
}
async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    try { await queue.shift()(); } catch (e) { console.error(e); }
  }
  busy = false;
}

function enqueueP(fn) {
  return new Promise((resolve, reject) => enqueue(() => fn().then(resolve, reject)));
}

// ---------- cortar pausas longas (jump cut) ----------

async function cutPauses(src, out, { minPause = 0.4, keep = 0.1, segments = [] } = {}, onFrac = null) {
  minPause = Math.min(10, Math.max(0.2, +minPause || 0.4));
  keep = Math.min(0.5, Math.max(0, +keep || 0));
  const total = await duration(src);
  const r = await runAll(ffmpegPath, ["-i", src, "-af", `silencedetect=noise=-32dB:d=${minPause}`, "-f", "null", "-"]);
  // Clipe INTEIRO sem áudio (b-roll mudo) não é pausa de fala: não corta. Pausa no meio de uma fala corta sempre.
  // "segments" = [início, fim] de cada clipe dentro do vídeo; silêncio digital (-80dB) que cobre quase um clipe todo é protegido.
  onFrac?.(0.08);
  const syn = await runAll(ffmpegPath, ["-i", src, "-af", "silencedetect=noise=-80dB:d=0.5", "-f", "null", "-"]);
  onFrac?.(0.15);
  checkCancel();
  const sStarts = [...syn.err.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1]);
  const sEnds = [...syn.err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const synthetic = sStarts.map((st, i) => [Math.max(0, st), sEnds[i] ?? total]);
  const overlap = (a, b) => synthetic.reduce((acc, [x, y]) => acc + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
  const mutedClip = (a, b) => segments.some(([x, y]) => {
    const len = y - x;
    return len > 0 && Math.max(0, Math.min(b, y) - Math.max(a, x)) / len >= 0.85 && overlap(Math.max(a, x), Math.min(b, y)) / len >= 0.85;
  });
  const starts = [...r.err.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1]);
  const ends = [...r.err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const cuts = [];
  starts.forEach((st, i) => {
    const en = ends[i] ?? total;
    const len = en - st;
    if (len >= minPause && !mutedClip(Math.max(0, st), en)) {
      const a = Math.max(0, st) + keep, b = en - keep;
      if (b - a > 0.05) cuts.push([a, b]);
    }
  });
  if (!cuts.length) return 0;
  const removed = cuts.reduce((acc, [a, b]) => acc + (b - a), 0);
  const keeps = [];
  let pos = 0;
  for (const [a, b] of cuts) { if (a - pos > 0.05) keeps.push([pos, a]); pos = b; }
  if (total - pos > 0.05) keeps.push([pos, total]);
  const f = (n) => n.toFixed(3);
  const graph =
    keeps.map(([a, b], i) =>
      `[0:v]trim=start=${f(a)}:end=${f(b)},setpts=PTS-STARTPTS[v${i}];[0:a]atrim=start=${f(a)}:end=${f(b)},asetpts=PTS-STARTPTS[a${i}]`).join(";") +
    `;${keeps.map((_, i) => `[v${i}][a${i}]`).join("")}concat=n=${keeps.length}:v=1:a=1[v][a]`;
  const script = path.join(DIRS.tmp, crypto.randomUUID() + ".txt");
  fs.writeFileSync(script, graph);
  try {
    await runFfmpegProgress([
      "-y", "-i", src, "-filter_complex_script", script, "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", out,
    ], Math.max(0.5, total - removed), (f) => onFrac?.(0.15 + 0.85 * f));
  } finally {
    fs.rmSync(script, { force: true });
  }
  return removed;
}

// ---------- ler o texto na tela de uma referência (OCR local, sem API) ----------
let ocrWorker = null;
async function getOcr() {
  if (!ocrWorker) {
    const { createWorker } = await import("tesseract.js");
    const cachePath = path.join(DATA, "tess");
    fs.mkdirSync(cachePath, { recursive: true });
    ocrWorker = await createWorker("por", 1, { cachePath });
  }
  return ocrWorker;
}

const alnum = (t) => t.toLowerCase().normalize("NFD").replace(/[^a-z0-9]/g, "");
function similar(a, b) {
  if (!a || !b) return false;
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > Math.max(n, m) * 0.25) return false;
  let prev = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const cur = [i];
    for (let j = 1; j <= m; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return 1 - prev[m] / Math.max(n, m) >= 0.8;
}
// tira lixo que o OCR inventa nas pontas ("Coconut €", "* Body")
function cleanLine(t) {
  const toks = t.trim().split(/\s+/).filter(Boolean);
  const junk = (w) => w.length === 1 && !/[aeoAEOÀ-ÿ]/.test(w) || !/[\p{L}\p{N}]/u.test(w);
  while (toks.length && junk(toks[0])) toks.shift();
  while (toks.length && junk(toks[toks.length - 1])) toks.pop();
  return toks.join(" ").replace(/^[^\p{L}\p{N}]+/u, "").trim();
}

// Texto que aparece fixo por cima do vídeo: acha as linhas que se repetem na maioria dos quadros.
// Devolve { content, yPct, size, start, end, color } ou null.
async function readRefText(ref) {
  const dir = path.join(DIRS.refs, ref.id);
  const preview = path.join(dir, "preview.mp4");
  const N = 6, FW = 540;
  const work = path.join(DIRS.tmp, "ocr-" + ref.id);
  fs.mkdirSync(work, { recursive: true });
  try {
    const dim = (await run(ffprobe.path, ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", preview])).trim().split(",").map(Number);
    const FH = Math.round((FW * dim[1]) / dim[0]);
    const dur = await duration(preview);
    // só o que é muito claro vira preto sobre branco: legenda branca por cima do vídeo fica legível pro OCR
    await run(ffmpegPath, ["-y", "-i", preview, "-vf",
      `fps=${(N / Math.max(dur, 1)).toFixed(4)},scale=${FW}:-1,format=gray,lut=y='if(gt(val,225),0,255)'`, path.join(work, "o%d.png")]);
    const files = fs.readdirSync(work).filter((f) => /^o\d+\.png$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    const w = await getOcr();
    const frames = [];
    for (const f of files) {
      const { data } = await w.recognize(path.join(work, f));
      frames.push((data.lines || [])
        .map((l) => ({ t: cleanLine(l.text), c: l.confidence, y0: l.bbox.y0, y1: l.bbox.y1 }))
        .filter((l) => l.c >= 60 && alnum(l.t).length >= 4));
    }
    // agrupa linhas parecidas entre quadros
    const groups = [];
    frames.forEach((lines, fi) => lines.forEach((l) => {
      const k = alnum(l.t);
      const g = groups.find((x) => similar(x.key, k));
      if (g) { g.items.push({ ...l, fi }); } else groups.push({ key: k, items: [{ ...l, fi }] });
    }));
    const need = Math.max(2, Math.ceil(files.length * 0.5));
    const stable = groups.filter((g) => new Set(g.items.map((i) => i.fi)).size >= need);
    if (!stable.length) return null;
    const lines = stable.map((g) => {
      const best = g.items.reduce((a, b) => (b.c > a.c ? b : a));
      const ys = g.items.map((i) => i.y0).sort((a, b) => a - b);
      return { t: best.t, y0: ys[Math.floor(ys.length / 2)], h: best.y1 - best.y0, fis: g.items.map((i) => i.fi) };
    }).sort((a, b) => a.y0 - b.y0);
    const top = lines[0].y0, bottom = Math.max(...lines.map((l) => l.y0 + l.h));
    const avgH = lines.reduce((a, l) => a + l.h, 0) / lines.length;
    const fis = lines.flatMap((l) => l.fis);
    const present = new Set(fis).size;
    const first = Math.min(...fis), last = Math.max(...fis);
    const always = present / files.length >= 0.8;
    return {
      content: lines.map((l) => l.t).join("\n"),
      yPct: Math.round(((top + bottom) / 2 / FH) * 100),
      size: Math.max(30, Math.min(200, Math.round((avgH / FW) * 1080))),
      color: "#FFFFFF",
      start: always ? 0 : +((first * dur) / files.length).toFixed(1),
      end: always ? 999 : +(((last + 1) * dur) / files.length).toFixed(1), // 999 = até o fim do vídeo
    };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

// ---------- referências: prévia leve + métricas de ritmo + quadros ----------
async function analyzeRef(ref, rawPath) {
  const dir = path.join(DIRS.refs, ref.id);
  fs.mkdirSync(dir, { recursive: true });
  const preview = path.join(dir, "preview.mp4");
  try {
    await run(ffmpegPath, [
      "-y", "-i", rawPath, "-vf", "scale=360:-2,format=yuv420p", "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
      "-c:a", "aac", "-b:a", "96k", "-ar", "44100", "-movflags", "+faststart", preview,
    ]);
    const dur = await duration(preview);
    const sil = await runAll(ffmpegPath, ["-i", preview, "-af", "silencedetect=noise=-30dB:d=0.25", "-f", "null", "-"]);
    const pauses = [...sil.err.matchAll(/silence_duration: ([\d.]+)/g)].map((m) => +m[1]);
    const longPauses = pauses.filter((d) => d >= 0.4).length;
    const scene = await runAll(ffmpegPath, ["-i", preview, "-vf", "select='gt(scene,0.3)',showinfo", "-an", "-f", "null", "-"]);
    const cuts = (scene.err.match(/pts_time:/g) || []).length;
    await run(ffmpegPath, ["-y", "-i", preview, "-vf", `fps=${(6 / Math.max(dur, 1)).toFixed(4)},scale=270:-1`, "-q:v", "3", path.join(dir, "f%d.jpg")]);
    ref.frames = fs.readdirSync(dir).filter((f) => /^f\d+\.jpg$/.test(f)).sort((a, b) => parseInt(a.slice(1)) - parseInt(b.slice(1)));
    ref.metrics = { duration: dur, cutsPerMin: dur ? +(cuts / dur * 60).toFixed(1) : 0, longPauses, pauseTime: +pauses.reduce((a, b) => a + b, 0).toFixed(1) };
    // referência sem pausas longas = edição "seca": liga o corte de pausas por padrão
    ref.style = {
      captions: { ...db.defaults.captions },
      cut: { enabled: longPauses === 0 && dur > 5, minPause: 0.4, keep: 0.1 },
      text: { anim: "pop", font: "Anton", color: "#FFFFFF", size: 96, yPct: 25, start: 0, end: 3, box: false, boxColor: "#000000" },
    };
    ref.status = "ready";
    save(db);
    try {
      const t = await readRefText(ref);
      if (t) ref.style.text = { ...ref.style.text, ...t };
    } catch (e) {
      console.error("OCR da referência falhou:", e.message); // sem internet p/ baixar o idioma, etc.: segue sem texto
    }
  } catch (e) {
    ref.status = "error";
    ref.error = e.message;
  } finally {
    fs.rm(rawPath, { force: true }, () => {});
    save(db);
  }
}

// ---------- legendas: transcrição + render sobre o vídeo pronto ----------
const hasEdit = (e) => !!((e?.captions?.enabled && e.captions.words?.length) || e?.texts?.some((t) => String(t.text || "").trim()));

let tRatio = 1.2; // segundos de processamento por segundo de áudio; aprende com o uso (só para estimar a barra)
async function transcribeFile(videoPath, lang = "pt", onFrac = null) {
  lang = String(lang).replace(/[^a-z-]/gi, "") || "pt";
  const wav = path.join(DIRS.tmp, crypto.randomUUID() + ".wav");
  try {
    await run(ffmpegPath, ["-y", "-i", videoPath, "-vn", "-ar", "16000", "-ac", "1", wav]);
    checkCancel();
    const audioDur = await duration(wav);
    const t0 = Date.now();
    let real = false;
    const timer = onFrac ? setInterval(() => { if (!real) onFrac(Math.min(0.95, (Date.now() - t0) / 1000 / (3 + audioDur * tRatio))); }, 500) : null;
    let out;
    try {
    if (WHISPER_BIN) {
      if (!fs.existsSync(WHISPER_MODEL_PATH)) throw new Error("Modelo Whisper ainda não foi baixado: " + WHISPER_MODEL_PATH);
      out = await runStream(WHISPER_BIN, [
        "-m", WHISPER_MODEL_PATH, "-f", wav, "-l", lang, "-ml", "1", "-sow", "-pp",
        "-t", String(Math.min(8, os.cpus().length)),
      ], (chunk) => {
        const m = [...chunk.matchAll(/progress\s*=\s*(\d+)%/g)].pop();
        if (m && onFrac) { real = true; onFrac(Math.min(0.98, +m[1] / 100)); }
      });
    } else {
      const model = fs.existsSync(VIBE_CONFIG) ? JSON.parse(fs.readFileSync(VIBE_CONFIG, "utf8"))["model.path"] : null;
      if (!model || !fs.existsSync(model) || !fs.existsSync(VIBE))
        throw new Error("Transcrição não configurada: defina WHISPER_BIN (whisper.cpp) ou instale o Vibe.");
      out = await run(VIBE, [
        "transcribe", model, wav, "--word-timestamps", "--max-segment-len", "1",
        ...(lang === "auto" ? ["--detect-language"] : ["-l", lang]),
      ]);
    }
    } finally {
      if (timer) clearInterval(timer);
    }
    if (audioDur > 2) tRatio = 0.5 * tRatio + 0.5 * Math.max(0.05, ((Date.now() - t0) / 1000 - 2) / audioDur);
    onFrac?.(1);
    const re = /^\[(\d+):(\d+):(\d+)\.(\d+) --> (\d+):(\d+):(\d+)\.(\d+)\]\s?(.*)$/;
    const sec = (h, m, s_, ms) => +h * 3600 + +m * 60 + +s_ + +ms / 1000;
    return out.split("\n").map((l) => re.exec(l)).filter(Boolean)
      .map((m) => ({ s: sec(m[1], m[2], m[3], m[4]), e: sec(m[5], m[6], m[7], m[8]), t: m[9].trim() }))
      .filter((w) => w.t && !/^\[.*\]$/.test(w.t));
  } finally {
    fs.rmSync(wav, { force: true });
  }
}

// grava a versão legendada em v.capFile (o vídeo original continua intacto)
async function renderVariation(v, pg = null, stepIdx = 0) {
  const own = !pg;
  if (own) pg = progress(v, [{ label: "Aplicando legenda e texto", w: 1 }]);
  pg.start(stepIdx);
  v.cap = "processing";
  delete v.capError;
  save(db);
  try {
    const assText = hasEdit(v.edit) ? buildAss(v.edit) : null;
    const old = v.capFile;
    if (!assText) {
      if (old) fs.rmSync(path.join(DIRS.out, old), { force: true });
      v.capFile = null;
    } else {
      const assName = v.id + ".ass";
      const outName = `cap-${Date.now()}-${v.id.slice(0, 4)}.mp4`;
      fs.writeFileSync(path.join(DIRS.tmp, assName), assText);
      const srcPath = path.join(DIRS.out, v.baseFile || v.file);
      currentJob?.files.push(outName);
      checkCancel();
      await runFfmpegProgress([
        "-y", "-i", srcPath,
        "-vf", `ass=${assName}:fontsdir=${FONTS_DIR}`,
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-r", String(FPS), "-pix_fmt", "yuv420p",
        "-c:a", "copy", "-movflags", "+faststart", path.join(DIRS.out, outName),
      ], await duration(srcPath), (f) => pg.frac(f), { cwd: DIRS.tmp });
      fs.rmSync(path.join(DIRS.tmp, assName), { force: true });
      if (old) fs.rmSync(path.join(DIRS.out, old), { force: true });
      v.capFile = outName;
    }
    v.cap = "idle";
  } catch (e) {
    v.cap = "error";
    v.capError = e.message;
  }
  if (own) pg.end();
  save(db);
}

// ---------- API ----------
const app = express();
// login por e-mail e senha (APP_EMAIL e APP_PASSWORD no servidor; sem APP_PASSWORD o sistema fica aberto)
const auth = setupAuth(app, {
  dataDir: DATA,
  projectCount: (uid) => db.projects.filter((p) => p.owner === uid).length,
  onUserRemoved: (uid) => { db.projects.forEach((p) => { if (p.owner === uid) p.owner = "admin"; }); save(db); }, // os projetos de quem saiu ficam com o administrador
});
app.use(express.json({ limit: "5mb" }));

// ---------- quem pode ver o quê ----------
const isAdmin = (req) => req.user?.role === "admin";
const canProject = (req, pid) => {
  const p = db.projects.find((x) => x.id === pid);
  return isAdmin(req) || !p || p.owner === req.user?.id;   // projeto inexistente: o erro normal da rota responde
};
const canVariation = (req, vid) => {
  const v = db.variations.find((x) => x.id === vid);
  return isAdmin(req) || !v || canProject(req, v.project);
};
// Toda rota da API que cita um projeto, clipe ou variação é checada aqui, antes de chegar à rota.
// Sem permissão responde "não encontrado" (não revela que o item existe).
app.use((req, res, next) => {
  if (!req.path.startsWith("/api/") || isAdmin(req)) return next();
  const pids = new Set();
  const addP = (x) => x && pids.add(String(x));
  addP(req.query.project); addP(req.body?.project);
  const vids = [...(Array.isArray(req.body?.ids) ? req.body.ids : []), ...String(req.query.ids || "").split(",").filter(Boolean)];
  for (const id of vids) addP(db.variations.find((x) => x.id === id)?.project);
  const m = /^\/api\/(clips|variations|projects)\/([0-9a-f-]{36})/.exec(req.path);
  if (m) {
    if (m[1] === "projects") addP(m[2]);
    else addP((m[1] === "clips" ? db.clips : db.variations).find((x) => x.id === m[2])?.project);
  }
  for (const pid of pids) if (!canProject(req, pid)) return res.status(404).json({ error: "Não encontrado." });
  next();
});
// Os arquivos de vídeo também: ninguém abre o vídeo de outra pessoa nem sabendo o nome do arquivo.
const mediaGuard = (kind) => (req, res, next) => {
  if (isAdmin(req)) return next();
  let f = "";
  try { f = decodeURIComponent(req.path.slice(1)); } catch { return res.sendStatus(404); }
  const project = kind === "clips"
    ? db.clips.find((c) => c.file === f || c.tfile === f)?.project
    : db.variations.find((v) => v.file === f || v.capFile === f || v.baseFile === f)?.project;
  return project && canProject(req, project) ? next() : res.sendStatus(404);
};
app.use("/media/clips", mediaGuard("clips"));
app.use("/media/output", mediaGuard("output"));
app.use("/fonts", express.static(FONTS_DIR));
app.use(express.static(path.join(__dirname, "public")));
app.use("/media/clips", express.static(DIRS.clips));
app.use("/media/output", express.static(DIRS.out));

const upload = multer({
  storage: multer.diskStorage({
    destination: DIRS.raw,
    filename: (_, f, cb) => cb(null, crypto.randomUUID() + path.extname(f.originalname || ".mp4")),
  }),
});

// /data só persiste se for um volume montado (device diferente do disco raiz do container)
const IN_CONTAINER = fs.existsSync("/.dockerenv") || fs.existsSync("/run/.containerenv");

// Lê /proc/self/mountinfo e diz se a pasta de dados está num volume DE VERDADE.
// Sem volume, ou com volume anônimo (o Docker cria um novo a cada deploy), os dados somem.
export function mountReason(mountinfo, dataPath) {
  let best = null;
  for (const line of mountinfo.split("\n")) {
    const f = line.split(" ");
    if (f.length < 6) continue;
    const root = f[3], mp = f[4].replace(/\\040/g, " ");
    if (dataPath === mp || dataPath.startsWith(mp.endsWith("/") ? mp : mp + "/")) {
      if (!best || mp.length >= best.mp.length) best = { root, mp };
    }
  }
  if (!best || best.mp === "/") return "none";
  if (/\/volumes\/[0-9a-f]{64}\/_data/.test(best.root)) return "anonymous";
  return "ok";
}

function storageInfo() {
  // fora de container (ex.: no seu Mac) os dados ficam no disco normal: sempre persistem
  if (!IN_CONTAINER) return { persistent: true, path: DATA };
  try {
    const reason = mountReason(fs.readFileSync("/proc/self/mountinfo", "utf8"), path.resolve(DATA));
    return { persistent: reason === "ok", reason, path: DATA };
  } catch {
    // sem mountinfo: cai na checagem antiga (dispositivo diferente do raiz)
    try { return { persistent: fs.statSync(DATA).dev !== fs.statSync("/").dev, path: DATA }; }
    catch { return { persistent: true, path: DATA }; }
  }
}
// Estado do projeto aberto (?project=ID) + o que é compartilhado (referências, estilo padrão)
app.get("/api/state", (req, res) => {
  const pid = String(req.query.project || "");
  const project = db.projects.find((p) => p.id === pid) || null;
  res.json({
    project: project && { id: project.id, name: project.name },
    clips: project ? db.clips.filter((c) => c.project === pid) : [],
    variations: project ? db.variations.filter((v) => v.project === pid) : [],
    refs: db.refs,
    defaults: db.defaults,
    storage: storageInfo(),
  });
});

// ---------- projetos ----------
const projectSummary = (p) => {
  const clips = db.clips.filter((c) => c.project === p.id), vars = db.variations.filter((v) => v.project === p.id);
  const rv = vars.find((v) => v.status === "ready"), rc = clips.find((c) => c.status === "ready");
  const thumb = rv ? { dir: "output", file: rv.capFile || rv.baseFile || rv.file } : rc ? { dir: "clips", file: rc.tfile || rc.file } : null;
  const busy = vars.some((v) => v.cap === "processing" || v.status === "processing" || v.status === "queued") || clips.some((c) => c.status === "processing" || c.prog);
  return { id: p.id, name: p.name, owner: p.owner, ownerEmail: auth.emailOf(p.owner), createdAt: p.createdAt, updatedAt: p.updatedAt, clips: clips.length, variations: vars.length, thumb, busy };
};
app.get("/api/projects", (req, res) =>
  res.json({ projects: db.projects.filter((p) => isAdmin(req) || p.owner === req.user?.id).sort((a, b) => b.updatedAt - a.updatedAt).map(projectSummary), storage: storageInfo() }));
app.post("/api/projects", (req, res) => {
  const name = String(req.body?.name || "").trim().slice(0, 80) || `Projeto ${db.projects.length + 1}`;
  const p = { id: crypto.randomUUID(), name, owner: req.user?.id || "admin", createdAt: Date.now(), updatedAt: Date.now() };
  db.projects.push(p);
  save(db);
  res.json(projectSummary(p));
});
app.put("/api/projects/:id", (req, res) => {
  const p = db.projects.find((x) => x.id === req.params.id);
  const name = String(req.body?.name || "").trim().slice(0, 80);
  if (!p || !name) return res.sendStatus(400);
  p.name = name;
  p.updatedAt = Date.now();
  save(db);
  res.json(projectSummary(p));
});
app.delete("/api/projects/:id", (req, res) => {
  const p = db.projects.find((x) => x.id === req.params.id);
  if (!p) return res.sendStatus(404);
  if (projectSummary(p).busy) return res.status(409).json({ error: "Há vídeos sendo convertidos ou editados neste projeto. Espere terminar ou cancele antes de excluir." });
  const rm = (dir, f) => f && fs.rmSync(path.join(dir, f), { force: true });
  for (const c of db.clips.filter((x) => x.project === p.id)) { rm(DIRS.clips, c.file); rm(DIRS.clips, c.tfile); }
  for (const v of db.variations.filter((x) => x.project === p.id)) { rm(DIRS.out, v.file); rm(DIRS.out, v.capFile); rm(DIRS.out, v.baseFile); jobs.delete(v.id); }
  db.clips = db.clips.filter((c) => c.project !== p.id);
  db.variations = db.variations.filter((v) => v.project !== p.id);
  db.projects = db.projects.filter((x) => x !== p);
  save(db);
  res.sendStatus(204);
});
// "atualizado em": qualquer alteração (upload, tratamento, geração, edição, exclusão) marca o projeto como mexido agora
app.use((req, res, next) => {
  if (req.method === "GET" || req.method === "HEAD") return next();
  const pids = new Set();
  const add = (x) => x && pids.add(x);
  add(req.query.project); add(req.body?.project);
  for (const vid of Array.isArray(req.body?.ids) ? req.body.ids : []) add(db.variations.find((x) => x.id === vid)?.project);
  const m = /^\/api\/(clips|variations)\/([0-9a-f-]{36})/.exec(req.path);
  if (m) add((m[1] === "clips" ? db.clips : db.variations).find((x) => x.id === m[2])?.project);
  res.on("finish", () => {
    if (res.statusCode >= 400) return;
    let touched = false;
    for (const id of pids) { const p = db.projects.find((x) => x.id === id); if (p) { p.updatedAt = Date.now(); touched = true; } }
    if (touched) save(db);
  });
  next();
});

app.post("/api/clips/:type", upload.array("files"), (req, res) => {
  const { type } = req.params;
  const project = db.projects.find((p) => p.id === req.query.project);
  if (!TYPES.includes(type) || !project) {
    (req.files || []).forEach((f) => fs.rm(f.path, { force: true }, () => {}));
    return res.status(400).json({ error: !project ? "Projeto não encontrado." : "tipo inválido" });
  }
  const created = req.files.map((f) => {
    const id = crypto.randomUUID();
    const clip = {
      id, type, project: project.id,
      name: Buffer.from(f.originalname, "latin1").toString("utf8"),
      file: id + ".mp4",
      status: "processing",
      reviewed: false,
      trim: { start: 0, end: 0 },
      gainDb: 0,
      prog: { pct: 0, stage: "Na fila" },
    };
    db.clips.push(clip);
    enqueue(async () => {
      try {
        clip.prog = { pct: 0, stage: "Convertendo" };
        await normalize(f.path, path.join(DIRS.clips, clip.file), (fr) => { clip.prog = { pct: Math.min(99, Math.round(fr * 100)), stage: "Convertendo" }; });
        clip.duration = await duration(path.join(DIRS.clips, clip.file));
        clip.status = "ready";
      } catch (e) {
        clip.status = "error";
        clip.error = e.message;
      } finally {
        delete clip.prog;
        fs.rm(f.path, { force: true }, () => {});
        save(db);
      }
    });
    return clip;
  });
  save(db);
  res.json(created);
});

app.delete("/api/clips/:id", (req, res) => {
  const clip = db.clips.find((c) => c.id === req.params.id);
  if (!clip) return res.sendStatus(404);
  fs.rmSync(path.join(DIRS.clips, clip.file), { force: true });
  if (clip.tfile) fs.rmSync(path.join(DIRS.clips, clip.tfile), { force: true });
  db.clips = db.clips.filter((c) => c !== clip);
  save(db);
  res.sendStatus(204);
});

// ---- tratamento: acha o silêncio do começo e do fim (a sugestão é calculada no painel, com a folga escolhida) ----
const NOISE_LEVELS = [-45, -35, -28]; // corta menos / normal / corta mais (tolera ruído de fundo)
async function silenceEdges(c, noise) {
  const file = path.join(DIRS.clips, c.file);
  const full = c.duration || (await duration(file));
  const r = await runAll(ffmpegPath, ["-i", file, "-vn", "-af", `silencedetect=noise=${noise}dB:d=0.3`, "-f", "null", "-"]);
  const starts = [...r.err.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1]);
  const ends = [...r.err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const sil = starts.map((st, i) => [Math.max(0, st), ends[i] ?? full]);
  const first = sil[0], last = sil[sil.length - 1];
  const lead = first && first[0] <= 0.1 ? first[1] : 0;          // até onde vai o silêncio colado no começo
  const trail = last && last[1] >= full - 0.1 ? last[0] : full;   // onde começa o silêncio colado no fim
  if (lead >= full - 0.3 || trail <= 0.3 || trail - lead < 0.5) return { none: true, reason: "sem áudio", duration: full };
  return { lead: +lead.toFixed(2), trail: +trail.toFixed(2), duration: full };
}
app.post("/api/clips/:id/suggest-trim", async (req, res) => {
  const c = db.clips.find((x) => x.id === req.params.id && x.status === "ready");
  if (!c) return res.sendStatus(404);
  const noise = NOISE_LEVELS.includes(+req.body?.noise) ? +req.body.noise : -35;
  try {
    c.edges ||= {};
    if (!c.edges[noise]) { c.edges[noise] = await silenceEdges(c, noise); save(db); }   // o original não muda: guarda o resultado
    res.json(c.edges[noise]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- tratamento: confirma o corte de um clipe (sem renderizar ainda) ----
app.post("/api/clips/:id/review", async (req, res) => {
  const c = db.clips.find((x) => x.id === req.params.id && x.status === "ready");
  if (!c) return res.sendStatus(404);
  const full = c.duration || (await duration(path.join(DIRS.clips, c.file)));
  let start = Math.max(0, +req.body?.start || 0);
  let end = +req.body?.end > 0 ? Math.min(+req.body.end, full) : 0;
  if (end >= full - 0.05) end = 0;
  if (start <= 0.05) start = 0;
  if ((end || full) - start < 0.3) return res.status(400).json({ error: "O trecho ficou curto demais (mínimo 0,3 s)." });
  const speed = Math.min(3, Math.max(0.5, +req.body?.speed || 1));
  if (((end || full) - start) / speed < 0.2) return res.status(400).json({ error: "Com essa velocidade o vídeo ficaria curto demais." });
  c.speed = +speed.toFixed(2);
  c.trim = { start: +start.toFixed(2), end: +end.toFixed(2) };
  c.reviewed = true;
  save(db);
  res.json(c);
});
app.post("/api/clips/:id/unreview", (req, res) => {
  const c = db.clips.find((x) => x.id === req.params.id);
  if (!c) return res.sendStatus(404);
  c.reviewed = false;
  save(db);
  res.json(c);
});

// ---- tratamento: mede o volume de todos os clipes (já com o corte) e sugere o ganho para igualar ----
app.post("/api/treat/loudness", async (req, res) => {
  const pid = req.body?.project;
  try {
    const clips = await enqueueP(async () => {
      const out = {};
      for (const c of db.clips.filter((x) => x.status === "ready" && x.project === pid)) {
        const full = c.duration || (await duration(path.join(DIRS.clips, c.file)));
        const t = c.trim || {};
        const start = Math.max(0, +t.start || 0);
        const end = +t.end > 0 ? Math.min(+t.end, full) : full;
        const lufs = await measureLufs(path.join(DIRS.clips, c.file), start, end);
        const silent = lufs === null || lufs < -55;
        out[c.id] = { lufs, silent, gainDb: silent ? 0 : +Math.max(-20, Math.min(20, TARGET_LUFS - lufs)).toFixed(1) };
      }
      return out;
    });
    res.json({ target: TARGET_LUFS, clips });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- tratamento: aplica corte + volume (gera a versão tratada de cada clipe que mudou) ----
app.post("/api/treat/finalize", (req, res) => {
  const gains = req.body?.gains || {};
  const ready = db.clips.filter((c) => c.status === "ready" && c.project === req.body?.project);
  if (ready.some((c) => !c.reviewed)) return res.status(400).json({ error: "Ainda há vídeos sem tratamento: confirme o corte de cada um (OK, próximo)." });
  for (const c of ready) if (gains[c.id] !== undefined) c.gainDb = Math.max(-30, Math.min(24, +gains[c.id] || 0));
  const todo = ready.filter((c) => needsRender(c) || c.treatError);
  for (const c of todo) {
    c.prog = { pct: 0, stage: "Na fila" };
    delete c.treatError;
    enqueue(async () => {
      try { await renderTreatedClip(c); } catch (e) { c.treatError = e.message; } finally { delete c.prog; save(db); }
    });
  }
  save(db);
  res.json({ queued: todo.length });
});

// transcreve o áudio de uma variação pronta (para o editor de legenda)
app.post("/api/variations/:id/transcribe", async (req, res) => {
  const v = db.variations.find((x) => x.id === req.params.id);
  if (!v || v.status !== "ready") return res.sendStatus(404);
  try {
    const words = await enqueueP(() => transcribeFile(path.join(DIRS.out, v.baseFile || v.file), req.body?.language));
    res.json({ words });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// salva a edição (legenda/textos) de uma variação e renderiza
app.put("/api/variations/:id/edit", (req, res) => {
  const v = db.variations.find((x) => x.id === req.params.id);
  if (!v || v.status !== "ready") return res.sendStatus(404);
  const newEdit = req.body || {};
  queueVariationJob(v, () => { v.edit = newEdit; return renderVariation(v); });
  save(db);
  res.json(v);
});

// início/fim de cada clipe (gancho, corpo, CTA) dentro do vídeo concatenado
// ---------- tratamento dos clipes (corte de início/fim + volume), antes de juntar ----------
// clip.file = original convertido (nunca muda); clip.tfile = versão tratada (se houver corte/ganho)
const clipFile = (c) => c.tfile || c.file;
const clipDur = (c) => c.tdur || c.duration;
const wantedOf = (c) => ({ start: +c.trim?.start || 0, end: +c.trim?.end || 0, gainDb: +c.gainDb || 0, speed: +c.speed || 1 });
const normW = (w) => ({ start: +w?.start || 0, end: +w?.end || 0, gainDb: +w?.gainDb || 0, speed: +w?.speed || 1 });
const needsRender = (c) => c.reviewed && JSON.stringify(wantedOf(c)) !== JSON.stringify(normW(c.rendered));
// atempo aceita 0,5 a 2 por etapa: encadeia para velocidades maiores/menores (o tom da voz é preservado)
const atempoChain = (x) => { const p = []; while (x > 2) { p.push("atempo=2"); x /= 2; } while (x < 0.5) { p.push("atempo=0.5"); x /= 0.5; } p.push(`atempo=${x.toFixed(4)}`); return p.join(","); };

async function renderTreatedClip(c) {
  if (!db.clips.includes(c)) return;
  const want = wantedOf(c);
  const src = path.join(DIRS.clips, c.file);
  const full = c.duration || (await duration(src));
  const start = Math.max(0, want.start);
  const end = want.end > 0 ? Math.min(want.end, full) : full;
  const trimmed = start > 0.05 || end < full - 0.05;
  const speed = want.speed;
  const old = c.tfile;
  c.prog = { pct: 0, stage: "Tratando" };
  const setProg = (f) => { c.prog = { pct: Math.min(99, Math.round(f * 100)), stage: "Tratando" }; };
  if (!trimmed && !want.gainDb && speed === 1) {
    c.tfile = null;
    c.tdur = null;
  } else {
    const name = `${c.id}.t${Date.now()}.mp4`;
    const out = path.join(DIRS.clips, name);
    const vol = want.gainDb ? `volume=${want.gainDb}dB,alimiter=limit=0.97` : "anull";
    try {
      if (!trimmed && speed === 1) {
        // só volume: o vídeo é copiado sem recodificar (rápido)
        await runFfmpegProgress(["-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0", "-c:v", "copy", "-af", vol,
          "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", out], full, setProg);
      } else {
        // corta, muda a velocidade (imagem e som juntos) e ajusta o volume
        const sv = speed !== 1 ? `,setpts=PTS/${speed}` : "";
        const sa = speed !== 1 ? `,${atempoChain(speed)}` : "";
        const fg = `[0:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS${sv}[v];[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS${sa},${vol}[a]`;
        await runFfmpegProgress(["-y", "-i", src, "-filter_complex", fg, "-map", "[v]", "-map", "[a]",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "20", "-r", String(FPS), "-pix_fmt", "yuv420p",
          "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", out], (end - start) / speed, setProg);
      }
    } catch (e) {
      fs.rmSync(out, { force: true });
      throw e;
    }
    c.tfile = name;
    c.tdur = await duration(out);
  }
  if (old && old !== c.tfile) fs.rmSync(path.join(DIRS.clips, old), { force: true });
  c.rendered = want;
}

async function variationSegments(v, parts = v.parts) {
  const segs = [];
  let pos = 0;
  for (const [i, id] of [v.hook, v.body, v.cta].entries()) {
    const c = db.clips.find((x) => x.id === id);
    if (!c) return [];
    const full = clipDur(c) || (await duration(path.join(DIRS.clips, clipFile(c))));
    const p = parts?.[i] || {};
    const st = Math.max(0, +p.start || 0);
    const en = +p.end > 0 ? Math.min(+p.end, full) : full;
    const d = Math.max(0.2, en - st);
    segs.push([pos, pos + d]);
    pos += d;
  }
  return segs;
}

// ---------- partes: trecho (início/fim) e volume de gancho, corpo e CTA ----------
const TARGET_LUFS = -16; // volume-alvo usual de redes sociais
const defaultParts = () => [0, 1, 2].map(() => ({ start: 0, end: 0, gainDb: 0, mute: false }));
const isDefaultParts = (ps) => ps.every((p) => !p.start && !p.end && !p.gainDb && !p.mute);
function normParts(ps) {
  if (!Array.isArray(ps) || ps.length !== 3) return null;
  const n = (x, a, b) => Math.min(b, Math.max(a, Number.isFinite(+x) ? +x : 0));
  return ps.map((p) => ({ start: n(p?.start, 0, 36000), end: n(p?.end, 0, 36000), gainDb: n(p?.gainDb, -40, 24), mute: !!p?.mute }));
}
const partClips = (v) => [v.hook, v.body, v.cta].map((id) => db.clips.find((x) => x.id === id));

// Junta os 3 clipes aplicando corte e volume de cada parte; devolve o nome do arquivo novo
async function assembleParts(v, parts, onFrac) {
  const clips = partClips(v);
  if (clips.some((c) => !c)) throw new Error("um dos clipes originais não existe mais");
  const args = ["-y"], chains = [];
  let total = 0;
  for (const [i, c] of clips.entries()) {
    const full = clipDur(c) || (await duration(path.join(DIRS.clips, clipFile(c))));
    const p = parts[i] || {};
    const start = Math.min(Math.max(0, +p.start || 0), Math.max(0, full - 0.2));
    const end = +p.end > 0 ? Math.min(+p.end, full) : full;
    if (end - start < 0.2) throw new Error(`o trecho da parte ${i + 1} ficou curto demais`);
    const gain = Math.max(-40, Math.min(24, +p.gainDb || 0));
    const vol = p.mute ? "volume=0" : gain ? `volume=${gain}dB,alimiter=limit=0.97` : "anull"; // limitador evita estourar ao aumentar
    args.push("-i", path.join(DIRS.clips, clipFile(c)));
    chains.push(
      `[${i}:v]trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[v${i}]`,
      `[${i}:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS,${vol}[a${i}]`
    );
    total += end - start;
  }
  chains.push("[v0][a0][v1][a1][v2][a2]concat=n=3:v=1:a=1[v][a]");
  const name = `v${String(Date.now()).slice(-6)}-${v.id.slice(0, 4)}.mp4`;
  currentJob?.files.push(name);
  const script = path.join(DIRS.tmp, crypto.randomUUID() + ".txt");
  fs.writeFileSync(script, chains.join(";"));
  try {
    await runFfmpegProgress([
      ...args, "-filter_complex_script", script, "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-ac", "2", "-movflags", "+faststart", path.join(DIRS.out, name),
    ], total, onFrac);
  } finally {
    fs.rmSync(script, { force: true });
  }
  return name;
}

// volume integrado (LUFS) de um trecho de áudio
async function measureLufs(file, start, end) {
  const r = await runAll(ffmpegPath, ["-ss", String(start), "-to", String(end), "-i", file, "-vn", "-af", "ebur128=peak=true", "-f", "null", "-"]);
  const m = [...r.err.matchAll(/I:\s+(-?\d+(?:\.\d+)?)\s+LUFS/g)].pop();
  return m ? +m[1] : null;
}
// mede cada parte (já com o trecho escolhido) e calcula o ganho para chegar ao volume-alvo
async function measureParts(v, parts, onFrac) {
  const out = [];
  for (const [i, c] of partClips(v).entries()) {
    if (!c) throw new Error("um dos clipes originais não existe mais");
    const full = clipDur(c) || (await duration(path.join(DIRS.clips, clipFile(c))));
    const p = parts[i] || {};
    const start = Math.max(0, +p.start || 0);
    const end = +p.end > 0 ? Math.min(+p.end, full) : full;
    const lufs = await measureLufs(path.join(DIRS.clips, clipFile(c)), start, end);
    const silent = lufs === null || lufs < -55; // parte sem áudio: não mexe
    out.push({ lufs, silent, gainDb: silent ? 0 : +Math.max(-20, Math.min(20, TARGET_LUFS - lufs)).toFixed(1) });
    onFrac?.((i + 1) / 3);
  }
  return out;
}
async function equalizeParts(v, parts, onFrac) {
  const m = await measureParts(v, parts, onFrac);
  return parts.map((p, i) => ({ ...p, gainDb: m[i].gainDb }));
}

// corta pausas (opcional) -> transcreve -> aplica legenda + texto
async function captionJob(v, { language = "pt", captions = {}, cut = null, text = null, withCaptions = true } = {}) {
  v.cap = "processing";
  save(db);
  try {
    let base = v.file;
    const oldBase = v.baseFile;
    v.baseFile = null;
    if (cut?.enabled) {
      const name = `cut-${Date.now()}-${v.id.slice(0, 4)}.mp4`;
      currentJob?.files.push(name);
      if (await cutPauses(path.join(DIRS.out, v.file), path.join(DIRS.out, name), { ...cut, segments: await variationSegments(v) })) {
        v.baseFile = name;
        base = name;
      }
    }
    if (oldBase && oldBase !== v.baseFile) trashFile(oldBase);
    let words = [];
    if (withCaptions) {
      words = await transcribeFile(path.join(DIRS.out, base), language);
      if (!words.length) throw new Error("nenhuma fala detectada");
    }
    const texts = [];
    if (String(text?.content || "").trim()) {
      const dur = await duration(path.join(DIRS.out, base));
      const start = Math.max(0, +text.start || 0);
      texts.push({ ...text, text: String(text.content).trim(), start, end: Math.min(dur, Math.max(start + 0.5, +text.end || start + 3)) });
    }
    v.edit = { captions: { ...captions, enabled: withCaptions, words }, texts };
  } catch (e) {
    v.cap = "error";
    v.capError = e.message;
    save(db);
    return;
  }
  await renderVariation(v);
}

// Edição incremental depois de gerar: mexe só no que foi pedido (cut / captions / text) e mantém o resto.
async function applyOps(v, { language = "pt", captions = null, cut = null, text = null, remove = null, parts = null, equalize = false } = {}) {
  v.cap = "processing";
  save(db);
  let pg = progress(v, [{ label: "Preparando", w: 1 }]);
  pg.start(0);
  let steps = [];
  try {
    const prev = v.edit || {};
    const prevCap = prev.captions || {};
    // partes: trechos e volume. Mudar a base refaz o corte de pausas e, se o tempo mudar, a legenda.
    const rmParts = !!remove?.parts && !!v.parts;
    const reparts = !!parts || !!equalize || rmParts;
    const oldParts = v.parts || defaultParts();
    let newParts = rmParts ? defaultParts() : normParts(parts) || oldParts;
    const trimsChanged = reparts && newParts.some((p, i) => (p.start || 0) !== (oldParts[i].start || 0) || (p.end || 0) !== (oldParts[i].end || 0));
    const prevCut = v.cutInfo ? { enabled: true, minPause: v.cutInfo.minPause, keep: 0.1 } : null; // pedido de corte anterior (mesmo que não tenha achado pausa)
    const removeCut = !!remove?.cut && !cut;
    const rmCut = !!remove?.cut && !cut && !!v.baseFile;   // tirar o corte: volta ao vídeo original
    const effCut = cut || (reparts && !removeCut ? prevCut : null); // ao refazer a base, repete o corte que já existia
    const capOn = captions ? true : remove?.captions ? false : !!prevCap.enabled;
    const needT = capOn && (captions || effCut || rmCut || (reparts && trimsChanged) || !(prevCap.words || []).length);
    steps = [
      ...(equalize ? [{ label: "Medindo o volume", w: 2 }] : []),
      ...(reparts ? [{ label: "Montando as partes", w: 4 }] : []),
      ...(effCut ? [{ label: "Cortando pausas", w: 4 }] : []),
      ...(needT ? [{ label: "Transcrevendo a fala", w: 5 }] : []),
      { label: "Aplicando legenda e texto", w: 3 },
    ];
    pg = progress(v, steps);
    let si = 0;
    if (equalize) {
      pg.start(si++);
      newParts = await equalizeParts(v, newParts, (f) => pg.frac(f));
      checkCancel();
    }
    if (reparts) {
      pg.start(si++);
      const name = await assembleParts(v, newParts, (f) => pg.frac(f));
      checkCancel();
      trashFile(v.file);
      v.file = name;
      if (v.baseFile) { trashFile(v.baseFile); v.baseFile = null; }
      delete v.cutInfo;
      if (isDefaultParts(newParts)) delete v.parts; else v.parts = newParts;
    }
    if (effCut) {
      pg.start(si++);
      const oldBase = v.baseFile;
      v.baseFile = null;
      const name = `cut-${Date.now()}-${v.id.slice(0, 4)}.mp4`;
      currentJob?.files.push(name);
      const minPause = Math.min(10, Math.max(0.2, +effCut.minPause || 2));
      const removed = await cutPauses(path.join(DIRS.out, v.file), path.join(DIRS.out, name), { ...effCut, minPause, segments: await variationSegments(v, newParts) }, (f) => pg.frac(f));
      if (removed > 0) v.baseFile = name;
      v.cutInfo = { removed: +removed.toFixed(1), minPause };
      if (oldBase && oldBase !== v.baseFile) trashFile(oldBase);
      checkCancel();
    }
    if (removeCut) {
      if (v.baseFile) { trashFile(v.baseFile); v.baseFile = null; }
      delete v.cutInfo;
    }
    const base = path.join(DIRS.out, v.baseFile || v.file);
    const { words: prevWords = [], enabled: _e, ...prevStyle } = prevCap;
    let words = captions ? [] : prevWords;
    if (needT) {
      pg.start(si++);
      words = await transcribeFile(base, language, (f) => pg.frac(f));
      checkCancel();
      if (!words.length) throw new Error("nenhuma fala detectada");
    }
    const dur = await duration(base);
    let texts = (remove?.texts ? [] : prev.texts || []).map((t) => (t.whole ? { ...t, end: dur } : t)); // texto "vídeo todo" acompanha a nova duração
    if (text && String(text.content || "").trim()) {
      const start = Math.max(0, +text.start || 0);
      texts = [{ ...text, text: String(text.content).trim(), start, end: Math.min(dur, Math.max(start + 0.5, +text.end || start + 3)), whole: (+text.end || 0) >= 900 }];
    }
    v.edit = { captions: { ...(captions || prevStyle), enabled: capOn, words: capOn ? words : [] }, texts };
  } catch (e) {
    v.cap = "error";
    v.capError = e.message;
    pg.end();
    save(db);
    return;
  }
  await renderVariation(v, pg, steps.length - 1);
  pg.end();
  save(db);
}

// ---------- baixar várias variações em um ZIP (sem compressão: mp4 já é comprimido; transmite sem carregar tudo na memória) ----------
const CRC_T = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crcUpdate = (crc, buf) => { let c = crc ^ 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_T[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const dosDateTime = (d) => [((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff, (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff];

async function streamZip(res, entries) {
  let offset = 0, aborted = false;
  res.on("close", () => { aborted = true; });
  const write = async (buf) => {
    if (aborted) throw new Error("download cancelado");
    offset += buf.length;
    if (!res.write(buf)) await new Promise((r) => res.once("drain", r));
  };
  const central = [];
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const [tm, dt] = dosDateTime(e.mtime);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0808, 6); // bit 3: tamanhos no fim; bit 11: nome em UTF-8
    lh.writeUInt16LE(0, 8); lh.writeUInt16LE(tm, 10); lh.writeUInt16LE(dt, 12);
    lh.writeUInt32LE(0, 14); lh.writeUInt32LE(0, 18); lh.writeUInt32LE(0, 22);
    lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const start = offset;
    await write(lh); await write(name);
    let crc = 0, size = 0;
    for await (const chunk of fs.createReadStream(e.path)) { crc = crcUpdate(crc, chunk); size += chunk.length; await write(chunk); }
    const dd = Buffer.alloc(16);
    dd.writeUInt32LE(0x08074b50, 0); dd.writeUInt32LE(crc, 4); dd.writeUInt32LE(size, 8); dd.writeUInt32LE(size, 12);
    await write(dd);
    central.push({ name, tm, dt, crc, size, start });
  }
  const cdStart = offset;
  for (const c of central) {
    const h = Buffer.alloc(46);
    h.writeUInt32LE(0x02014b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(20, 6); h.writeUInt16LE(0x0808, 8); h.writeUInt16LE(0, 10);
    h.writeUInt16LE(c.tm, 12); h.writeUInt16LE(c.dt, 14); h.writeUInt32LE(c.crc, 16); h.writeUInt32LE(c.size, 20); h.writeUInt32LE(c.size, 24);
    h.writeUInt16LE(c.name.length, 28); h.writeUInt32LE(c.start, 42);
    await write(h); await write(c.name);
  }
  const cdSize = offset - cdStart;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8); end.writeUInt16LE(central.length, 10);
  end.writeUInt32LE(cdSize, 12); end.writeUInt32LE(cdStart, 16);
  await write(end);
  res.end();
}

// GET /api/variations/download?ids=a,b,c  ->  .zip com as variações (a versão final de cada uma: legendada/cortada/original)
app.get("/api/variations/download", async (req, res) => {
  const ids = String(req.query.ids || "").split(",").filter(Boolean);
  const vs = ids.map((id) => db.variations.find((v) => v.id === id)).filter((v) => v && v.status === "ready" && v.cap !== "processing");
  if (!vs.length) return res.status(400).send("Nenhuma variação pronta para baixar.");
  const safe = (t) => String(t || "").replace(/\.[^.]+$/, "").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").trim().slice(0, 60) || "video";
  const used = new Map();
  const entries = [];
  let total = 0;
  for (const v of vs) {
    const file = path.join(DIRS.out, v.capFile || v.baseFile || v.file);
    if (!fs.existsSync(file)) continue;
    const bits = String(v.label || "").split(" + ");
    const nm = (id, i) => safe(db.clips.find((c) => c.id === id)?.name ?? bits[i]);
    let base = `${nm(v.hook, 0)} + ${nm(v.body, 1)} + ${nm(v.cta, 2)}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    if (n > 1) base += ` (${n})`;
    const st = fs.statSync(file);
    total += st.size;
    entries.push({ name: base + ".mp4", path: file, mtime: st.mtime, size: st.size });
  }
  if (!entries.length) return res.status(404).send("Arquivos não encontrados.");
  if (total > 3.8e9) return res.status(413).send("Os vídeos passam de 3,8 GB: selecione menos vídeos por vez.");
  const len = entries.reduce((a, e) => a + 30 + Buffer.byteLength(e.name) + e.size + 16 + 46 + Buffer.byteLength(e.name), 22);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  res.set({ "Content-Type": "application/zip", "Content-Length": String(len), "Content-Disposition": `attachment; filename="variacoes-${stamp}.zip"` });
  try { await streamZip(res, entries); } catch { res.destroy(); }
});

// Cancela edições na fila ou em andamento. ids: lista de ids, ou "all".
app.post("/api/variations/cancel", (req, res) => {
  const ids = req.body?.ids === "all" ? [...jobs.keys()].filter((id) => canVariation(req, id)) : Array.isArray(req.body?.ids) ? req.body.ids : [];
  let cancelled = 0;
  for (const id of ids) {
    const job = jobs.get(id);
    if (!job || job.cancelled) continue;
    job.cancelled = true;
    cancelled++;
    for (const p of job.procs) { try { p.kill("SIGKILL"); } catch {} }   // para o ffmpeg/whisper de verdade
    if (!job.started) {                                                   // ainda na fila: nada foi alterado, só limpa o estado
      const v = db.variations.find((x) => x.id === id);
      if (v) { v.cap = "idle"; delete v.prog; delete v.capError; }
      jobs.delete(id);
    }
  }
  save(db);
  res.json({ cancelled });
});

// Mede o volume de cada parte (com os trechos informados) e sugere o ganho para igualar
app.post("/api/variations/:id/loudness", async (req, res) => {
  const v = db.variations.find((x) => x.id === req.params.id);
  if (!v || v.status !== "ready") return res.sendStatus(404);
  try {
    const parts = normParts(req.body?.parts) || v.parts || defaultParts();
    res.json({ target: TARGET_LUFS, parts: await enqueueP(() => measureParts(v, parts)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Tira edições dos vídeos selecionados: what = ["captions", "texts", "cut", "parts"] (ou "all" = voltar ao original)
app.post("/api/variations/remove", (req, res) => {
  const { ids = [], what = [], language = "pt" } = req.body || {};
  const all = what.includes("all");
  const remove = { captions: all || what.includes("captions"), texts: all || what.includes("texts"), cut: all || what.includes("cut"), parts: all || what.includes("parts") };
  if (!remove.captions && !remove.texts && !remove.cut && !remove.parts) return res.status(400).json({ error: "Escolha o que remover." });
  const targets = db.variations.filter((v) => ids.includes(v.id) && v.status === "ready" && v.cap !== "processing");
  if (!targets.length) return res.status(400).json({ error: "Nenhuma variação pronta selecionada." });
  for (const v of targets) queueVariationJob(v, () => applyOps(v, { language, remove }));
  save(db);
  res.json({ queued: targets.length });
});

app.post("/api/variations/apply", (req, res) => {
  const { ids = [], language = "pt", captions = null, cut = null, text = null, parts = null, equalize = false } = req.body || {};
  const hasText = !!String(text?.content || "").trim();
  if (parts && !normParts(parts)) return res.status(400).json({ error: "Partes inválidas." });
  if (!captions && !cut && !hasText && !parts && !equalize) return res.status(400).json({ error: "Escolha ao menos uma opção: cortar pausas, legenda, texto na tela ou volume." });
  const targets = db.variations.filter((v) => ids.includes(v.id) && v.status === "ready" && v.cap !== "processing");
  if (!targets.length) return res.status(400).json({ error: "Nenhuma variação pronta selecionada." });
  for (const v of targets) {
    queueVariationJob(v, () => applyOps(v, { language, captions, cut, text: hasText ? text : null, parts, equalize: !!equalize }));
  }
  save(db);
  res.json({ queued: targets.length });
});

// legenda várias variações de uma vez: (opcional) corta pausas, transcreve, aplica legenda + texto
app.post("/api/captions/batch", (req, res) => {
  const { ids = [], language = "pt", captions = {}, cut = null, text = null, withCaptions = true } = req.body || {};
  const targets = db.variations.filter((v) => ids.includes(v.id) && v.status === "ready" && v.cap !== "processing");
  if (!targets.length) return res.status(400).json({ error: "Nenhuma variação pronta selecionada." });
  for (const v of targets) {
    queueVariationJob(v, () => captionJob(v, { language, captions, cut, text, withCaptions: withCaptions !== false }));
  }
  save(db);
  res.json({ queued: targets.length });
});

// ---------- referências ----------
app.use("/media/refs", express.static(DIRS.refs));

app.post("/api/refs", upload.array("files"), (req, res) => {
  const created = req.files.map((f) => {
    const ref = {
      id: crypto.randomUUID(),
      name: Buffer.from(f.originalname, "latin1").toString("utf8"),
      status: "processing",
    };
    db.refs.push(ref);
    enqueue(() => analyzeRef(ref, f.path));
    return ref;
  });
  save(db);
  res.json(created);
});

app.post("/api/refs/:id/read-text", async (req, res) => {
  const ref = db.refs.find((r) => r.id === req.params.id && r.status === "ready");
  if (!ref) return res.sendStatus(404);
  try {
    res.json({ text: await enqueueP(() => readRefText(ref)) });
  } catch (e) {
    res.status(500).json({ error: "Não foi possível ler o texto: " + e.message });
  }
});

app.put("/api/defaults", (req, res) => {
  const c = req.body?.captions || {};
  const cur = db.defaults.captions;
  const n = (v, a, b, d) => Math.min(b, Math.max(a, Number.isFinite(+v) ? +v : d));
  db.defaults.captions = {
    preset: ["destaque", "classica", "caixa"].includes(c.preset) ? c.preset : cur.preset,
    font: FONTS.includes(c.font) ? c.font : cur.font,
    size: n(c.size, 30, 200, cur.size),
    yPct: n(c.yPct, 5, 95, cur.yPct),
    color: /^#[0-9a-f]{6}$/i.test(c.color || "") ? c.color : cur.color,
    wordsPerLine: Math.round(n(c.wordsPerLine, 1, 8, cur.wordsPerLine)),
    upper: c.upper === undefined ? cur.upper : !!c.upper,
  };
  save(db);
  res.json(db.defaults);
});

app.put("/api/refs/:id/style", (req, res) => {
  const ref = db.refs.find((r) => r.id === req.params.id);
  if (!ref) return res.sendStatus(404);
  ref.style = req.body;
  save(db);
  res.json(ref);
});

app.put("/api/refs/:id/name", (req, res) => {
  const ref = db.refs.find((r) => r.id === req.params.id);
  const name = String(req.body?.name || "").trim().slice(0, 120);
  if (!ref || !name) return res.sendStatus(400);
  ref.name = name;
  save(db);
  res.json(ref);
});

app.delete("/api/refs/:id", (req, res) => {
  const ref = db.refs.find((r) => r.id === req.params.id);
  if (!ref) return res.sendStatus(404);
  fs.rmSync(path.join(DIRS.refs, ref.id), { recursive: true, force: true });
  db.refs = db.refs.filter((r) => r !== ref);
  save(db);
  res.sendStatus(204);
});

// gera todas as combinações gancho x corpo x cta (só entre os clipes prontos)
app.post("/api/generate", (req, res) => {
  const ref = db.refs.find((r) => r.id === req.body?.refId && r.status === "ready");
  const language = req.body?.language || "pt";
  const quickCut = req.body?.cut?.enabled ? req.body.cut : null; // opção "cortar respiração" do topo
  const pid = req.body?.project;
  if (!db.projects.some((p) => p.id === pid)) return res.status(400).json({ error: "Projeto não encontrado." });
  const mine = db.clips.filter((c) => c.project === pid);
  const by = (t) => mine.filter((c) => c.type === t && c.status === "ready");
  const [hs, bs, cs] = TYPES.map(by);
  if (mine.some((c) => c.status === "ready" && (!c.reviewed || needsRender(c) || c.prog)))
    return res.status(400).json({ error: "Termine o tratamento dos vídeos (corte e equalização) antes de gerar as variações." });
  if (!hs.length || !bs.length || !cs.length)
    return res.status(400).json({ error: "Precisa de ao menos 1 gancho, 1 corpo e 1 CTA prontos." });

  let created = 0;
  for (const h of hs) for (const b of bs) for (const c of cs) {
    if (db.variations.some((v) => v.hook === h.id && v.body === b.id && v.cta === c.id && v.status !== "error")) continue;
    const v = {
      id: crypto.randomUUID(), project: pid, hook: h.id, body: b.id, cta: c.id,
      label: `${h.name} + ${b.name} + ${c.name}`,
      file: null, status: "queued",
      ...(ref || quickCut ? { cap: "processing" } : {}),
    };
    db.variations.push(v);
    created++;
    enqueue(async () => {
      v.status = "processing";
      save(db);
      try {
        const file = `v${String(Date.now()).slice(-6)}-${v.id.slice(0, 4)}.mp4`;
        await concat([h, b, c].map((x) => path.join(DIRS.clips, clipFile(x))), path.join(DIRS.out, file));
        v.file = file;
        v.status = "ready";
      } catch (e) {
        v.status = "error";
        v.error = e.message;
        delete v.cap;
      }
      save(db);
      // já sai no estilo da referência escolhida
      if (v.status === "ready" && ref) {
        await captionJob(v, { language, captions: ref.style?.captions, cut: quickCut || ref.style?.cut, text: ref.style?.text });
      } else if (v.status === "ready" && quickCut) {
        await captionJob(v, { cut: quickCut, withCaptions: false }); // só corta as pausas
      }
    });
  }
  save(db);
  res.json({ created });
});

app.delete("/api/variations/:id", (req, res) => {
  const v = db.variations.find((x) => x.id === req.params.id);
  if (!v) return res.sendStatus(404);
  if (v.file) fs.rmSync(path.join(DIRS.out, v.file), { force: true });
  if (v.capFile) fs.rmSync(path.join(DIRS.out, v.capFile), { force: true });
  if (v.baseFile) fs.rmSync(path.join(DIRS.out, v.baseFile), { force: true });
  db.variations = db.variations.filter((x) => x !== v);
  save(db);
  res.sendStatus(204);
});

const PORT = process.env.PORT || 3456;
app.listen(PORT, () => console.log(`Painel: http://localhost:${PORT}`));
