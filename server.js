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
import { buildAss, FONTS_DIR } from "./edit.js";

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
// jobs que ficaram "processing" de uma execução anterior viram erro
db.clips.forEach((c) => c.status === "processing" && (c.status = "error", c.error = "interrompido"));
db.refs.forEach((r) => r.status === "processing" && (r.status = "error", r.error = "interrompido"));
db.variations.forEach((v) => v.cap === "processing" && (v.cap = "error", v.capError = "interrompido"));
db.variations.forEach((v) => (v.status === "processing" || v.status === "queued") && (v.status = "error", v.error = "interrompido"));
save(db);

// ---------- ffmpeg ----------
function run(bin, args) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
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
    const p = spawn(bin, args);
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => resolve({ code, err }));
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
async function normalize(input, output) {
  const audio = await hasAudio(input);
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
  await run(ffmpegPath, args);
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
const MAX_CUT = 3.5; // silêncios maiores que isso provavelmente são trechos sem fala de propósito: mantém

async function cutPauses(src, out, { minPause = 0.4, keep = 0.1 } = {}) {
  minPause = Math.min(3, Math.max(0.2, +minPause || 0.4));
  keep = Math.min(0.5, Math.max(0, +keep || 0));
  const total = await duration(src);
  const r = await runAll(ffmpegPath, ["-i", src, "-af", `silencedetect=noise=-32dB:d=${minPause}`, "-f", "null", "-"]);
  const starts = [...r.err.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => +m[1]);
  const ends = [...r.err.matchAll(/silence_end: ([\d.]+)/g)].map((m) => +m[1]);
  const cuts = [];
  starts.forEach((st, i) => {
    const en = ends[i] ?? total;
    const len = en - st;
    if (len >= minPause && len <= MAX_CUT) {
      const a = Math.max(0, st) + keep, b = en - keep;
      if (b - a > 0.05) cuts.push([a, b]);
    }
  });
  if (!cuts.length) return false;
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
    await run(ffmpegPath, [
      "-y", "-i", src, "-filter_complex_script", script, "-map", "[v]", "-map", "[a]",
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "18", "-r", String(FPS), "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-b:a", "160k", "-ar", "44100", "-movflags", "+faststart", out,
    ]);
  } finally {
    fs.rmSync(script, { force: true });
  }
  return true;
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
      captions: { preset: "destaque", font: "Anton", size: 84, yPct: 72, color: "#FFE600", wordsPerLine: 3, upper: true },
      cut: { enabled: longPauses === 0 && dur > 5, minPause: 0.4, keep: 0.1 },
      text: { anim: "pop", font: "Anton", color: "#FFFFFF", size: 96, yPct: 25, start: 0, end: 3, box: false, boxColor: "#000000" },
    };
    ref.status = "ready";
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

async function transcribeFile(videoPath, lang = "pt") {
  lang = String(lang).replace(/[^a-z-]/gi, "") || "pt";
  const wav = path.join(DIRS.tmp, crypto.randomUUID() + ".wav");
  try {
    await run(ffmpegPath, ["-y", "-i", videoPath, "-vn", "-ar", "16000", "-ac", "1", wav]);
    let out;
    if (WHISPER_BIN) {
      if (!fs.existsSync(WHISPER_MODEL_PATH)) throw new Error("Modelo Whisper ainda não foi baixado: " + WHISPER_MODEL_PATH);
      out = await run(WHISPER_BIN, [
        "-m", WHISPER_MODEL_PATH, "-f", wav, "-l", lang, "-ml", "1", "-sow", "-np",
        "-t", String(Math.min(8, os.cpus().length)),
      ]);
    } else {
      const model = fs.existsSync(VIBE_CONFIG) ? JSON.parse(fs.readFileSync(VIBE_CONFIG, "utf8"))["model.path"] : null;
      if (!model || !fs.existsSync(model) || !fs.existsSync(VIBE))
        throw new Error("Transcrição não configurada: defina WHISPER_BIN (whisper.cpp) ou instale o Vibe.");
      out = await run(VIBE, [
        "transcribe", model, wav, "--word-timestamps", "--max-segment-len", "1",
        ...(lang === "auto" ? ["--detect-language"] : ["-l", lang]),
      ]);
    }
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
async function renderVariation(v) {
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
      await new Promise((resolve, reject) => {
        const pr = spawn(ffmpegPath, [
          "-y", "-i", path.join(DIRS.out, v.baseFile || v.file),
          "-vf", `ass=${assName}:fontsdir=${FONTS_DIR}`,
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "19", "-r", String(FPS), "-pix_fmt", "yuv420p",
          "-c:a", "copy", "-movflags", "+faststart", path.join(DIRS.out, outName),
        ], { cwd: DIRS.tmp });
        let err = "";
        pr.stderr.on("data", (d) => (err += d));
        pr.on("error", reject);
        pr.on("close", (code) => (code === 0 ? resolve() : reject(new Error(err.split("\n").slice(-6).join("\n")))));
      });
      fs.rmSync(path.join(DIRS.tmp, assName), { force: true });
      if (old) fs.rmSync(path.join(DIRS.out, old), { force: true });
      v.capFile = outName;
    }
    v.cap = "idle";
  } catch (e) {
    v.cap = "error";
    v.capError = e.message;
  }
  save(db);
}

