import express from "express";
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";

const {
  BOT_TOKEN,
  WEBHOOK_SECRET,
  CHANNEL_USERNAME,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  PUBLIC_BASE_URL
} = process.env;

if (
  !BOT_TOKEN || !WEBHOOK_SECRET || !CHANNEL_USERNAME ||
  !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY || !PUBLIC_BASE_URL
) {
  throw new Error("Missing env vars");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();
app.use(express.json({ limit: "1mb" }));

function makeEtag(obj) {
  return `"${crypto.createHash("sha1").update(JSON.stringify(obj)).digest("hex")}"`;
}

/* ===== Telegram webhook ===== */
app.post("/telegram/webhook", async (req, res) => {
  const token = req.header("X-Telegram-Bot-Api-Secret-Token");
  if (token !== WEBHOOK_SECRET) return res.sendStatus(401);

  const msg = req.body?.channel_post;
  if (!msg) return res.sendStatus(200);

  if (msg?.chat?.username?.toLowerCase() !== CHANNEL_USERNAME.toLowerCase()) {
    return res.sendStatus(200);
  }

  const messageId = msg.message_id;
  const postedAt = new Date(msg.date * 1000).toISOString();

  await supabase.from("tg_posts").upsert(
    { channel_username: CHANNEL_USERNAME, message_id: messageId, posted_at: postedAt },
    { onConflict: "channel_username,message_id" }
  );

  res.sendStatus(200);
});

/* ===== API feed ===== */
app.get("/api/feed", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "8", 10), 30);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  const after = req.query.after ? parseInt(req.query.after, 10) : null;

  let q = supabase
    .from("tg_posts")
    .select("message_id, posted_at")
    .eq("channel_username", CHANNEL_USERNAME);

  if (before) q = q.lt("message_id", before);
  if (after) q = q.gt("message_id", after);

  q = q.order("message_id", { ascending: false }).limit(limit);

  const { data } = await q;

  const items = (data || []).map(r => ({
    message_id: r.message_id,
    key: `${CHANNEL_USERNAME}/${r.message_id}`
  }));

  const etag = makeEtag(items);
  res.setHeader("ETag", etag);
  if (req.headers["if-none-match"] === etag) return res.sendStatus(304);

  res.json({ items });
});

/* ===== Widget ===== */
app.get("/widget", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Telegram feed</title>

<style>
body{
  margin:0;
  padding:12px;
  background:#fff;
  font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial;
}
.wrap{max-width:720px;margin:0 auto;}
.post{margin-bottom:14px;}

.open-btn{
  display:flex;
  align-items:center;
  justify-content:center;
  gap:8px;
  margin:10px auto 18px;
  padding:12px 14px;
  max-width:92%;
  border-radius:14px;
  background:#0088cc;
  color:#fff;
  text-decoration:none;
  font-weight:600;
  font-size:14px;
}
.open-btn svg{
  width:18px;
  height:18px;
  fill:#fff;
}
.open-btn:active{opacity:.85;}

.btn{
  width:100%;
  padding:12px;
  border-radius:12px;
  border:1px solid #e6e6e6;
  background:#fafafa;
  cursor:pointer;
}
</style>
</head>

<body>
<div class="wrap">
  <div id="feed"></div>
  <button id="moreBtn" class="btn">Показать ещё</button>
</div>

<script>
const feedEl = document.getElementById('feed');
const moreBtn = document.getElementById('moreBtn');
let oldestId = null;
let loading = false;

async function apiFeed(params){
  const url = new URL('/api/feed', location.origin);
  for(const k in params) url.searchParams.set(k, params[k]);
  const r = await fetch(url);
  return r.json();
}

function appendTelegramPost(key){
  const wrap = document.createElement('div');
  wrap.className = 'post';

  const s = document.createElement('script');
  s.async = true;
  s.src = 'https://telegram.org/js/telegram-widget.js?22';
  s.setAttribute('data-telegram-post', key);
  s.setAttribute('data-width','100%');
  s.setAttribute('data-userpic','false');

  const a = document.createElement('a');
  a.className = 'open-btn';
  a.target = '_blank';
  a.href = 'https://t.me/' + key;
  a.innerHTML = \`
    <svg viewBox="0 0 240 240">
      <path d="M120 0C53.7 0 0 53.7 0 120s53.7 120 120 120 120-53.7 120-120S186.3 0 120 0zm58.5 82.1l-22.4 105.8c-1.7 7.6-6.2 9.5-12.6 5.9l-34.9-25.8-16.8 16.2c-1.9 1.9-3.4 3.4-7 3.4l2.5-35.6 64.8-58.6c2.8-2.5-.6-3.9-4.3-1.4l-80.1 50.4-34.5-10.8c-7.5-2.3-7.7-7.5 1.6-11.1l134.9-52c6.2-2.3 11.6 1.5 9.6 10z"/>
    </svg>
    Открыть пост в Телеграм-канале!
  \`;

  wrap.appendChild(s);
  wrap.appendChild(a);
  feedEl.appendChild(wrap);
}

async function load(){
  if(loading) return;
  loading = true;
  const data = await apiFeed(oldestId ? { before: oldestId } : {});
  const items = data.items || [];
  if(!items.length){
    moreBtn.disabled = true;
    return;
  }
  for(const it of items){
    appendTelegramPost(it.key);
    oldestId = oldestId === null ? it.message_id : Math.min(oldestId, it.message_id);
  }
  loading = false;
}

moreBtn.onclick = load;
load();
</script>
</body>
</html>`);
});

app.get("/", (_,res)=>res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log("Listening on", port));
