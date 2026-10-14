# ハロプロ Threads 検索（非公開・準備中）

https://threads.karin-archive.com/ （合言葉 `SITE_PASS` で目隠し中。noindex）

ハロプロ現役メンバーとOG（J.P ROOM・M-line・UP-FRONT PROMOTION）の公式Threadsの投稿を、日付・メンバー・本文で探せるサイト。
[hello-insta](https://github.com/yxmxgxn/hello-insta) と同じ作り。別 Worker・別 D1（`hello-threads`）。

## いまの状態

Threads API の `profile_posts` で他人の投稿を読むには、`threads_profile_discovery` の**アドバンスアクセス**（アプリレビュー）が要る。
スタンダードアクセスでは Meta の公式アカウント（threads / meta / instagram / facebook）しか読めないので、
審査が通るまでは Variables の `TARGETS` に `threads,meta` などを入れて動作確認・審査用の録画をする。
審査が通ったら `TARGETS` を消すと、SNS一覧スプシの対象（threads 行）に切り替わる。

## 構成

| 場所 | 中身 |
|---|---|
| `src/worker.js` | 公開API・クローラ用API・目隠し(SITE_PASS)・毎日の報告。正規化と bigram 化はここだけ |
| `public/` | 画面 |
| `schema.sql` | D1 `hello-threads` のテーブル。デプロイのたびに流す |
| `crawler/fetch.py` | Threads API の profile_posts で取得し、クローラ用API経由で D1 に書く。リポストは入れない |

## 動き方

- **Deploy**（`deploy.yml`）: main への push で、スキーマ適用 → Worker デプロイ（CRAWL_TOKEN・SITE_PASS を Worker に流し込む）
- **Fetch**（`fetch.yml`）: 1日4回（JST 3:15 / 9:15 / 15:15 / 19:15）。1回200回まで（上限は24時間で1000回）
- **毎日の報告**（Worker の cron）: JST 20:00 に Discord へ（Worker のシークレット `DISCORD_WEBHOOK`。無ければ送らない）
- 取れるのは公開プロフィールでフォロワー100人以上のアカウントだけ

## 設定

GitHub の Secrets: `CLOUDFLARE_API_TOKEN` / `CLOUDFLARE_ACCOUNT_ID` / `CRAWL_TOKEN` / `SITE_PASS` / `THREADS_ACCESS_TOKEN`

GitHub の Variables: `CRAWL_API` = `https://threads.karin-archive.com`、`TARGETS`（審査前だけ。例: `threads,meta`）

## 公開するとき

1. Secrets の `SITE_PASS` を消し、Worker のシークレットからも消す
2. `wrangler.jsonc` の `run_worker_first` を `["/api/*"]` に戻す
3. `src/worker.js` の `x-robots-tag` と robots.txt、各ページの `<meta name="robots">` を外す
