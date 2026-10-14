/**
 * ハロプロ Threads 投稿アーカイブ Worker (Static Assets 併用)
 *
 * 公開API
 *   GET /api/posts?a=&from=&to=&q=&before=   投稿を新しい順に100件ずつ。a はユーザー名のカンマ区切り
 *   GET /api/calendar?ym=YYYY-MM&a=&q=        その月の日ごとの投稿数(a / q の条件込み)
 *   GET /api/accounts                         絞り込み用のアカウント一覧
 *
 * クローラ用API (Authorization: Bearer <CRAWL_TOKEN>。未設定なら存在しないことにする)
 *   GET  /api/crawl/state      アカウントごとの取得の進み具合
 *   POST /api/crawl/accounts   SNSスプシ由来の対象アカウントを丸ごと差し替え(外れた人は active=0)
 *   POST /api/crawl/posts      1ページ分の投稿と、そのアカウントの進み具合をまとめて書く
 *   POST /api/crawl/error      取得エラーを記録
 *
 * 定期実行: 毎日 JST 20:00 に、収録件数・前回からの増加数・新着投稿を Discord へ送る(DISCORD_WEBHOOK)。
 *
 * 目隠し: シークレット SITE_PASS があるあいだは、サイト全体が Basic 認証(利用者名は何でもよい)。
 *   クローラ用API(/api/crawl/*)は Bearer トークンで守っているので対象外。SITE_PASS を消せば関門ごと無くなる。
 *   非公開のあいだは、どの応答にも X-Robots-Tag: noindex を付け、robots.txt でも断る。
 *
 * それ以外は静的アセット(public/)へ。
 */

const MAX_Q = 100;         // 検索語の長さの上限
const PAGE = 100;          // 1回に返す投稿数
const EXCERPT_LEN = 80;    // 一覧に出す本文の先頭の文字数
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/* ============================ 正規化・bigram ============================ */

// 索引と検索で完全に同じものを使う: NFKC→小文字→日本語と英数字以外を除去
const DROP = /[^0-9a-z々぀-ヿ㐀-䶿一-鿿]/gu;

function normalize(s) {
  return (s || "").normalize("NFKC").toLowerCase().replace(DROP, "");
}

function bigrams(s) {
  const out = [];
  for (let i = 0; i + 1 < s.length; i++) out.push(s.slice(i, i + 2));
  return out;
}

// 検索語 → FTS5 のクエリ。語ごとに bigram のフレーズ(連続一致≒部分一致)にして AND で繋ぐ
function buildMatch(q) {
  const parts = [];
  for (const raw of q.slice(0, MAX_Q).split(/[\s　]+/)) {
    const toks = bigrams(normalize(raw));
    if (toks.length) parts.push('"' + toks.join(" ") + '"');
  }
  return parts.length ? parts.join(" AND ") : null;
}

/* ============================ 共通 ============================ */

function json(obj, status = 200, cache = "no-store") {
  return new Response(JSON.stringify(obj), {
    status,
    // API の中身(取れないアカウントの一覧など)は検索エンジンに載せない
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": cache, "x-robots-tag": "noindex" },
  });
}

async function cached(request, ctx, build) {
  const cache = caches.default;
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200) ctx.waitUntil(cache.put(request, res.clone()));
  return res;
}

// 2026-10-13T10:00:00+0000 → JST の '2026-10-13 19:00'
function toJst(ts) {
  const d = new Date(String(ts).replace(/([+-]\d\d)(\d\d)$/, "$1:$2"));
  if (isNaN(d)) return null;
  return new Date(d.getTime() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");
}

// 合言葉が合っているか(Basic認証の形。利用者名は何でもよく、合言葉だけを見る)
function unlocked(request, pass) {
  const got = request.headers.get("authorization") || "";
  if (!got.startsWith("Basic ")) return false;
  let decoded = "";
  try {
    decoded = new TextDecoder().decode(Uint8Array.from(atob(got.slice(6)), (c) => c.charCodeAt(0)));
  } catch {
    return false;
  }
  const given = decoded.slice(decoded.indexOf(":") + 1);
  // 長さの違いで中身が漏れないよう、最後まで見てから比べる
  if (given.length !== pass.length) return false;
  let diff = 0;
  for (let i = 0; i < pass.length; i++) diff |= given.charCodeAt(i) ^ pass.charCodeAt(i);
  return diff === 0;
}

const nowJst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 16).replace("T", " ");

