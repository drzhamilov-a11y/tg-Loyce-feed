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
  throw new Error("Missing env vars. Check BOT_TOKEN, WEBHOOK_SECRET, CHANNEL_USERNAME, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, PUBLIC_BASE_URL");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();
app.use(express.json({ limit: "1mb" }));

function makeEtag(obj) {
  const json = JSON.stringify(obj);
  return `"${crypto.createHash("sha1").update(json).digest("hex")}"`;
}

// Telegram webhook: принимает новые посты канала
app.post("/telegram/webhook", async (req, res) => {
  const token = req.header("X-Telegram-Bot-Api-Secret-Token");
  if (token !== WEBHOOK_SECRET) return res.sendStatus(401);

  const msg = req.body?.channel_post;
  if (!msg) return res.sendStatus(200);

  const fromUsername = msg?.chat?.username;
  if (fromUsername && fromUsername.toLowerCase() !== CHANNEL_USERNAME.toLowerCase()) {
    return res.sendStatus(200);
  }

  const messageId = msg.message_id;
  const postedAt = new Date((msg.date || Math.floor(Date.now() / 1000)) * 1000).toISOString();

  const { error } = await supabase
    .from("tg_posts")
    .upsert(
      { channel_username: CHANNEL_USERNAME, message_id: messageId, posted_at: postedAt },
      { onConflict: "channel_username,message_id" }
    );

  if (error) {
    console.error("Supabase upsert error:", error);
    return res.sendStatus(500);
  }

  return res.sendStatus(200);
});

// API: отдаёт список постов (по id), с пагинацией
app.get("/api/feed", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "10", 10), 30);
  const before = req.query.before ? parseInt(req.query.before, 10) : null;
  const after = req.query.after ? parseInt(req.query.after, 10) : null;

  let q = supabase
    .from("tg_posts")
    .select("message_id, posted_at")
    .eq("channel_username", CHANNEL_USERNAME);

  if (before) q = q.lt("message_id", before);
  if (after) q = q.gt("message_id", after);

  q = q.order("message_id", { ascending: false }).limit(limit);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "DB error" });

  const items = (data || []).map(r => ({
    message_id: r.message_id,
    posted_at: r.posted_at,
    key: `${CHANNEL_USERNAME}/${r.message_id}`
  }));

  const etag = makeEtag(items);
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", "public, max-age=10");
  if (req.headers["if-none-match"] === etag) return res.sendStatus(304);

  res.json({ items });
});

