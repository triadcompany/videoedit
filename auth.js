// Login com várias contas.
//   Administrador: definido nas variáveis de ambiente do servidor (nada de senha no código)
//     APP_EMAIL     e-mail do administrador   (se faltar, usa APP_USER, e por fim "admin")
//     APP_PASSWORD  senha do administrador    (sem ela o sistema fica aberto, sem login)
//   Membros: entram por convite (link de uso único) e criam a própria senha. Ficam em <dados>/users.json,
//     com a senha guardada só como hash (scrypt).
//   SESSION_DAYS (padrão 30) · INVITE_DAYS (padrão 7) · SESSION_SECRET (opcional)
import crypto from "node:crypto";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scrypt = promisify(crypto.scrypt);
const COOKIE = "vc_session";
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(sha(a), sha(b)); // compara em tempo constante
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

async function hashPw(pw) {
  const salt = crypto.randomBytes(16);
  return `${salt.toString("base64")}:${(await scrypt(pw, salt, 64)).toString("base64")}`;
}
async function checkPw(pw, stored) {
  const [s, h] = String(stored).split(":");
  const calc = await scrypt(pw, Buffer.from(s, "base64"), 64);
  const want = Buffer.from(h, "base64");
  return calc.length === want.length && crypto.timingSafeEqual(calc, want);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

export function setupAuth(app, ctx = {}) {
  const PASS = process.env.APP_PASSWORD || "";
  const USER = (process.env.APP_EMAIL || process.env.APP_USER || "admin").trim();
  const DAYS = Math.max(0.00001, +process.env.SESSION_DAYS || 30);
  const INVITE_DAYS = Math.max(0.00001, +process.env.INVITE_DAYS || 7);
  const enabled = !!PASS;
  const ADMIN = { id: "admin", email: USER, role: "admin" };

  // ---------- contas e convites (arquivo no volume de dados) ----------
  const FILE = path.join(ctx.dataDir || ".", "users.json");
  let store = { users: [], invites: [] };
  try { store = { users: [], invites: [], ...JSON.parse(fs.readFileSync(FILE, "utf8")) }; } catch {}
  const saveStore = () => { fs.writeFileSync(FILE + ".tmp", JSON.stringify(store, null, 2)); fs.renameSync(FILE + ".tmp", FILE); };
  const findUser = (id) => id === "admin" ? ADMIN : store.users.find((u) => u.id === id) && { ...store.users.find((u) => u.id === id), role: "member" };
  const emailTaken = (e) => e === USER.toLowerCase() || store.users.some((u) => u.email === e);

  app.set("trust proxy", true); // atrás do proxy do EasyPanel: IP real e https
  app.use((_req, res, next) => {
    res.set({ "X-Content-Type-Options": "nosniff", "Referrer-Policy": "same-origin", "X-Frame-Options": "SAMEORIGIN" });
    next();
  });

  // A chave das sessões deriva do e-mail + senha do administrador: trocar a senha dele derruba todas as sessões.
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
  // quem é a pessoa logada (a conta precisa continuar existindo: remover um membro derruba o acesso dele na hora)
  const session = (req) => {
    const p = verify(parseCookies(req.headers.cookie)[COOKIE]);
    const u = p && findUser(p.u);
    return u ? { id: u.id, email: u.email, role: u.role } : null;
  };
  const cookie = (req, value, maxAge) =>
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${req.secure ? "; Secure" : ""}`;
  const startSession = (req, res, user) =>
    res.set("Set-Cookie", cookie(req, sign({ u: user.id, e: Date.now() + DAYS * 86400000, n: crypto.randomBytes(8).toString("hex") }), Math.round(DAYS * 86400)));

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

  // ---------- porta de entrada ----------
  const isOpenPath = (p) => p === "/login" || p === "/login.html" || p === "/api/login" || p === "/convite.html" || p.startsWith("/convite/") || p.startsWith("/api/invite/");
  app.use((req, res, next) => {
    if (!enabled) { req.user = { id: "admin", email: null, role: "admin" }; return next(); } // sem senha configurada: tudo aberto
    const s = session(req);
    if (s) req.user = s;
    if (s || isOpenPath(req.path)) return next();
    if (req.path.startsWith("/api/") || req.path.startsWith("/media/"))
      return res.status(401).json({ error: "Faça login para continuar." });
    const back = req.originalUrl === "/" || req.originalUrl.startsWith("/index.html") ? "" : "?next=" + encodeURIComponent(req.originalUrl);
    res.redirect(302, "/login" + back); // o navegador mantém o #endereço do projeto no redirecionamento
  });

  const adminOnly = (req, res, next) => (req.user?.role === "admin" ? next() : res.status(403).json({ error: "Só o administrador pode fazer isso." }));

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
    let user = null;
    if (email === USER.toLowerCase()) {
      if (safeEq(pass, PASS)) user = ADMIN;
    } else {
      const m = store.users.find((u) => u.email === email);
      // e-mail desconhecido também gasta o mesmo tempo (não dá para descobrir quem tem conta pelo tempo da resposta)
      const okPw = await checkPw(pass, m ? m.pass : "AAAAAAAAAAAAAAAAAAAAAA==:" + Buffer.alloc(64).toString("base64"));
      if (m && okPw) user = findUser(m.id);
    }
    if (!user) {
      fail(req.ip);
      await sleep(400);
      return res.status(401).json({ error: "E-mail ou senha incorretos." });
    }
    fails.delete(req.ip);
    startSession(req, res, user).set("Cache-Control", "no-store").json({ ok: true });
  });

  app.post("/api/logout", (req, res) => {
    const tok = parseCookies(req.headers.cookie)[COOKIE];
    if (tok) revoked.add(tok.split(".")[1]);
    res.set("Set-Cookie", cookie(req, "", 0)).json({ ok: true });
  });

  app.get("/api/me", (req, res) =>
    res.set("Cache-Control", "no-store").json({ auth: enabled, id: req.user?.id, email: enabled ? req.user?.email : null, role: req.user?.role || "admin" }));

  // trocar a própria senha (o administrador troca nas variáveis do servidor)
  app.post("/api/me/password", express.json({ limit: "10kb" }), async (req, res) => {
    if (!enabled || req.user.role === "admin") return res.status(400).json({ error: "A senha do administrador é definida no servidor (variável APP_PASSWORD)." });
    const u = store.users.find((x) => x.id === req.user.id);
    const next = String(req.body?.next || "");
    if (!u || !(await checkPw(String(req.body?.current || ""), u.pass))) { await sleep(400); return res.status(400).json({ error: "A senha atual está incorreta." }); }
    if (next.length < 8) return res.status(400).json({ error: "A nova senha precisa ter pelo menos 8 caracteres." });
    u.pass = await hashPw(next);
    saveStore();
    res.json({ ok: true });
  });

  // ---------- administração de acessos ----------
  app.get("/api/users", adminOnly, (_req, res) => {
    const now = Date.now();
    res.json({
      admin: { email: USER },
      users: store.users.map((u) => ({ id: u.id, email: u.email, createdAt: u.createdAt, projects: ctx.projectCount?.(u.id) ?? 0 })),
      invites: store.invites.filter((i) => !i.usedAt).map((i) => ({ id: i.id, email: i.email, createdAt: i.createdAt, expiresAt: i.expiresAt, expired: i.expiresAt < now })),
    });
  });

  app.post("/api/users/invite", adminOnly, express.json({ limit: "10kb" }), (req, res) => {
    const email = String(req.body?.email || "").trim().toLowerCase();
    if (email && !EMAIL_RE.test(email)) return res.status(400).json({ error: "E-mail inválido." });
    if (email && emailTaken(email)) return res.status(400).json({ error: "Esse e-mail já tem acesso." });
    const token = crypto.randomBytes(32).toString("base64url");
    const inv = { id: crypto.randomUUID(), hash: sha(token).toString("hex"), email: email || null, createdAt: Date.now(), expiresAt: Date.now() + INVITE_DAYS * 86400000, usedAt: null };
    store.invites.push(inv); // só o hash fica guardado: o link aparece uma vez, aqui
    saveStore();
    res.json({ id: inv.id, link: `${req.protocol}://${req.get("host")}/convite/${token}`, expiresAt: inv.expiresAt, email: inv.email });
  });

  app.delete("/api/users/invites/:id", adminOnly, (req, res) => {
    const n = store.invites.length;
    store.invites = store.invites.filter((i) => i.id !== req.params.id);
    if (store.invites.length === n) return res.sendStatus(404);
    saveStore();
    res.sendStatus(204);
  });

  app.put("/api/users/:id/password", adminOnly, express.json({ limit: "10kb" }), async (req, res) => {
    const u = store.users.find((x) => x.id === req.params.id);
    const pw = String(req.body?.password || "");
    if (!u) return res.sendStatus(404);
    if (pw.length < 8) return res.status(400).json({ error: "A senha precisa ter pelo menos 8 caracteres." });
    u.pass = await hashPw(pw);
    saveStore();
    res.json({ ok: true });
  });

  app.delete("/api/users/:id", adminOnly, (req, res) => {
    const u = store.users.find((x) => x.id === req.params.id);
    if (!u) return res.sendStatus(404);
    store.users = store.users.filter((x) => x !== u);
    saveStore();
    ctx.onUserRemoved?.(u.id); // os projetos dele passam para o administrador
    res.sendStatus(204);
  });

  // ---------- aceitar convite (público: a pessoa ainda não tem conta) ----------
  const findInvite = (token) => {
    const h = sha(String(token)).toString("hex");
    const inv = store.invites.find((i) => i.hash === h);
    return inv && !inv.usedAt && inv.expiresAt > Date.now() ? inv : null;
  };
  app.get("/convite/:token", (_req, res) => {
    if (!enabled) return res.redirect(302, "/");
    res.set("Cache-Control", "no-store").sendFile(path.join(__dirname, "public", "convite.html"));
  });
  app.get("/api/invite/:token", (req, res) => {
    const w = wait(req.ip);
    if (w) return res.status(429).json({ error: "Muitas tentativas. Tente de novo mais tarde." });
    const inv = findInvite(req.params.token);
    if (!inv) { fail(req.ip); return res.status(410).json({ error: "Este convite não vale mais. Peça um novo ao administrador." }); }
    res.set("Cache-Control", "no-store").json({ email: inv.email });
  });
  app.post("/api/invite/accept", express.json({ limit: "10kb" }), async (req, res) => {
    const w = wait(req.ip);
    if (w) return res.status(429).json({ error: "Muitas tentativas. Tente de novo mais tarde." });
    const inv = findInvite(req.body?.token);
    if (!inv) { fail(req.ip); return res.status(410).json({ error: "Este convite não vale mais. Peça um novo ao administrador." }); }
    const email = String(req.body?.email || "").trim().toLowerCase();
    const pw = String(req.body?.password || "");
    if (inv.email && email !== inv.email) return res.status(400).json({ error: "Este convite é para outro e-mail." });
    if (!EMAIL_RE.test(email)) return res.status(400).json({ error: "Digite um e-mail válido." });
    if (emailTaken(email)) return res.status(400).json({ error: "Esse e-mail já tem acesso. Entre pela tela de login." });
    if (pw.length < 8) return res.status(400).json({ error: "A senha precisa ter pelo menos 8 caracteres." });
    const user = { id: crypto.randomUUID(), email, pass: await hashPw(pw), createdAt: Date.now() };
    store.users.push(user);
    inv.usedAt = Date.now(); // o link vale uma vez só
    saveStore();
    startSession(req, res, { ...user, role: "member" }).json({ ok: true });
  });

  if (!enabled) console.warn("[login] APP_PASSWORD não definida: o sistema está ABERTO (sem login). Defina APP_EMAIL e APP_PASSWORD.");
  else console.log(`[login] ativo. Administrador: ${USER} · ${store.users.length} membro(s)`);

  return { emailOf: (id) => (id === "admin" ? (enabled ? USER : null) : store.users.find((u) => u.id === id)?.email ?? null) };
}