/* ============================ 公開API ============================ */

// a / from / to / q の共通条件
function filters(p) {
  const where = [];
  const args = [];
  const accounts = (p.get("a") || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, 200);
  if (accounts.length) {
    where.push(`account IN (${accounts.map(() => "?").join(",")})`);
    args.push(...accounts);
  }
  const from = p.get("from") || "";
  const to = p.get("to") || "";
  if (DATE_RE.test(from)) { where.push("ts >= ?"); args.push(from); }
  if (DATE_RE.test(to)) { where.push("ts < ?"); args.push(to + " 99"); } // その日の終わりまで
  const match = buildMatch(p.get("q") || "");
  if (match) {
    where.push("id IN (SELECT id FROM post_fts WHERE post_fts MATCH ?)");
    args.push(match);
  }
  return { where, args };
}

async function handlePosts(url, env) {
  const p = url.searchParams;
  const { where, args } = filters(p);
  const before = p.get("before") || "";
  if (before) { where.push("ts < ?"); args.push(before.slice(0, 16)); }
  const sql =
    "SELECT id, account, ts, permalink, media_type, excerpt FROM post" +
    (where.length ? " WHERE " + where.join(" AND ") : "") +
    " ORDER BY ts DESC LIMIT ?";
  const { results } = await env.DB.prepare(sql).bind(...args, PAGE).all();
  return json({ posts: results, more: results.length === PAGE }, 200, "public, max-age=300");
}

async function handleCalendar(url, env) {
  const p = new URLSearchParams(url.searchParams);
  const ym = p.get("ym") || "";
  if (!/^\d{4}-\d{2}$/.test(ym)) return json({ error: "ym" }, 400);
  p.delete("from");
  p.delete("to");
  const { where, args } = filters(p);
  const [y, m] = ym.split("-").map(Number);
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  where.push("ts >= ?", "ts < ?");
  args.push(ym, next);
  const { results } = await env.DB
    .prepare(`SELECT substr(ts, 1, 10) AS d, COUNT(*) AS n FROM post WHERE ${where.join(" AND ")} GROUP BY d`)
    .bind(...args)
    .all();
  const days = {};
  for (const r of results) days[r.d] = r.n;
  return json({ days }, 200, "public, max-age=300");
}

async function handleAccounts(env) {
  const [accounts, latest] = await env.DB.batch([
    env.DB.prepare(
      "SELECT a.username, a.name, a.section, a.active, s.last_error AS error, " +
      "(SELECT COUNT(*) FROM post WHERE account = a.username) AS posts " +
      "FROM account a LEFT JOIN fetch_state s ON s.username = a.username ORDER BY a.active DESC, a.sort"),
    env.DB.prepare("SELECT MAX(ts) AS ts FROM post"),
  ]);
  return json({
    accounts: accounts.results,
    latest: latest.results[0] ? latest.results[0].ts : null,
  }, 200, "public, max-age=300");
}

/* ============================ クローラ用API ============================ */

function authorized(request, env) {
  const token = env.CRAWL_TOKEN;
  if (!token) return false;
  const got = request.headers.get("authorization") || "";
  const want = `Bearer ${token}`;
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

async function crawlState(env) {
  const { results } = await env.DB
    .prepare("SELECT username, after, done FROM fetch_state")
    .all();
  return json({ state: results });
}

// { accounts: [{ username, name, section, sort }] }
async function crawlAccounts(request, env) {
  const { accounts } = await request.json();
  if (!Array.isArray(accounts) || !accounts.length) return json({ error: "empty" }, 400);
  const stmts = [env.DB.prepare("UPDATE account SET active = 0")];
  for (const a of accounts) {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO account(username, name, section, sort, active) VALUES(?, ?, ?, ?, 1) " +
        "ON CONFLICT(username) DO UPDATE SET name = excluded.name, section = excluded.section, " +
        "sort = excluded.sort, active = 1")
      .bind(String(a.username), String(a.name), String(a.section), Number(a.sort) || 0));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: accounts.length });
}

