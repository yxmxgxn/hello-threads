#!/usr/bin/env python3
"""
ハロプロ現役メンバーと一部OGの Threads 投稿を Threads API の profile_posts で取得し、
Worker のクローラ用API(/api/crawl/*)経由で D1 に書き込む。

対象アカウント: karin-archive の SNS一覧スプシ(accounts シート)の threads 行のうち
  - 所属(affiliation)が現役グループの人
  - OG: 所属が J.P ROOM / UP-FRONT PROMOTION の人、M-line 会員ページ(m-line 行)を持つ人
    (所属が retirement の人は除く)
シートを直せば次の実行から対象も変わる。外れた人の投稿は消さない(Worker 側で active=0)。

profile_posts は threads_profile_discovery 権限が要る。スタンダードアクセス(審査前)では
Meta の公式アカウント(threads / meta / instagram / facebook)しか引けないので、審査が通るまでは
環境変数 TARGETS でそれらを指定して動作確認する(指定があればスプシは見ない)。
フォロワー100人以上の公開プロフィールだけが対象。上限は24時間で1000回。

1回で最大 PAGE_SIZE 件、過去分は after カーソルで遡る。1回の実行の呼び出し数を MAX_CALLS に抑え、
遡りきれなかった分は D1 の fetch_state に残して次の実行で続ける。
  - 1周目: 全アカウントの最新ページ(INSERT OR REPLACE なので重複は無害)
  - 2周目: 遡りが終わっていないアカウントを、残りの回数の範囲で続ける
投稿と進み具合は Worker 側で1つの batch で書くので、片方だけ進むことはない。
リポスト(REPOST_FACADE)は Worker 側で捨てる。

環境変数:
  CRAWL_API              Worker のURL(例: https://threads.karin-archive.com)
  CRAWL_TOKEN            Worker の CRAWL_TOKEN と同じ値
  THREADS_ACCESS_TOKEN   Threads API の長期アクセストークン
  TARGETS                動作確認用。カンマ区切りのユーザー名(例: threads,meta)。指定するとスプシを使わない
  MAX_CALLS              1回の実行で使う Threads API の呼び出し上限(既定 200)
"""

import csv
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

THREADS_API = "https://graph.threads.net/v1.0"
PAGE_SIZE = 50
FIELDS = "id,text,timestamp,permalink,media_type"

# karin-archive の SNS一覧スプシ(accounts シート)。
# 列: 0=member番号 1=名前 2=platform 3=ID 4=MEMBER(位置で読む。ヘッダーに重複があるため)
ACCOUNTS_CSV = (
    "https://docs.google.com/spreadsheets/d/e/"
    "2PACX-1vSLHCVWWxyVI5GS9SSohSNYL4U-uY4jekuMXbaKYXYjWrSZlgSxGV0BFvnCWRrd-A4Z5sqkoRwRyDqD/pub"
    "?gid=1522035537&single=true&output=csv"
)

# 現役グループ(affiliation slug → 見出し。この順が並び順)。
# karin-archive の Python/generate_sns.py の GROUPS と同じものを保つ(改名・増減時は両方直す)
GROUPS: dict[str, str] = {
    "morningmusume":  "モーニング娘。'26",
    "angerme":        "アンジュルム",
    "juicejuice":     "Juice=Juice",
    "tsubakifactory": "つばきファクトリー",
    "beyooooonds":    "BEYOOOOONDS",
    "ochanorma":      "OCHA NORMA",
    "rosychronicle":  "ロージークロニクル",
}
OG_SECTIONS = ["J.P ROOM", "M-line", "UP-FRONT PROMOTION"]

# スプシの判定に乗らないが対象にするアカウント: ユーザー名 → (表示名, 見出し)
EXTRA_ACCOUNTS: dict[str, tuple[str, str]] = {}


def warn(msg: str) -> None:
    if os.environ.get("GITHUB_ACTIONS") == "true":
        msg = msg.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")
        print(f"::warning title=Threads::{msg}")
    else:
        print(f"[warn] {msg}")


# ---------- 対象アカウント ----------

