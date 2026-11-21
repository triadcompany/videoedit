// Login por e-mail e senha com sessão em cookie.
// As credenciais NÃO ficam no código: vêm das variáveis de ambiente do servidor.
//   APP_EMAIL     e-mail de acesso            (se faltar, usa APP_USER, e por fim "admin")
//   APP_PASSWORD  senha de acesso             (sem ela o sistema fica aberto, sem login)
//   SESSION_DAYS  quantos dias o login vale   (padrão 30)
//   SESSION_SECRET (opcional) segredo extra para assinar as sessões
import crypto from "node:crypto";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const COOKIE = "vc_session";
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // compara em tempo constante
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

export function setupAuth(app) {
  const PASS = process.env.APP_PASSWORD || "";
  const USER = (process.env.APP_EMAIL || process.env.APP_USER || "admin").trim();
  const DAYS = Math.max(0.00001, +process.env.SESSION_DAYS || 30);
  const enabled = !!PASS;

  app.set("trust proxy", true); // atrás do proxy do EasyPanel: IP real e https
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" });
    next();
  });

  // A chave das sessões deriva do e-mail + senha: trocar a senha derruba todas as sessões antigas.
  const key = crypto.createHash("sha256").update(`session|${USER}|${PASS}|${process.env.SESSION_SECRET || ""}`).digest();
  const revoked = new Set(); // sessões encerradas pelo "Sair"
  const sign = (payload) => {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    return `${body}.${crypto.createHmac("sha256", key).update(body).digest("base64url")}`;
  };
  function verify(token) {
    if (!token) return null;
    const [body, mac] = token.split(".");
    if (!body || !mac || revoked.has(mac)) return null;
    const want = crypto.createHmac("sha256", key).update(body).digest("base64url");
    const a = Buffer.from(mac), b = Buffer.from(want);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    try {
      const p = JSON.parse(Buffer.from(body, "base64url").toString());
      return p.e && p.e > Date.now() ? p : null;
    } catch { return null; }
  }
  const session = (req) => verify(parseCookies(req.headers.cookie)[COOKIE]);
  const cookie = (req, value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? "; Secure" : ""}`;

  // limite de tentativas erradas por IP: 5 a cada 15 minutos
  const fails = new Map();
  const WINDOW = 15 * 60 * 1000, MAX = 5;
  const wait = (ip) => {
    const f = fails.get(ip);
    if (!f || Date.now() - f.t > WINDOW) { fails.delete(ip); return 0; }
    return f.n >= MAX ? Math.ceil((f.t + WINDOW - Date.now()) / 1000) : 0;
  };
  const fail = (ip) => {
    const f = fails.get(ip);
    if (!f || Date.now() - f.t > WINDOW) fails.set(ip, { n: 1, t: Date.now() }); else f.n++;
    if (fails.size > 5000) for (const [k, v] of fails) if (Date.now() - v.t > WINDOW) fails.delete(k);
  };

  const OPEN = new Set(["/login", "/login.html", "/api/login"]);
  app.use((req, res, next) => {
    if (!enabled || OPEN.has(req.path)) return next();
    const s = session(req);
    if (s) { req.user = s.u; return next(); }
    if (req.path.startsWith("/api/") || req.path.startsWith("/media/"))
      return res.status(401).json({ error: "Faça login para continuar." });
    const back = req.originalUrl === "/" || req.originalUrl.startsWith("/index.html") ? "" : "?next=" + encodeURIComponent(req.originalUrl);
    res.redirect(302, "/login" + back); // o navegador mantém o #endereço do projeto no redirecionamento
  });

  app.get("/login", (req, res) => {
    if (!enabled || session(req)) return res.redirect(302, "/");
    res.set("Cache-Control", "no-store").sendFile(path.join(__dirname, "public", "login.html"));
  });

  app.post("/api/login", express.json({ limit: "10kb" }), async (req, res) => {
    if (!enabled) return res.json({ ok: true });
    const w = wait(req.ip);
    if (w) return res.status(429).set("Retry-After", String(w)).json({ error: `Muitas tentativas erradas. Tente de novo em ${Math.ceil(w / 60)} min.` });
    const email = String(req.body?.email || "").trim().toLowerCase();
    const pass = String(req.body?.password || "");
    const okUser = safeEq(email, USER.toLowerCase());
    const okPass = safeEq(pass, PASS); // sempre compara os dois: não revela qual está errado
    if (!(okUser && okPass)) {
      fail(req.ip);
      await sleep(400);
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }
    fails.delete(req.ip);
    res.set("Set-Cookie", cookie(req, sign({ u: USER, e: Date.now() + DAYS * 86400000, n: crypto.randomBytes(8).toString("hex") }), Math.round(DAYS * 86400)));
    res.set("Cache-Control", "no-store").json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (tok) revoked.add(tok.split(".")[1]);
    res.set("Set-Cookie", cookie(req, "", 0)).json({ ok: true });
  });

  app.get("/api/me", (req, res) => res.set("Cache-Control", "no-store").json({ auth: enabled, email: enabled ? USER : null }));

  if (!enabled) console.warn("[login] APP_PASSWORD não definida: o sistema está ABERTO (sem login). Defina APP_EMAIL e APP_PASSWORD.");
  else console.log(`[login] ativo para ${USER}`);
}