// { username, posts: [{ id, text, timestamp, permalink, media_type }], state: { after, done } | null }
// 投稿と進み具合を1つの batch(=トランザクション)で書く。途中で落ちても、進み具合だけ進むことはない
async function crawlPosts(request, env) {
  const { username, posts, state } = await request.json();
  if (!username || !Array.isArray(posts)) return json({ error: "bad_request" }, 400);
  const stmts = [];
  for (const p of posts) {
    const ts = toJst(p.timestamp);
    // リポストは本人の文章ではないので入れない
    if (!p.id || !ts || p.media_type === "REPOST_FACADE") continue;
    const caption = p.text || "";
    // 絵文字(サロゲートペア)を途中で割らないよう、文字単位(Array.from)で切る
    const excerpt = Array.from(caption.split(/\s+/).filter(Boolean).join(" ")).slice(0, EXCERPT_LEN).join("");
    // 取り直しでは added_at を変えない(初めて入った日時を残す)
    stmts.push(env.DB
      .prepare(
        "INSERT INTO post(id, account, ts, permalink, media_type, excerpt, added_at) VALUES(?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(id) DO UPDATE SET account = excluded.account, ts = excluded.ts, permalink = excluded.permalink, " +
        "media_type = excluded.media_type, excerpt = excluded.excerpt")
      .bind(String(p.id), username, ts, String(p.permalink || ""), p.media_type || null, excerpt, nowJst()));
    stmts.push(env.DB.prepare("DELETE FROM post_fts WHERE id = ?").bind(String(p.id)));
    const grams = bigrams(normalize(caption)).join(" ");
    if (grams) stmts.push(env.DB.prepare("INSERT INTO post_fts(id, bigram) VALUES(?, ?)").bind(String(p.id), grams));
  }
  if (state) {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO fetch_state(username, after, done, last_error, checked_at) VALUES(?, ?, ?, NULL, ?) " +
        "ON CONFLICT(username) DO UPDATE SET after = excluded.after, done = excluded.done, " +
        "last_error = NULL, checked_at = excluded.checked_at")
      .bind(username, state.after || null, state.done ? 1 : 0, nowJst()));
  } else {
    stmts.push(env.DB
      .prepare(
        "INSERT INTO fetch_state(username, last_error, checked_at) VALUES(?, NULL, ?) " +
        "ON CONFLICT(username) DO UPDATE SET last_error = NULL, checked_at = excluded.checked_at")
      .bind(username, nowJst()));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: posts.length });
}

// { username, error }
async function crawlError(request, env) {
  const { username, error } = await request.json();
  if (!username) return json({ error: "bad_request" }, 400);
  await env.DB
    .prepare(
      "INSERT INTO fetch_state(username, last_error, checked_at) VALUES(?, ?, ?) " +
      "ON CONFLICT(username) DO UPDATE SET last_error = excluded.last_error, checked_at = excluded.checked_at")
    .bind(username, String(error || "").slice(0, 500), nowJst())
    .run();
  return json({ ok: true });
}

/* ============================ 毎日の報告 ============================ */

const SITE = "https://threads.karin-archive.com";
const REPORT_LIST_MAX = 30;   // 新着として一覧に載せる最大件数(Discord の文字数上限に収める)
const FRESH_DAYS = 3;         // 新着とみなす投稿日時の古さの上限