// Виджет-страница: её будем встраивать в Taplink
app.get("/widget", async (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Telegram feed</title>
  <style>
    body { margin:0; padding:12px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#fff; }
    .wrap { max-width: 720px; margin: 0 auto; }
    .topbar { display:flex; gap:10px; align-items:center; margin-bottom:12px; }
    .badge { font-size: 12px; padding: 6px 10px; border-radius: 999px; background: #f2f2f2; }
    .btn { width:100%; padding:12px 14px; border-radius:12px; border:1px solid #e6e6e6; background:#fafafa; cursor:pointer; font-size:14px; }
    .btn:disabled { opacity:0.6; cursor:default; }
    .post { margin: 0 0 12px 0; }
    .hint { color:#666; font-size:13px; margin: 10px 0; }
    .divider { height:1px; background:#eee; margin: 12px 0; }

    /* кнопка под каждым постом */
    .open-btn{
      display:block;
      margin:10px 0 18px;
      padding:12px 14px;
      border-radius:12px;
      background:#0088cc; /* Telegram blue */
      color:#fff;
      text-decoration:none;
      font-weight:600;
      font-size:14px;
      text-align:center;
    }
    .open-btn:active{ opacity:.85; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="badge">@${CHANNEL_USERNAME}</div>
      <div id="status" class="badge">загрузка…</div>
    </div>

    <div id="newHint" class="hint" style="display:none;"></div>
    <div id="feed"></div>

    <div class="divider"></div>
    <button id="moreBtn" class="btn">Показать ещё</button>
    <div class="hint">Новые посты подгружаются автоматически.</div>
  </div>

  <script>
    const feedEl = document.getElementById('feed');
    const statusEl = document.getElementById('status');
    const moreBtn = document.getElementById('moreBtn');
    const newHint = document.getElementById('newHint');

    let newestId = null;
    let oldestId = null;
    let loading = false;

    function setStatus(t){ statusEl.textContent = t; }

    async function apiFeed(params){
      const url = new URL('/api/feed', location.origin);
      url.searchParams.set('limit','8');
      for (const [k,v] of Object.entries(params||{})) url.searchParams.set(k, String(v));
      const r = await fetch(url.toString(), { cache: 'no-store' });
      if (r.status === 304) return { items: [] };
      return r.json();
    }

    function appendTelegramPost(key, where='bottom'){
      const wrap = document.createElement('div');
      wrap.className = 'post';

      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://telegram.org/js/telegram-widget.js?22';
      s.setAttribute('data-telegram-post', key);
      s.setAttribute('data-width', '100%');
      s.setAttribute('data-userpic', 'false');

      // кнопка "Открыть пост в Телеграм-канале!"
      const a = document.createElement('a');
      a.className = 'open-btn';
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Открыть пост в Телеграм-канале!';
      a.href = 'https://t.me/' + key; // key = username/message_id

      wrap.appendChild(s);
      wrap.appendChild(a);

      where === 'top' ? feedEl.prepend(wrap) : feedEl.appendChild(wrap);
    }

    function updateBounds(ids){
      if (!ids.length) return;
      const max = Math.max(...ids);
      const min = Math.min(...ids);
      newestId = newestId === null ? max : Math.max(newestId, max);
      oldestId = oldestId === null ? min : Math.min(oldestId, min);
    }

    async function loadInitial(){
      if (loading) return;
      loading = true;
      setStatus('загрузка…');
      try {
        const data = await apiFeed({});
        const items = data.items || [];
        if (!items.length){
          setStatus('пока пусто');
          moreBtn.disabled = true;
          return;
        }
        updateBounds(items.map(x=>x.message_id));
        for (const it of items) appendTelegramPost(it.key, 'bottom');
        setStatus('онлайн');
      } catch(e){
        setStatus('ошибка');
      } finally {
        loading = false;
      }
    }

    async function loadMoreOlder(){
      if (loading || oldestId === null) return;
      loading = true;
      moreBtn.disabled = true;
      moreBtn.textContent = 'Загружаю…';
      try{
        const data = await apiFeed({ before: oldestId });
        const items = data.items || [];
        if (!items.length){
          moreBtn.textContent = 'Больше нет постов';
          moreBtn.disabled = true;
          return;
        }
        updateBounds(items.map(x=>x.message_id));
        for (const it of items) appendTelegramPost(it.key, 'bottom');
        moreBtn.textContent = 'Показать ещё';
        moreBtn.disabled = false;
      } catch(e){
        moreBtn.textContent = 'Показать ещё';
        moreBtn.disabled = false;
      } finally {
        loading = false;
      }
    }

    async function pollNew(){
      if (loading || newestId === null) return;
      try{
        const data = await apiFeed({ after: newestId });
        const items = data.items || [];
        if (!items.length) return;
        items.reverse(); // чтобы при prepend порядок был правильный
        updateBounds(items.map(x=>x.message_id));
        for (const it of items) appendTelegramPost(it.key, 'top');
        newHint.style.display = 'block';
        newHint.textContent = 'Добавлены новые посты: ' + items.length;
        setTimeout(()=>{ newHint.style.display='none'; }, 2500);
      } catch(e){}
    }

    moreBtn.addEventListener('click', loadMoreOlder);
    loadInitial().then(()=> setInterval(pollNew, 25000));
  </script>
</body>
</html>`);
});

app.get("/", (req,res)=>res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log("Listening on", port));
