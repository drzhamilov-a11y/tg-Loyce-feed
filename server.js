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
  const limit = Math.min(parseInt(req.query.limit || "5", 10), 30); // ← 5 по умолчанию
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

  <!-- Top.Mail.Ru counter (VK pixel) -->
  <script type="text/javascript">
  var _tmr = window._tmr || (window._tmr = []);
  _tmr.push({id: "3738381", type: "pageView", start: (new Date()).getTime()});
  (function (d, w, id) {
    if (d.getElementById(id)) return;
    var ts = d.createElement("script"); ts.type = "text/javascript"; ts.async = true; ts.id = id;
    ts.src = "https://top-fwz1.mail.ru/js/code.js";
    var f = function () {var s = d.getElementsByTagName("script")[0]; s.parentNode.insertBefore(ts, s);};
    if (w.opera == "[object Opera]") { d.addEventListener("DOMContentLoaded", f, false); } else { f(); }
  })(document, window, "tmr-code");
  </script>
  <noscript><div><img src="https://top-fwz1.mail.ru/counter?id=3738381;js=na" style="position:absolute;left:-9999px;" alt="Top.Mail.Ru" /></div></noscript>
  <!-- /Top.Mail.Ru counter -->

  <style>
    body { margin:0; padding:12px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#fff; }
    .wrap { max-width: 720px; margin: 0 auto; }
    .topbar { display:flex; gap:10px; align-items:center; margin-bottom:12px; }
    .badge { font-size: 12px; padding: 6px 10px; border-radius: 999px; background: #f2f2f2; }
    .btn { width:100%; padding:12px 14px; border-radius:12px; border:1px solid #e6e6e6; background:#fafafa; cursor:pointer; font-size:14px; }
    .btn:disabled { opacity:0.6; cursor:default; }

    .post { margin: 0 0 12px 0; position: relative; }
    .hint { color:#666; font-size:13px; margin: 10px 0; }
    .divider { height:1px; background:#eee; margin: 12px 0; }

    /* кнопка под каждым постом */
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
      text-align:center;
    }
    .open-btn svg{ width:18px; height:18px; fill:#fff; }
    .open-btn:active{ opacity:.85; }

    /* перехват клика по "самолётику" (он внутри iframe и его нельзя изменить напрямую) */
    .tg-click-override{
      position:absolute;
      top:0;
      right:0;
      width:56px;
      height:56px;
      z-index:5;
      background:transparent;
    }
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

    function trackTmrGoal(goalName){
      try{
        window._tmr = window._tmr || [];
        window._tmr.push({ id: "3738381", type: "reachGoal", goal: goalName });
      }catch(e){}
    }

    function openWithTracking(url){
      trackTmrGoal('tg_open');
      const w = window.open(url, '_blank', 'noopener');
      if (!w) window.location.href = url;
    }

    async function apiFeed(params){
      const url = new URL('/api/feed', location.origin);
      url.searchParams.set('limit','5'); // ← 5 постов за раз
      for(const k in (params||{})) url.searchParams.set(k, params[k]);
      const r = await fetch(url);
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

      // перехват клика по зоне самолётика (ведём на нужный пост + событие пикселя)
      const overlay = document.createElement('a');
      overlay.className = 'tg-click-override';
      overlay.href = 'https://t.me/' + key;
      overlay.target = '_blank';
      overlay.rel = 'noopener';
      overlay.addEventListener('click', (e) => {
        e.preventDefault();
        openWithTracking(overlay.href);
      });

      // кнопка "Открыть пост..."
      const btn = document.createElement('a');
      btn.className = 'open-btn';
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.href = 'https://t.me/' + key;
      btn.innerHTML = \`
        <svg viewBox="0 0 240 240" aria-hidden="true" focusable="false">
          <path d="M120 0C53.7 0 0 53.7 0 120s53.7 120 120 120 120-53.7 120-120S186.3 0 120 0zm58.5 82.1l-22.4 105.8c-1.7 7.6-6.2 9.5-12.6 5.9l-34.9-25.8-16.8 16.2c-1.9 1.9-3.4 3.4-7 3.4l2.5-35.6 64.8-58.6c2.8-2.5-.6-3.9-4.3-1.4l-80.1 50.4-34.5-10.8c-7.5-2.3-7.7-7.5 1.6-11.1l134.9-52c6.2-2.3 11.6 1.5 9.6 10z"/>
        </svg>
        Открыть пост в Телеграм-канале!
      \`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openWithTracking(btn.href);
      });

      wrap.appendChild(s);
      wrap.appendChild(overlay);
      wrap.appendChild(btn);

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
        items.reverse();
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
