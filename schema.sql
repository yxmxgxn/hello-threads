-- ハロプロ Threads 投稿アーカイブ D1 スキーマ(hello-threads)
-- デプロイのたびに流す(IF NOT EXISTS なので何度流しても同じ)。
--
-- Threads 側は過去分を遡りにくいので、ここが原本になる。消すのは手でやるときだけ。
-- 本文は先頭の抜粋だけ持つ。検索は本文全体の bigram(post_fts)で行う。

CREATE TABLE IF NOT EXISTS post (
  id         TEXT PRIMARY KEY,  -- Threads のメディアID
  account    TEXT NOT NULL,     -- ユーザー名
  ts         TEXT NOT NULL,     -- 投稿日時(JST, 'YYYY-MM-DD HH:MM')
  permalink  TEXT NOT NULL,
  media_type TEXT,              -- TEXT_POST / IMAGE / VIDEO / CAROUSEL_ALBUM / AUDIO
  excerpt    TEXT,              -- 本文の先頭(一覧表示用)
  added_at   TEXT               -- このDBに初めて入った日時(JST)。毎日の報告の「新着」に使う
);
CREATE INDEX IF NOT EXISTS post_ts ON post(ts);
CREATE INDEX IF NOT EXISTS post_account_ts ON post(account, ts);

CREATE VIRTUAL TABLE IF NOT EXISTS post_fts USING fts5(
  id UNINDEXED,
  bigram
);

-- 対象アカウント。SNS一覧スプシから毎回まるごと送られてくる。
-- 対象から外れた人も消さずに active=0 にする(貯めた投稿をその人で絞り込めるように)
CREATE TABLE IF NOT EXISTS account (
  username TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  section  TEXT NOT NULL,       -- 選択肢の見出し(グループ名 / J.P ROOM など)
  sort     INTEGER NOT NULL,
  active   INTEGER NOT NULL DEFAULT 1
);

-- アカウントごとの取得の進み具合
CREATE TABLE IF NOT EXISTS fetch_state (
  username   TEXT PRIMARY KEY,
  after      TEXT,              -- 次に遡るときのカーソル
  done       INTEGER NOT NULL DEFAULT 0,  -- 1=過去分を遡りきった
  last_error TEXT,              -- 直近の取得エラー(取れたら NULL に戻す)
  checked_at TEXT               -- 最後に取りに行った日時(JST)
);

-- 1回きりの覚え書き(前回の毎日の報告の時刻と件数など)
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
);
