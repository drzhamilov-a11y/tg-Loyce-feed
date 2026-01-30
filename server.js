import express from "express";
import { createClient } from "@supabase/supabase-js";

const {
  BOT_TOKEN, // оставил, чтобы env не ломались, хотя прямо тут он не используется
  WEBHOOK_SECRET,
  CHANNEL_USERNAME,
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY
} = process.env;

if (!WEBHOOK_SECRET || !CHANNEL_USERNAME || !SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  throw new Error("Missing env vars. Check WEBHOOK_SECRET, CHANNEL_USERNAME, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
const app = express();
app.use(express.json({ limit: "1mb" }));

/* ===== Telegram webhook: сохраняем id поста ===== */
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

/* ===== API: отдаём список постов ===== */
app.get("/api/feed", async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || "5", 10), 30); // ← 5 по умолчанию
  const before = req.query.before ? parseInt(req.query.before, 10) : null;

  let q = supabase
    .from("tg_posts")
    .select("message_id")
    .eq("channel_username", CHANNEL_USERNAME);

  if (before) q = q.lt("message_id", before);

  q = q.order("message_id", { ascending: false }).limit(limit);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: "DB error" });

  const items = (data || []).map(r => ({
    message_id: r.message_id,
    key: `${CHANNEL_USERNAME}/${r.message_id}`
  }));

  // лёгкий кэш: виджет всё равно обновляется по кнопке
  res.setHeader("Cache-Control", "public, max-age=10");
  res.json({ items });
});

/* ===== Widget ===== */
app.get("/widget", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Telegram feed</title>

  <!-- ускоряем первые подключения -->
  <link rel="preconnect" href="https://telegram.org">
  <link rel="preconnect" href="https://top-fwz1.mail.ru">
  <link rel="dns-prefetch" href="//telegram.org">
  <link rel="dns-prefetch" href="//top-fwz1.mail.ru">

  <!-- VK Pixel (Top.Mail.Ru) -->
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

  <style>
    body { margin:0; padding:12px; font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#fff; }
    .wrap { max-width: 720px; margin: 0 auto; }
    .head { display:flex; justify-content:space-between; align-items:center; gap:10px; margin-bottom:10px; }
    .badge { font-size:12px; padding:6px 10px; border-radius:999px; background:#f2f2f2; }
    #feed { min-height: 40px; }
    .post { margin: 0 0 12px 0; position: relative; }
    .btn { width:100%; padding:12px 14px; border-radius:12px; border:1px solid #e6e6e6; background:#fafafa; cursor:pointer; font-size:14px; }
    .btn:disabled { opacity:0.6; cursor:default; }

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
    .open-btn svg{ width:18px; height:18px; fill:#fff; }
    .open-btn:active{ opacity:.85; }

    /* перехват зоны самолётика (внутри iframe трогать нельзя) */
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
    <div class="head">
      <div class="badge">@${CHANNEL_USERNAME}</div>
      <div id="status" class="badge">загрузка…</div>
    </div>

    <div id="feed"></div>
    <button id="moreBtn" class="btn">Показать ещё</button>
  </div>

  <script>
    const feedEl = document.getElementById('feed');
    const statusEl = document.getElementById('status');
    const moreBtn = document.getElementById('moreBtn');

    let oldestId = null;
    let loading = false;

    function setStatus(t){ statusEl.textContent = t; }

    function trackGoal(){
      try {
        window._tmr = window._tmr || [];
        // Важно: формат как у VK подсказки
        window._tmr.push({ type: 'reachGoal', id: 3738381, goal: 'tg_open' });
      } catch (e) {}
    }

    function openWithTracking(url){
      trackGoal();
      const w = window.open(url, '_blank', 'noopener');
      if (!w) window.location.href = url;
    }

    async function apiFeed(params){
      const url = new URL('/api/feed', location.origin);
      url.searchParams.set('limit','5');
      for (const k in (params||{})) url.searchParams.set(k, params[k]);
      const r = await fetch(url.toString(), { cache: 'no-store' });
      return r.json();
    }

    function appendTelegramPost(key){
      const wrap = document.createElement('div');
      wrap.className = 'post';

      const postUrl = 'https://t.me/' + key;

      // Telegram widget (скрипт на каждый пост — зато стабильно работает при динамической подгрузке)
      const s = document.createElement('script');
      s.async = true;
      s.src = 'https://telegram.org/js/telegram-widget.js?22';
      s.setAttribute('data-telegram-post', key);
      s.setAttribute('data-width', '100%');
      s.setAttribute('data-userpic', 'false');

      // зона перехвата клика по самолётику
      const overlay = document.createElement('a');
      overlay.className = 'tg-click-override';
      overlay.href = postUrl;
      overlay.target = '_blank';
      overlay.rel = 'noopener';
      overlay.addEventListener('click', (e) => {
        e.preventDefault();
        openWithTracking(postUrl);
      });

      // кнопка под постом
      const btn = document.createElement('a');
      btn.className = 'open-btn';
      btn.href = postUrl;
      btn.target = '_blank';
      btn.rel = 'noopener';
      btn.innerHTML = \`
        <svg viewBox="0 0 240 240" aria-hidden="true">
          <path d="M120 0C53.7 0 0 53.7 0 120s53.7 120 120 120 120-53.7 120-120S186.3 0 120 0zm58.5 82.1l-22.4 105.8c-1.7 7.6-6.2 9.5-12.6 5.9l-34.9-25.8-16.8 16.2c-1.9 1.9-3.4 3.4-7 3.4l2.5-35.6 64.8-58.6c2.8-2.5-.6-3.9-4.3-1.4l-80.1 50.4-34.5-10.8c-7.5-2.3-7.7-7.5 1.6-11.1l134.9-52c6.2-2.3 11.6 1.5 9.6 10z"/>
        </svg>
        Открыть пост в Телеграм-канале!
      \`;
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        openWithTracking(postUrl);
      });

      wrap.appendChild(s);
      wrap.appendChild(overlay);
      wrap.appendChild(btn);
      feedEl.appendChild(wrap);
    }

    async function loadMore(){
      if (loading) return;
      loading = true;
      moreBtn.disabled = true;
      moreBtn.textContent = 'Загружаю…';

      try{
        const data = await apiFeed(oldestId ? { before: oldestId } : {});
        const items = data.items || [];

        if (!items.length){
          setStatus('пусто');
          moreBtn.textContent = 'Больше нет постов';
          moreBtn.disabled = true;
          return;
        }

        for (const it of items) {
          appendTelegramPost(it.key);
          oldestId = oldestId === null ? it.message_id : Math.min(oldestId, it.message_id);
        }

        setStatus('онлайн');
        moreBtn.textContent = 'Показать ещё';
        moreBtn.disabled = false;
      }catch(e){
        setStatus('ошибка');
        moreBtn.textContent = 'Показать ещё';
        moreBtn.disabled = false;
      }finally{
        loading = false;
      }
    }

    // стартовая загрузка — 5 постов, без фонового опроса (быстрее и легче)
    loadMore();
    moreBtn.addEventListener('click', loadMore);
  </script>
</body>
</html>`);
});

app.get("/", (req,res)=>res.send("OK"));

const port = process.env.PORT || 3000;
app.listen(port, ()=>console.log("Listening on", port));