// ---------- API ----------
const app = express();
// senha de acesso (defina APP_PASSWORD no servidor; sem ela o painel fica aberto)
if (process.env.APP_PASSWORD) {
  const user = process.env.APP_USER || "admin";
  const expected = "Basic " + Buffer.from(`${user}:${process.env.APP_PASSWORD}`).toString("base64");
  app.use((req, res, next) => {
    const got = req.headers.authorization || "";
    if (got.length === expected.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(expected))) return next();
    res.set("WWW-Authenticate", 'Basic realm="Variacoes de Criativo"').status(401).send("Acesso restrito");
  });
}
app.use(express.json({ limit: "5mb" }));
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

app.get("/api/state", (_, res) => res.json(db));

app.post("/api/clips/:type", upload.array("files"), (req, res) => {
  const { type } = req.params;
  if (!TYPES.includes(type)) return res.status(400).json({ error: "tipo inválido" });
  const created = req.files.map((f) => {
    const id = crypto.randomUUID();
    const clip = {
      id, type,
      name: Buffer.from(f.originalname, "latin1").toString("utf8"),
      file: id + ".mp4",
      status: "processing",
    };
    db.clips.push(clip);
    enqueue(async () => {
      try {
        await normalize(f.path, path.join(DIRS.clips, clip.file));
        clip.duration = await duration(path.join(DIRS.clips, clip.file));
        clip.status = "ready";
      } catch (e) {
        clip.status = "error";
        clip.error = e.message;
      } finally {
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
  db.clips = db.clips.filter((c) => c !== clip);
  save(db);
  res.sendStatus(204);
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
  v.edit = req.body || {};
  v.cap = "processing";
  save(db);
  enqueue(() => renderVariation(v));
  res.json(v);
});

// corta pausas (opcional) -> transcreve -> aplica legenda + texto
async function captionJob(v, { language = "pt", captions = {}, cut = null, text = null } = {}) {
  v.cap = "processing";
  save(db);
  try {
    let base = v.file;
    const oldBase = v.baseFile;
    v.baseFile = null;
    if (cut?.enabled) {
      const name = `cut-${Date.now()}-${v.id.slice(0, 4)}.mp4`;
      if (await cutPauses(path.join(DIRS.out, v.file), path.join(DIRS.out, name), cut)) {
        v.baseFile = name;
        base = name;
      }
    }
    if (oldBase && oldBase !== v.baseFile) fs.rmSync(path.join(DIRS.out, oldBase), { force: true });
    const words = await transcribeFile(path.join(DIRS.out, base), language);
    if (!words.length) throw new Error("nenhuma fala detectada");
    const texts = [];
    if (String(text?.content || "").trim()) {
      const dur = await duration(path.join(DIRS.out, base));
      const start = Math.max(0, +text.start || 0);
      texts.push({ ...text, text: String(text.content).trim(), start, end: Math.min(dur, Math.max(start + 0.5, +text.end || start + 3)) });
    }
    v.edit = { captions: { ...captions, enabled: true, words }, texts };
  } catch (e) {
    v.cap = "error";
    v.capError = e.message;
    save(db);
    return;
  }
  await renderVariation(v);
}

// legenda várias variações de uma vez: (opcional) corta pausas, transcreve, aplica legenda + texto
app.post("/api/captions/batch", (req, res) => {
  const { ids = [], language = "pt", captions = {}, cut = null, text = null } = req.body || {};
  const targets = db.variations.filter((v) => ids.includes(v.id) && v.status === "ready" && v.cap !== "processing");
  if (!targets.length) return res.status(400).json({ error: "Nenhuma variação pronta selecionada." });
  for (const v of targets) {
    v.cap = "processing";
    enqueue(() => captionJob(v, { language, captions, cut, text }));
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

app.put("/api/refs/:id/style", (req, res) => {
  const ref = db.refs.find((r) => r.id === req.params.id);
  if (!ref) return res.sendStatus(404);
  ref.style = req.body;
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
  const by = (t) => db.clips.filter((c) => c.type === t && c.status === "ready");
  const [hs, bs, cs] = TYPES.map(by);
  if (!hs.length || !bs.length || !cs.length)
    return res.status(400).json({ error: "Precisa de ao menos 1 gancho, 1 corpo e 1 CTA prontos." });

  let created = 0;
  for (const h of hs) for (const b of bs) for (const c of cs) {
    if (db.variations.some((v) => v.hook === h.id && v.body === b.id && v.cta === c.id && v.status !== "error")) continue;
    const v = {
      id: crypto.randomUUID(), hook: h.id, body: b.id, cta: c.id,
      label: `${h.name} + ${b.name} + ${c.name}`,
      file: null, status: "queued",
      ...(ref ? { cap: "processing" } : {}),
    };
    db.variations.push(v);
    created++;
    enqueue(async () => {
      v.status = "processing";
      save(db);
      try {
        const file = `v${String(Date.now()).slice(-6)}-${v.id.slice(0, 4)}.mp4`;
        await concat([h, b, c].map((x) => path.join(DIRS.clips, x.file)), path.join(DIRS.out, file));
        v.file = file;
        v.status = "ready";
      } catch (e) {
        v.status = "error";
        v.error = e.message;
        delete v.cap;
      }
      save(db);
      // já sai no estilo da referência escolhida
      if (ref && v.status === "ready") {
        const { content, ...txt } = ref.style?.text || {};
        await captionJob(v, { language, captions: ref.style?.captions, cut: ref.style?.cut, text: null });
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