def load_targets() -> list[dict]:
    """[{username, name, section, sort}]。現役(グループ順→加入順)のあとにOG(見出しごと→加入順)。"""
    with urllib.request.urlopen(ACCOUNTS_CSV, timeout=60) as res:
        rows = list(csv.reader(io.StringIO(res.read().decode("utf-8"))))[1:]

    members: dict[int, dict] = {}
    for row in rows:
        row = [c.strip() for c in row] + [""] * 5
        num_s, name, platform, id_ = row[0], row[1], row[2], row[3]
        if not num_s.isdigit() or not platform:
            continue
        m = members.setdefault(int(num_s), {"num": int(num_s), "name": name, "aff": "", "ids": [], "mline": False})
        if not m["name"] and name:
            m["name"] = name
        if platform == "affiliation":
            m["aff"] = id_
        elif platform == "threads" and id_:
            m["ids"].append(id_.strip("/").lstrip("@").lower())
        elif platform == "m-line" and id_:
            m["mline"] = True

    group_order = list(GROUPS)
    picked = []
    for m in members.values():
        if m["aff"] in GROUPS:
            picked.append(((0, group_order.index(m["aff"]), m["num"]), m, GROUPS[m["aff"]]))
            continue
        if m["aff"] == "retirement":
            continue
        if m["aff"] == "jproom":
            sec = "J.P ROOM"
        elif m["aff"] == "upfrontpromotion":
            sec = "UP-FRONT PROMOTION"
        elif m["mline"]:
            sec = "M-line"
        else:
            continue
        picked.append(((1, OG_SECTIONS.index(sec), m["num"]), m, sec))

    out: dict[str, dict] = {}
    for _, m, sec in sorted(picked, key=lambda t: t[0]):
        for user in m["ids"]:
            # 複数アカウントを持つ人はユーザー名を添えて区別する
            name = m["name"] if len(m["ids"]) == 1 else f"{m['name']}（@{user}）"
            out.setdefault(user, {"username": user, "name": name, "section": sec})
    for user, (name, sec) in EXTRA_ACCOUNTS.items():
        out.setdefault(user, {"username": user, "name": name, "section": sec})
    targets = list(out.values())
    for i, t in enumerate(targets):
        t["sort"] = i
    return targets


# ---------- Worker のクローラ用API ----------

