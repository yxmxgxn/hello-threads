(function () {
  "use strict";

  var TYPE = { TEXT_POST: "テキスト", VIDEO: "動画", CAROUSEL_ALBUM: "複数枚", IMAGE: "画像", AUDIO: "音声" };
  var names = {};               // ユーザー名 → 表示名
  var lastTs = "", listNo = 0, calNo = 0;
  var calYear, calMonth;        // 表示中の月(calMonth は 1-12)
  var $ = function (id) { return document.getElementById(id); };
  var pad = function (n) { return (n < 10 ? "0" : "") + n; };
  var options = function () { return Array.prototype.slice.call($("acc").options); };

  function params() {
    var p = new URLSearchParams();
    var sel = options().filter(function (o) { return o.selected; }).map(function (o) { return o.value; });
    if (sel.length) p.set("a", sel.join(","));
    if ($("from").value) p.set("from", $("from").value);
    if ($("to").value) p.set("to", $("to").value);
    if ($("q").value.trim()) p.set("q", $("q").value.trim());
    return p;
  }

  function getJson(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error(r.status); return r.json(); });
  }

  /* ---------- アカウント ---------- */

  // 取得エラーの文言 → 選択肢に添える理由(エラー文そのものは長いので出さない)
  function reason(error) {
    if (/トークン/.test(error)) return "一時的に取得できません";
    return "取得できません";
  }

  function fillAccounts(list) {
    var sel = $("acc"), groups = {}, order = [], blocked = [];
    list.forEach(function (a) {
      names[a.username] = a.name;
      // 1件も取れていなくてエラーが記録されている人は、いちばん下の「取得不可」にまとめて選べなくする
      if (!a.posts && a.error) {
        if (a.active) blocked.push(a);
        return;
      }
      var sec = a.active ? a.section : "以前の対象";
      if (!groups[sec]) { groups[sec] = document.createElement("optgroup"); groups[sec].label = sec; order.push(sec); }
      var o = document.createElement("option");
      o.value = a.username;
      o.textContent = a.name + (a.posts ? "（" + a.posts + "）" : "（未取得）");
      if (!a.posts) o.className = "off";
      groups[sec].appendChild(o);
    });
    order.forEach(function (s) { sel.appendChild(groups[s]); });

    if (!blocked.length) return;
    var g = document.createElement("optgroup");
    g.label = "取得不可（" + blocked.length + "）";
    blocked.forEach(function (a) {
      var o = document.createElement("option");
      o.disabled = true;
      o.textContent = a.name + "（" + reason(a.error) + "）";
      g.appendChild(o);
    });
    sel.appendChild(g);
  }

  /* ---------- 検索語のハイライト ---------- */

  // 検索語を <mark> で囲む(大文字小文字・全角半角の違いは無視)
  function highlight(el, text, q) {
    var words = q.split(/[\s　]+/).filter(Boolean);
    if (!words.length) { el.textContent = text; return; }
    var norm = function (s) { return s.normalize("NFKC").toLowerCase(); };
    // NFKC で長さが変わる文字があるとずれるので、1文字ずつ正規化して元の位置と対応を取る
    var chars = Array.from(text), flat = "", map = [];
    chars.forEach(function (c, i) {
      var n = norm(c);
      for (var k = 0; k < n.length; k++) map.push(i);
      flat += n;
    });
    var hit = chars.map(function () { return false; });
    words.forEach(function (w) {
      w = norm(w);
      for (var i = flat.indexOf(w); i >= 0; i = flat.indexOf(w, i + 1)) {
        for (var k = i; k < i + w.length; k++) hit[map[k]] = true;
      }
    });
    var buf = "", on = false;
    function flush() {
      if (!buf) return;
      if (on) { var m = document.createElement("mark"); m.textContent = buf; el.appendChild(m); }
      else el.appendChild(document.createTextNode(buf));
      buf = "";
    }
    chars.forEach(function (c, i) { if (hit[i] !== on) { flush(); on = hit[i]; } buf += c; });
    flush();
  }

  /* ---------- 一覧 ---------- */

  function row(post, q) {
    var li = document.createElement("li");
    var meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent = post.ts.replace(/-/g, "/");
    li.appendChild(meta);
    var nm = document.createElement("button");
    nm.type = "button";
    nm.className = "name";
    nm.textContent = names[post.account] || post.account;
    nm.title = "このメンバーだけに絞り込む";
    nm.onclick = function () { only(post.account); };
    li.appendChild(nm);
    if (TYPE[post.media_type]) {
      var t = document.createElement("span");
      t.className = "type";
      t.textContent = TYPE[post.media_type];
      li.appendChild(t);
    }
    var a = document.createElement("a");
    a.href = post.permalink;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    if (post.excerpt) highlight(a, post.excerpt, q); else a.textContent = "（本文なし）";
    li.appendChild(a);
    return li;
  }

  function load(more) {
    var my = ++listNo;
    var p = params();
    var q = p.get("q") || "";
    if (more && lastTs) p.set("before", lastTs);
    if (!more) {
      $("list").innerHTML = "";
      lastTs = "";
      // 条件をURLに残して、共有・再読み込みで同じ結果に戻れるようにする
      history.replaceState(null, "", p.toString() ? "?" + p.toString() : location.pathname);
      // 日付の指定があればカレンダーもその月へ
      var f = $("from").value;
      if (f) { calYear = +f.slice(0, 4); calMonth = +f.slice(5, 7); }
      loadCalendar();
    }
    $("status").textContent = "読み込み中…";
    $("more").hidden = true;
    getJson("/api/posts?" + p.toString())
      .then(function (d) {
        if (my !== listNo) return; // 後から出した条件の結果を優先
        d.posts.forEach(function (post) { $("list").appendChild(row(post, q)); });
        if (d.posts.length) lastTs = d.posts[d.posts.length - 1].ts;
        var n = $("list").children.length;
        $("status").textContent = n ? n + "件表示中" : "該当する投稿はありません";
        $("more").hidden = !d.more;
      })
      .catch(function () {
        if (my === listNo) $("status").textContent = "読み込みに失敗しました。時間をおいて再度お試しください。";
      });
  }

  function only(account) {
    options().forEach(function (o) { o.selected = o.value === account; });
    load(false);
    $("f").scrollIntoView({ behavior: "smooth" });
  }

  /* ---------- カレンダー ---------- */

  function drawCalendar(days) {
    var grid = $("cal-grid");
    grid.innerHTML = "";
    $("cal-title").textContent = calYear + "年" + calMonth + "月";
    "日月火水木金土".split("").forEach(function (d) {
      var e = document.createElement("div");
      e.className = "dow";
      e.textContent = d;
      grid.appendChild(e);
    });
    var first = new Date(calYear, calMonth - 1, 1).getDay();
    var last = new Date(calYear, calMonth, 0).getDate();
    var max = 1;
    Object.keys(days || {}).forEach(function (k) { if (days[k] > max) max = days[k]; });
    var now = new Date();
    var today = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate());
    var selDay = $("from").value && $("from").value === $("to").value ? $("from").value : "";
    for (var i = 0; i < first; i++) grid.appendChild(document.createElement("div"));
    for (var d = 1; d <= last; d++) {
      var key = calYear + "-" + pad(calMonth) + "-" + pad(d);
      var n = days ? (days[key] || 0) : 0;
      var b = document.createElement("button");
      b.type = "button";
      b.className = "day" + (n ? " has" : "") + (key === selDay ? " sel" : "") + (key === today ? " today" : "");
      b.innerHTML = "<span>" + d + "</span>" + (n ? '<span class="n">' + n + "</span>" : "");
      if (n) b.style.setProperty("--lv", (n / max).toFixed(2));
      b.disabled = !n && key !== selDay;
      b.setAttribute("aria-label", calMonth + "月" + d + "日 " + n + "件");
      b.onclick = (function (k) { return function () { pickDay(k); }; })(key);
      grid.appendChild(b);
    }
  }

  function loadCalendar() {
    var p = params();
    p.delete("from");
    p.delete("to");
    p.set("ym", calYear + "-" + pad(calMonth));
    drawCalendar(null);
    var my = ++calNo;
    getJson("/api/calendar?" + p.toString())
      .then(function (d) { if (my === calNo) drawCalendar(d.days); })
      .catch(function () {});
  }

  function move(delta) {
    var m = calYear * 12 + (calMonth - 1) + delta;
    calYear = Math.floor(m / 12);
    calMonth = m % 12 + 1;
    loadCalendar();
  }

  function pickDay(key) {
    var on = !($("from").value === key && $("to").value === key);
    $("from").value = $("to").value = on ? key : "";
    load(false);
  }

  function thisMonth() {
    var now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth() + 1;
  }

  /* ---------- 起動 ---------- */

  $("f").addEventListener("submit", function (e) { e.preventDefault(); load(false); });
  $("acc").addEventListener("change", function () { load(false); });
  $("from").addEventListener("change", function () { load(false); });
  $("to").addEventListener("change", function () { load(false); });
  $("more").addEventListener("click", function () { load(true); });
  $("reset").addEventListener("click", function () {
    options().forEach(function (o) { o.selected = false; });
    $("from").value = $("to").value = $("q").value = "";
    thisMonth();
    load(false);
  });
  document.querySelectorAll("[data-move]").forEach(function (b) {
    b.addEventListener("click", function () { move(+b.getAttribute("data-move")); });
  });

  getJson("/api/accounts")
    .then(function (d) {
      fillAccounts(d.accounts);
      if (d.latest) $("latest").textContent = "いちばん新しい投稿：" + d.latest.replace(/-/g, "/");
    })
    .catch(function () {})
    .then(function () {
      // URLの条件を復元してから初回表示
      var q = new URLSearchParams(location.search);
      var acc = (q.get("a") || "").split(",");
      options().forEach(function (o) { o.selected = acc.indexOf(o.value) >= 0; });
      $("from").value = q.get("from") || "";
      $("to").value = q.get("to") || "";
      $("q").value = q.get("q") || "";
      thisMonth();
      load(false);
    });
})();
