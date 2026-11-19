// Gera um arquivo ASS (legendas estilizadas) a partir das edições de um clipe.
// Tudo é desenhado em um canvas virtual de 1080x1920.
export const W = 1080;
export const H = 1920;
import path from "node:path";
import { fileURLToPath } from "node:url";
// fontes livres que vão junto com o projeto: o resultado é igual em qualquer computador/servidor
export const FONTS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fonts");
export const FONTS = ["Poppins Light", "Poppins Regular", "Poppins Medium", "Poppins SemiBold", "Poppins Bold", "Montserrat Light", "Montserrat Regular", "Montserrat Medium", "Montserrat SemiBold", "Montserrat Bold", "Poppins ExtraBold", "Anton", "Bebas Neue", "Archivo Black", "Bangers"];
// nomes antigos (estilos já salvos) -> equivalentes novos
const LEGACY = { Impact: "Anton", "Arial Black": "Archivo Black", "Trebuchet MS": "Poppins ExtraBold", Georgia: "Poppins ExtraBold", Verdana: "Poppins ExtraBold" };

const clamp = (n, a, b) => Math.min(b, Math.max(a, Number(n) || 0));

// "#RRGGBB" -> "&H00BBGGRR"
function ass(hex, alpha = 0) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || "");
  const [r, g, b] = m ? [0, 2, 4].map((i) => m[1].slice(i, i + 2)) : ["ff", "ff", "ff"];
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}${b}${g}${r}`.toUpperCase();
}

function time(sec) {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec - h * 3600 - m * 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

const esc = (t) =>
  String(t ?? "").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");

function fontName(f) {
  f = LEGACY[f] || f;
  return FONTS.includes(f) ? f : "Anton";
}

// Agrupa palavras em "linhas" de N palavras (quebra também após . ? !)
export function groupWords(words, perLine) {
  const groups = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= perLine || /[.?!…]$/.test(w.t)) {
      groups.push(cur);
      cur = [];
    }
  }
  if (cur.length) groups.push(cur);
  return groups;
}

const PRESETS = {
  destaque: { box: false, outline: 7, shadow: 2, bold: 0 },
  classica: { box: false, outline: 5, shadow: 1, bold: 0 },
  caixa: { box: true, outline: 18, shadow: 0, bold: 0 },
};

function styleLine(name, { font, size, primary, outline, back, box, outlineW, shadow, bold }) {
  const border = box ? 3 : 1;
  return [
    "Style: " + name, fontName(font), Math.round(size), primary, primary, outline, back,
    bold ? -1 : 0, 0, 0, 0, 100, 100, 0, 0, border, outlineW, shadow, 5, 70, 70, 0, 1,
  ].join(",");
}

export function buildAss(edit) {
  const lines = [];
  const styles = [];
  const events = [];

  // ---------- legendas automáticas ----------
  const c = edit?.captions;
  if (c?.enabled && c.words?.length) {
    const p = PRESETS[c.preset] || PRESETS.destaque;
    const size = clamp(c.size ?? 84, 30, 200);
    const y = Math.round((clamp(c.yPct ?? 72, 5, 95) / 100) * H);
    const hl = ass(c.color || "#FFE600");
    const base = ass("#FFFFFF");
    styles.push(
      styleLine("Cap", {
        font: c.font, size, primary: base,
        outline: p.box ? ass("#000000", 0x30) : ass("#000000"),
        back: ass("#000000", 0x80), box: p.box, outlineW: p.outline, shadow: p.shadow, bold: p.bold,
      })
    );
    const up = (t) => (c.upper === false ? t : t.toUpperCase());
    const perLine = Math.round(clamp(c.wordsPerLine ?? 3, 1, 8));
    // Linha do tempo sem sobreposição: o Whisper às vezes devolve palavras com tempos que se cruzam,
    // e cada frase ainda fica um instante após a última palavra. Aqui garantimos que só uma frase
    // aparece por vez: a frase atual sai exatamente quando a próxima entra.
    const words = c.words
      .filter((w) => w && String(w.t).trim())
      .map((w) => ({ s: +w.s, e: +w.e, t: String(w.t).trim() }))
      .sort((x, y) => x.s - y.s);
    let lastS = 0;
    for (const w of words) {
      w.s = Math.max(w.s, lastS);            // nunca começa antes da palavra anterior
      w.e = Math.max(w.e, w.s + 0.05);
      lastS = w.s;
    }
    const groups = groupWords(words, perLine);
    groups.forEach((group, gi) => {
      const nextStart = groups[gi + 1] ? groups[gi + 1][0].s : Infinity;
      group.forEach((cur, i) => {
        const start = cur.s;
        let end = i < group.length - 1 ? group[i + 1].s : cur.e + 0.12;
        end = Math.min(end, nextStart);       // corta na entrada da próxima frase
        if (end - start < 0.03) return;       // palavra instantânea: a vizinha já cobre
        const text = group
          .map((w, j) => {
            const t = esc(up(w.t));
            if (c.preset === "destaque" && j === i)
              return `{\\c${hl}\\fscx112\\fscy112}${t}{\\c${base}\\fscx100\\fscy100}`;
            return t;
          })
          .join(" ");
        events.push(
          `Dialogue: 0,${time(start)},${time(end)},Cap,,0,0,0,,{\\an5\\pos(${W / 2},${y})}${text}`
        );
      });
    });
  }

  // ---------- textos / efeitos ----------
  (edit?.texts || []).forEach((t, idx) => {
    if (!String(t.text || "").trim()) return;
    const name = "T" + idx;
    const size = clamp(t.size ?? 90, 24, 240);
    const y = Math.round((clamp(t.yPct ?? 30, 3, 97) / 100) * H);
    const box = !!t.box;
    styles.push(
      styleLine(name, {
        font: t.font, size, primary: ass(t.color || "#FFFFFF"),
        outline: box ? ass(t.boxColor || "#000000", 0x10) : ass("#000000"),
        back: ass("#000000", 0x80), box, outlineW: box ? 22 : 7, shadow: box ? 0 : 2, bold: 0,
      })
    );
    const start = clamp(t.start ?? 0, 0, 3600);
    const end = Math.max(start + 0.2, clamp(t.end ?? start + 2, 0, 3600));
    const pos = `\\an5\\pos(${W / 2},${y})`;
    const anim = t.anim || "pop";
    const text = esc(t.text);

    if (anim === "words") {
      const ws = String(t.text).trim().split(/\s+/);
      const step = Math.min(0.35, ((end - start) * 0.6) / ws.length);
      ws.forEach((_, k) => {
        const shown = esc(ws.slice(0, k + 1).join(" "));
        const rest = ws.slice(k + 1).join(" ");
        const hidden = rest ? ` {\\alpha&HFF&\\3a&HFF&\\4a&HFF&}${esc(rest)}` : "";
        const s = start + k * step;
        const e = k === ws.length - 1 ? end : start + (k + 1) * step;
        events.push(`Dialogue: 1,${time(s)},${time(e)},${name},,0,0,0,,{${pos}}${shown}${hidden}`);
      });
      return;
    }

    let fx = "";
    if (anim === "fade") fx = "\\fad(250,250)";
    else if (anim === "pop")
      fx = "\\fad(60,150)\\fscx50\\fscy50\\t(0,140,\\fscx115\\fscy115)\\t(140,260,\\fscx100\\fscy100)";
    else if (anim === "slide")
      fx = "\\fad(120,200)";
    const move =
      anim === "slide"
        ? `\\an5\\move(${W / 2},${y + 90},${W / 2},${y},0,280)`
        : pos;
    events.push(`Dialogue: 1,${time(start)},${time(end)},${name},,0,0,0,,{${move}${fx}}${text}`);
  });

  if (!events.length) return null;

  lines.push(
    "[Script Info]", "ScriptType: v4.00+", `PlayResX: ${W}`, `PlayResY: ${H}`, "WrapStyle: 0", "ScaledBorderAndShadow: yes", "",
    "[V4+ Styles]",
    "Format: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding",
    ...styles, "",
    "[Events]",
    "Format: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text",
    ...events, ""
  );
  return lines.join("\n");
}