def crawl(method: str, path: str, body: dict | None = None) -> dict:
    api = os.environ["CRAWL_API"].rstrip("/")
    req = urllib.request.Request(
        f"{api}/api/crawl/{path}",
        method=method,
        data=None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={
            "authorization": f"Bearer {os.environ['CRAWL_TOKEN']}",
            "content-type": "application/json",
            # Cloudflare の Bot 判定に引っかからないよう、素性の分かる UA にする
            "user-agent": "hello-threads-crawler",
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{method} {path}: HTTP {e.code} {e.read().decode('utf-8', 'replace')[:300]}") from None


# ---------- Threads API ----------

def fetch_page(username: str, after: str | None) -> dict:
    q = {"username": username, "fields": FIELDS, "limit": PAGE_SIZE,
         "access_token": os.environ["THREADS_ACCESS_TOKEN"]}
    if after:
        q["after"] = after
    with urllib.request.urlopen(f"{THREADS_API}/profile_posts?{urllib.parse.urlencode(q)}", timeout=60) as res:
        return json.loads(res.read().decode("utf-8"))


def next_state(page: dict) -> dict:
    """次に遡るカーソルと、遡りきったか。
    続きがあっても1ページの件数が上限に満たないことがある(年齢制限の投稿などを除いた結果)ので、
    件数では判断しない。カーソルが無いか、中身が0件のページが返ってきたら最後とみなす。
    最後のときはカーソルも捨てる(残すと、下の立て直しで毎回確認しに行ってしまうため)。"""
    after = page.get("paging", {}).get("cursors", {}).get("after")
    if not after or not page.get("data"):
        return {"after": None, "done": True}
    return {"after": after, "done": False}


def err_text(e: urllib.error.HTTPError) -> str:
    """APIエラーを短く。"""
    try:
        err = json.loads(e.read().decode("utf-8")).get("error", {})
    except ValueError:
        return f"HTTP {e.code}"
    if err.get("code") == 190:
        return f"アクセストークンが無効(190/{err.get('error_subcode')} {err.get('message', '')})"
    return f"{err.get('code')}/{err.get('error_subcode')} {err.get('message', '')}"


def is_token_error(msg: str) -> bool:
    return msg.startswith("アクセストークン")


# ---------- 本体 ----------

def main() -> int:
    for k in ("CRAWL_API", "CRAWL_TOKEN", "THREADS_ACCESS_TOKEN"):
        if not os.environ.get(k):
            print(f"環境変数 {k} が未設定です(CRAWL_API は Variables、ほかは Secrets に登録)", file=sys.stderr)
            return 1
    max_calls = int(os.environ.get("MAX_CALLS") or 200)

    # 審査前の動作確認: TARGETS に Meta の公式アカウントなどを指定する
    override = [u.strip().lstrip("@").lower() for u in os.environ.get("TARGETS", "").split(",") if u.strip()]
    if override:
        targets = [{"username": u, "name": u, "section": "動作確認", "sort": i} for i, u in enumerate(override)]
    else:
        targets = load_targets()
    crawl("POST", "accounts", {"accounts": targets})
    state = {s["username"]: s for s in crawl("GET", "state")["state"]}
    # 以前の判定(paging.next の有無や、件数が1ページに満たないこと)で途中なのに「遡り完了」にされた人を立て直す。
    # 完了なのにカーソルが残っている人は、まだ続きがあるかもしれないので遡りを再開する
    # (本当に終わっていた人は、次の1ページが空で返ってカーソルごと消え、正しく完了に戻る)
    for st in state.values():
        if st["done"] and st["after"]:
            st["done"] = 0

    calls = 0
    saved = 0
    failed: list[str] = []

    def get(user: str, after: str | None) -> dict | None:
        nonlocal calls
        calls += 1
        try:
            return fetch_page(user, after)
        except urllib.error.HTTPError as e:
            msg = err_text(e)
            failed.append(f"{user}{'(遡り)' if after else ''}: {msg}")
            crawl("POST", "error", {"username": user, "error": msg})
            if is_token_error(msg):
                raise
            return None
        finally:
            time.sleep(0.5)

    try:
        # 1周目: 全アカウントの最新ページ。遡りの起点(カーソル)が無い人はここで決まる
        for t in targets:
            if calls >= max_calls:
                break
            user = t["username"]
            media = get(user, None)
            if media is None:
                continue
            st = state.get(user)
            new_state = None
            if not st or (not st["after"] and not st["done"]):
                new_state = next_state(media)
                state[user] = {"username": user, **new_state}
            crawl("POST", "posts", {"username": user, "posts": media.get("data", []), "state": new_state})
            saved += len(media.get("data", []))

        # 2周目: 遡りが終わっていないアカウントを、残りの回数で続ける
        for t in targets:
            user = t["username"]
            st = state.get(user)
            while st and not st["done"] and st["after"] and calls < max_calls:
                media = get(user, st["after"])
                if media is None:
                    break
                st = {"username": user, **next_state(media)}
                state[user] = st
                crawl("POST", "posts", {"username": user, "posts": media.get("data", []),
                                        "state": {"after": st["after"], "done": st["done"]}})
                saved += len(media.get("data", []))
    except urllib.error.HTTPError:
        warn("アクセストークンが無効です。発行し直して THREADS_ACCESS_TOKEN を更新してください\n"
             + (failed[-1] if failed else ""))
        return 1

    pending = sum(1 for t in targets if not state.get(t["username"], {}).get("done"))
    print(f"対象 {len(targets)} / API {calls}回 / 保存 {saved}件 / 遡り未完了 {pending}アカウント")
    if failed:
        warn("取得できなかったアカウント:\n" + "\n".join(failed))
    return 0


if __name__ == "__main__":
    sys.exit(main())