// 収録件数と前回からの増加数、新着の一覧を送る。
// 増加数には過去分の遡りで入った古い投稿も含む。
// 新着は「前回の報告以降にDBへ入った」かつ「投稿が直近 FRESH_DAYS 日以内」のもの
// (取得は数時間おきなので、投稿日時だけで区切ると報告の直前の投稿が漏れる。遡りで入った古い投稿は除く)
async function dailyReport(env) {
  if (!env.DISCORD_WEBHOOK) return;
  const [{ results: tot }, { results: prev }] = await env.DB.batch([
    env.DB.prepare("SELECT COUNT(*) AS n FROM post"),
    env.DB.prepare("SELECT k, v FROM meta WHERE k IN ('report_at', 'report_total')"),
  ]);
  const total = tot[0].n;
  const m = Object.fromEntries(prev.map((r) => [r.k, r.v]));
  const now = nowJst();
  // 初回は24時間前から
  const since = m.report_at || new Date(Date.now() + (9 - 24) * 3600e3).toISOString().slice(0, 16).replace("T", " ");
  const diff = m.report_total == null ? null : total - Number(m.report_total);

  const { results: fresh } = await env.DB
    .prepare(
      "SELECT p.ts, p.permalink, p.excerpt, ifnull(a.name, p.account) AS name FROM post p " +
      "LEFT JOIN account a ON a.username = p.account WHERE p.added_at > ? AND p.ts >= ? ORDER BY p.ts")
    .bind(since, new Date(Date.now() + (9 - 24 * FRESH_DAYS) * 3600e3).toISOString().slice(0, 16).replace("T", " "))
    .all();

  const lines = fresh.slice(0, REPORT_LIST_MAX).map((r) => {
    const text = Array.from(r.excerpt || "（本文なし）").slice(0, 40).join("").replace(/[\[\]]/g, "");
    return `${r.ts.slice(5).replace("-", "/")} **${r.name}** [${text}](${r.permalink})`;
  });
  if (fresh.length > REPORT_LIST_MAX) lines.push(`ほか ${fresh.length - REPORT_LIST_MAX} 件は[サイト](${SITE}/)で`);

  const head =
    `収録 **${total.toLocaleString()}** 件` +
    (diff == null ? "" : `（前回から ${diff >= 0 ? "+" : ""}${diff.toLocaleString()}）`) +
    `\n新着 **${fresh.length}** 件（${since.slice(5).replace("-", "/")} 〜 ${now.slice(5).replace("-", "/")}）`;

  const res = await fetch(env.DISCORD_WEBHOOK, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Threads 検索",  // ウェブフックは karin と共用。送り主の表示だけ変える
      embeds: [{
        title: "今日の Threads",
        url: SITE + "/",
        description: (head + (lines.length ? "\n\n" + lines.join("\n") : "")).slice(0, 4000),
        color: 0x8c6bb8,
      }],
    }),
  });
  if (!res.ok) throw new Error(`Discord ${res.status}`);

  await env.DB.batch([
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('report_at', ?)").bind(now),
    env.DB.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES('report_total', ?)").bind(String(total)),
  ]);
}

/* ============================ ルーティング ============================ */

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(dailyReport(env).catch((e) => console.log("毎日の報告に失敗", String(e))));
  },

  async fetch(request, env, ctx) {
    const res = await route(request, env, ctx);
    // 非公開のあいだは、どの応答も検索エンジンに載せない
    const out = new Response(res.body, res);
    out.headers.set("x-robots-tag", "noindex, nofollow");
    return out;
  },
};

async function route(request, env, ctx) {
  const url = new URL(request.url);
  const p = url.pathname;

  if (p === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }

  // 公開するまでは、合言葉を知っている人だけ通す。SITE_PASS(Worker のシークレット)を消せば関門ごと無くなる
  if (env.SITE_PASS && !p.startsWith("/api/crawl/") && !unlocked(request, env.SITE_PASS)) {
    return new Response("この画面はまだ準備中です。\n", {
      status: 401,
      headers: {
        "www-authenticate": 'Basic realm="hello-threads", charset="UTF-8"',
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  }

  // 公開API: 同一IPからの叩きすぎを止める
  if (p.startsWith("/api/") && !p.startsWith("/api/crawl/") && env.RL) {
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const { success } = await env.RL.limit({ key: ip });
    if (!success) return json({ error: "rate_limited" }, 429);
  }

  try {
    if (p === "/api/posts" && request.method === "GET") return await cached(request, ctx, () => handlePosts(url, env));
    if (p === "/api/calendar" && request.method === "GET") return await cached(request, ctx, () => handleCalendar(url, env));
    if (p === "/api/accounts" && request.method === "GET") return await cached(request, ctx, () => handleAccounts(env));
  } catch (e) {
    return json({ error: "failed" }, 500);
  }

  if (p.startsWith("/api/crawl/")) {
    if (!authorized(request, env)) return new Response("Not found", { status: 404 });
    try {
      const route = `${request.method} ${p.slice("/api/crawl/".length)}`;
      if (route === "GET state") return await crawlState(env);
      if (route === "POST accounts") return await crawlAccounts(request, env);
      if (route === "POST posts") return await crawlPosts(request, env);
      if (route === "POST error") return await crawlError(request, env);
      return new Response("Not found", { status: 404 });
    } catch (e) {
      // 例外のままだと Cloudflare の汎用エラー(1101)になって原因が分からないので中身を返す
      return json({ error: "crawl", message: String((e && e.message) || e) }, 500);
    }
  }

  if (p.startsWith("/api/")) return new Response("Not found", { status: 404 });
  return env.ASSETS.fetch(request);
}
