// 看一眼：前端只負責顯示。資料都由 /api/glance 整理好。
// 刻意寫成不需要打包、舊手機瀏覽器也跑得動的 JS（不用 ?. 與 ??）。
(function () {
  "use strict";

  var STAGE_W = 844;
  var STAGE_H = 390;
  var POLL_MS = 60 * 1000; // 伺服器端各自快取（天氣 15 分、作業 1 分、行事曆 5 分），這裡只是來拿
  var STALE_AFTER_MS = 2.5 * 60 * 1000; // 超過這麼久沒拿到新資料就標「X 分鐘前更新」
  var WEATHER_STALE_MS = 45 * 60 * 1000; // 伺服器那邊天氣太久沒更新也要標
  var SHIFT_EVERY_MS = 3 * 60 * 1000; // 防烙印：每 3 分鐘整個畫面挪一點
  var BACK_TO_FIRST_MS = 2 * 60 * 1000; // 停在第二頁太久就回常駐頁

  var TOKEN_KEY = "glance.token";
  var CACHE_KEY = "glance.last";
  var WEEKDAYS = ["週日", "週一", "週二", "週三", "週四", "週五", "週六"];

  var $ = function (id) { return document.getElementById(id); };

  // ---------- 儲存（私密模式下 localStorage 可能會丟錯） ----------

  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, value); } catch (e) { /* 存不了就算了 */ }
  }

  // 第一次用 https://…/#k=金鑰 開，之後記在這台手機上
  (function takeTokenFromHash() {
    var m = location.hash.match(/[#&]k=([^&]+)/);
    if (m) {
      save(TOKEN_KEY, decodeURIComponent(m[1]));
      history.replaceState(null, "", location.pathname + location.search);
    }
  })();

  // ---------- 狀態 ----------

  var state = {
    data: null, // 最後一筆成功的 /api/glance 回應
    lastOkAt: 0, // 前端最後一次成功拿到資料的時間
    unauthorized: false,
  };

  try {
    var cached = JSON.parse(load(CACHE_KEY) || "null");
    if (cached && cached.data) {
      state.data = cached.data;
      state.lastOkAt = cached.at || 0;
    }
  } catch (e) { /* 壞掉的快取就丟掉 */ }

  // ---------- 小工具 ----------

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  /** 台北時間的欄位（台灣沒有日光節約時間，固定 +8） */
  function tp(ms) {
    var d = new Date(ms + 8 * 3600 * 1000);
    return {
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      weekday: d.getUTCDay(),
    };
  }

  function el(tag, className, text) {
    var e = document.createElement(tag);
    if (className) e.className = className;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function setText(node, text) {
    if (node.textContent !== text) node.textContent = text;
  }

  function each(selector, fn) {
    var list = document.querySelectorAll(selector);
    for (var i = 0; i < list.length; i++) fn(list[i]);
  }

  // ---------- 畫面 ----------

  function renderClock(now) {
    var p = tp(now);
    var text = p.month + "/" + p.day + " " + WEEKDAYS[p.weekday] + "　" + pad2(p.hour) + ":" + pad2(p.minute);
    each(".clock", function (n) { setText(n, text); });
  }

  function staleText(now) {
    var d = state.data;
    var ages = [];
    if (state.lastOkAt && now - state.lastOkAt > STALE_AFTER_MS) ages.push(now - state.lastOkAt);
    var w = d && d.sources && d.sources.weather;
    if (w && w.updatedAt && now - w.updatedAt > WEATHER_STALE_MS) ages.push(now - w.updatedAt);
    if (!ages.length) return "";
    var minutes = Math.floor(Math.max.apply(null, ages) / 60000);
    if (minutes >= 120) return "　" + Math.floor(minutes / 60) + " 小時前更新";
    return "　" + minutes + " 分鐘前更新";
  }

  function renderStale(now) {
    var text = staleText(now);
    each(".stale", function (n) { setText(n, text); });
  }

  function renderWeather(w) {
    if (!w) {
      setText($("headline"), state.unauthorized ? "需要金鑰" : "還沒有天氣資料");
      setText($("summary"), state.unauthorized ? "在跳出來的框裡貼上金鑰" : "");
      return;
    }
    setText($("headline"), w.headline);
    setText($("summary"), w.summary);

    var pill = $("utci-pill");
    if (w.utci) {
      setText($("utci-value"), w.utci.value + "°");
      pill.hidden = false;
      pill.className = "pill u" + w.utci.level;
      setText(pill, w.utci.label);
    } else {
      setText($("utci-value"), "--");
      pill.hidden = true;
    }

    var bars = $("bars");
    var ticks = $("ticks");
    clear(bars);
    clear(ticks);
    w.rain24.forEach(function (b) {
      var bar = el("div", "bar r" + b.level);
      var ratio = b.mm === null ? 0 : Math.min(b.mm, 16) / 16;
      bar.style.height = (ratio * 100).toFixed(1) + "%"; // 最低 4px 由 CSS 的 min-height 管
      bars.appendChild(bar);
      ticks.appendChild(el("div", "tick", b.label));
    });

    renderWeek(w.week);
    if (!sheet.hidden) renderUtciSheet();
  }

  function renderWeek(week) {
    var hours = $("week-hours");
    if (!hours.firstChild) {
      for (var h = 5; h <= 20; h++) {
        hours.appendChild(el("div", "hour-label", (h - 5) % 3 === 0 ? pad2(h) : ""));
      }
    }
    var rows = $("week-rows");
    clear(rows);
    week.forEach(function (d) {
      var row = el("div", "week-row" + (d.dim ? " dim" : ""));
      var label = el("div", "day-label");
      label.appendChild(el("span", "day-name", d.name));
      label.appendChild(el("span", "day-date", d.date));
      row.appendChild(label);
      var cells = el("div", "cells");
      d.cells.forEach(function (level) { cells.appendChild(el("div", "cell r" + level)); });
      row.appendChild(cells);
      row.appendChild(el("div", "day-utci" + (d.utci ? " u" + d.utci.level : ""), d.utci ? d.utci.value + "°" : "--"));
      rows.appendChild(row);
    });
  }

  function renderHomework(hw) {
    setText($("hw-today"), hw ? String(hw.today) : "–");
    setText($("hw-soon"), hw ? String(hw.within3Days) : "–");
  }

  function eventRow(e, now) {
    var row = el("div", "event" + (e.end <= now ? " past" : ""));
    row.appendChild(el("span", "event-time" + (/^\d/.test(e.time) ? "" : " wide"), e.time));
    row.appendChild(el("span", "event-title", e.title));
    return row;
  }

  function renderCalendar(cal, now) {
    var today = $("cal-today");
    var tomorrow = $("cal-tomorrow");
    clear(today);
    clear(tomorrow);
    if (!cal) {
      today.appendChild(el("div", "events-empty", "—"));
      tomorrow.appendChild(el("div", "events-empty", "—"));
      return;
    }

    // 放不下時：先拿掉今天已經過去的（從最早的開始），再從明天的最後面砍，補一行「還有 N 個」
    var todayList = cal.today.slice();
    var tomorrowList = cal.tomorrow.slice();
    var hidden = 0;
    var side = $("side");

    function draw() {
      clear(today);
      clear(tomorrow);
      if (!todayList.length) today.appendChild(el("div", "events-empty", "沒有行程"));
      todayList.forEach(function (e) { today.appendChild(eventRow(e, now)); });
      if (!tomorrowList.length && !hidden) tomorrow.appendChild(el("div", "events-empty", "沒有行程"));
      tomorrowList.forEach(function (e) { tomorrow.appendChild(eventRow(e, now)); });
      if (hidden) tomorrow.appendChild(el("div", "events-more", "還有 " + hidden + " 個"));
    }

    draw();
    for (var guard = 0; guard < 50 && side.scrollHeight > side.clientHeight + 1; guard++) {
      var pastIndex = -1;
      for (var i = 0; i < todayList.length; i++) {
        if (todayList[i].end <= now) { pastIndex = i; break; }
      }
      if (pastIndex >= 0) todayList.splice(pastIndex, 1);
      else if (tomorrowList.length) { tomorrowList.pop(); hidden++; }
      else if (todayList.length > 1) todayList.pop();
      else break;
      draw();
    }
  }

  function render() {
    var now = Date.now();
    var d = state.data;
    renderClock(now);
    renderStale(now);
    renderWeather(d && d.weather);
    renderHomework(d && d.homework);
    renderCalendar(d && d.calendar, now);
  }

  // ---------- 今天每小時 UTCI：點 UTCI 跳出的折線圖 ----------

  var SVG_NS = "http://www.w3.org/2000/svg";
  var CHART_W = 620;
  var CHART_H = 230;
  var PAD = { left: 30, right: 12, top: 18, bottom: 22 };
  var HEAT_LABELS = ["無熱壓力", "中度熱壓力", "強熱壓力", "非常強熱壓力"];
  var HEAT_BANDS = [[26, 32, 1], [32, 38, 2], [38, Infinity, 3]]; // [下限, 上限, 分級]

  var sheet = $("utci-sheet");
  var chart = $("utci-chart");
  var sheetTimer = null;
  var picked = null; // 手指點到的那個整點（0–23）；null 就顯示「現在」

  function svg(tag, attrs, parent) {
    var e = document.createElementNS(SVG_NS, tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(e);
    return e;
  }

  function svgText(parent, x, y, text, anchor, className) {
    var t = svg("text", { x: x, y: y, "text-anchor": anchor || "middle" }, parent);
    if (className) t.setAttribute("class", className);
    t.textContent = text;
    return t;
  }

  /** 現在是今天第幾小時（帶小數，台北時間） */
  function hourOfDay(now) {
    var p = tp(now);
    return p.hour + p.minute / 60;
  }

  function fmt1(v) { return v.toFixed(1) + "°"; }

  function openUtciSheet() {
    picked = null;
    sheet.hidden = false;
    renderUtciSheet();
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(closeUtciSheet, BACK_TO_FIRST_MS); // 常駐看板，開著忘了關也會自己收
  }

  function closeUtciSheet() {
    clearTimeout(sheetTimer);
    sheet.hidden = true;
  }

  function renderUtciSheet() {
    var w = state.data && state.data.weather;
    var hours = (w && w.utciToday) || [];
    var now = Date.now();
    clear(chart);
    chart.setAttribute("viewBox", "0 0 " + CHART_W + " " + CHART_H);

    var values = [];
    hours.forEach(function (h) { if (h.value !== null) values.push(h.value); });
    if (!values.length) {
      setText($("utci-sheet-sub"), "");
      setText($("utci-readout"), "");
      svgText(chart, CHART_W / 2, CHART_H / 2, "還沒有今天的 UTCI 資料", "middle", "empty");
      return;
    }

    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var lo = Math.floor((min - 1) / 5) * 5;
    var hi = Math.ceil((max + 1) / 5) * 5;
    if (hi - lo < 10) hi = lo + 10;
    var plotW = CHART_W - PAD.left - PAD.right;
    var plotH = CHART_H - PAD.top - PAD.bottom;
    var x = function (h) { return PAD.left + (h / 23) * plotW; };
    var y = function (v) { return PAD.top + ((hi - v) / (hi - lo)) * plotH; };

    // 熱壓力分級的底色帶
    HEAT_BANDS.forEach(function (b) {
      var top = Math.min(b[1], hi);
      var bottom = Math.max(b[0], lo);
      if (top <= bottom) return;
      svg("rect", { x: PAD.left, y: y(top), width: plotW, height: y(bottom) - y(top), "class": "band" + b[2] }, chart);
    });

    // 格線：每 5 度一條；時間每 3 小時一個標籤
    for (var v = lo; v <= hi; v += 5) {
      svg("line", { x1: PAD.left, x2: CHART_W - PAD.right, y1: y(v), y2: y(v), "class": "grid" }, chart);
      svgText(chart, PAD.left - 6, y(v) + 4, String(v), "end");
    }
    for (var h = 0; h < 24; h += 3) svgText(chart, x(h), CHART_H - 6, pad2(h));

    // 折線：沒資料的小時斷開；現在以前畫淡
    var d = "";
    var pen = false;
    hours.forEach(function (p, i) {
      if (p.value === null) { pen = false; return; }
      d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(p.value).toFixed(1);
      pen = true;
    });
    var nowH = hourOfDay(now);
    var nowX = x(Math.min(nowH, 23));
    var defs = svg("defs", {}, chart);
    var pastClip = svg("clipPath", { id: "utci-past" }, defs);
    svg("rect", { x: 0, y: 0, width: nowX, height: CHART_H }, pastClip);
    var futureClip = svg("clipPath", { id: "utci-future" }, defs);
    svg("rect", { x: nowX, y: 0, width: CHART_W - nowX, height: CHART_H }, futureClip);
    svg("path", { d: d, "class": "line line-past", "clip-path": "url(#utci-past)" }, chart);
    svg("path", { d: d, "class": "line line-future", "clip-path": "url(#utci-future)" }, chart);

    // 「現在」的虛線
    svg("line", { x1: nowX, x2: nowX, y1: PAD.top, y2: PAD.top + plotH, "class": "now-line" }, chart);
    svgText(chart, nowX, PAD.top - 6, "現在");

    // 每小時一個點，顏色是那小時的熱壓力分級；現在以前的一樣畫淡
    hours.forEach(function (p, i) {
      if (p.value === null) return;
      svg("circle", { cx: x(i), cy: y(p.value), r: 4, "class": "dot u" + p.level + (i < nowH ? " past" : "") }, chart);
    });

    // 最高的那一小時直接標數字
    var maxH = -1;
    hours.forEach(function (p, i) { if (p.value === max && maxH < 0) maxH = i; });
    var minH = -1;
    hours.forEach(function (p, i) { if (p.value === min && minH < 0) minH = i; });
    var maxLabelX = Math.max(PAD.left + 24, Math.min(CHART_W - PAD.right - 24, x(maxH)));
    svgText(chart, maxLabelX, y(max) - 10, fmt1(max), "middle", "mark");

    setText($("utci-sheet-sub"),
      "最高 " + fmt1(max) + "（" + pad2(maxH) + ":00）　最低 " + fmt1(min) + "（" + pad2(minH) + ":00）");

    // 右上角讀數：沒點就是「現在」（跟主畫面同一個內插值），點了就是那一小時＋十字線
    var readout = $("utci-readout");
    clear(readout);
    if (picked === null) {
      var a = hours[Math.floor(nowH)];
      var b = hours[Math.floor(nowH) + 1];
      var f = nowH - Math.floor(nowH);
      var at = null;
      if (a && a.value !== null && b && b.value !== null) at = a.value + (b.value - a.value) * f;
      else if (a && a.value !== null) at = a.value;
      if (at !== null) svg("circle", { cx: nowX, cy: y(at), r: 6, "class": "dot u" + (w.utci ? w.utci.level : 0) }, chart);
      readout.appendChild(document.createTextNode("現在"));
      readout.appendChild(el("b", "", w.utci ? w.utci.value + "°" : "--"));
      if (w.utci) readout.appendChild(document.createTextNode(w.utci.label));
      return;
    }
    var p = hours[picked];
    readout.appendChild(document.createTextNode(pad2(picked) + ":00"));
    if (p && p.value !== null) {
      svg("line", { x1: x(picked), x2: x(picked), y1: PAD.top, y2: PAD.top + plotH, "class": "cross" }, chart);
      svg("circle", { cx: x(picked), cy: y(p.value), r: 6, "class": "dot u" + p.level }, chart);
      readout.appendChild(el("b", "", fmt1(p.value)));
      readout.appendChild(document.createTextNode(HEAT_LABELS[p.level]));
    } else {
      readout.appendChild(el("b", "", "--"));
    }
  }

  /** 手指在圖上點或拖，跳到最近的整點 */
  function pickHour(e) {
    var rect = chart.getBoundingClientRect();
    if (!rect.width) return;
    var px = ((e.clientX - rect.left) / rect.width) * CHART_W;
    var h = Math.round(((px - PAD.left) / (CHART_W - PAD.left - PAD.right)) * 23);
    h = Math.max(0, Math.min(23, h));
    if (h === picked) return;
    picked = h;
    renderUtciSheet();
  }

  $("utci-open").addEventListener("click", openUtciSheet);
  $("utci-close").addEventListener("click", closeUtciSheet);
  sheet.addEventListener("click", function (e) {
    if (e.target === sheet) closeUtciSheet(); // 點視窗外面關掉
  });
  chart.addEventListener("pointerdown", function (e) {
    pickHour(e);
    clearTimeout(sheetTimer);
    sheetTimer = setTimeout(closeUtciSheet, BACK_TO_FIRST_MS);
  });
  chart.addEventListener("pointermove", function (e) {
    if (e.pointerType === "mouse" || e.buttons) pickHour(e);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeUtciSheet();
  });

  // ---------- 抓資料 ----------

  var fetching = false;
  var pendingForce = {}; // 等手上這次結束再補的強制重抓：{ homework: true, weather: true }
  var FETCH_TIMEOUT_MS = 20 * 1000;

  function fetchWithTimeout(url, options) {
    return new Promise(function (resolve, reject) {
      var timer = setTimeout(function () { reject(new Error("timeout")); }, FETCH_TIMEOUT_MS);
      fetch(url, options).then(
        function (res) { clearTimeout(timer); resolve(res); },
        function (err) { clearTimeout(timer); reject(err); }
      );
    });
  }

  /** force："homework" 或 "weather"，跳過伺服器快取直接重抓那個來源（使用者點了同步） */
  function refresh(force) {
    if (fetching) {
      if (force) pendingForce[force] = true;
      return;
    }
    fetching = true;
    var headers = {};
    var token = load(TOKEN_KEY);
    if (token) headers.Authorization = "Bearer " + token;
    fetchWithTimeout("api/glance" + (force ? "?refresh=" + force : ""), { headers: headers, cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) {
          state.unauthorized = true;
          showKeyForm(load(TOKEN_KEY) ? "金鑰不對，請再貼一次" : "");
          throw new Error("401");
        }
        if (!res.ok) throw new Error(String(res.status));
        return res.json();
      })
      .then(function (data) {
        state.unauthorized = false;
        state.data = data;
        state.lastOkAt = Date.now();
        save(CACHE_KEY, JSON.stringify({ data: data, at: state.lastOkAt }));
      })
      .catch(function () { /* 斷線就繼續顯示最後一筆，render 會標出多久前更新 */ })
      .then(function () {
        fetching = false;
        render();
        if (force) syncers[force].end();
        for (var next in pendingForce) {
          delete pendingForce[next];
          refresh(next);
          return;
        }
      });
  }

  // ---------- 輸入金鑰 ----------
  // 加入主畫面的 App（尤其 iPhone）跟瀏覽器的儲存空間分開，網址帶的金鑰過不去，所以在這裡讓人貼。

  var keyForm = $("key-form");
  var keyInput = $("key-input");
  var keyPaste = $("key-paste");

  /** 貼的可能是金鑰本身，也可能是整串「…/#k=金鑰」網址 */
  function extractKey(text) {
    var m = String(text).match(/[#&?]k=([^&\s]+)/);
    return (m ? decodeURIComponent(m[1]) : String(text)).trim();
  }

  function showKeyForm(error) {
    setText($("key-error"), error || "");
    if (keyForm.hidden) {
      keyForm.hidden = false;
      keyInput.value = "";
    }
  }

  keyForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var key = extractKey(keyInput.value);
    if (!key) return;
    save(TOKEN_KEY, key);
    keyInput.blur();
    keyForm.hidden = true;
    refresh();
  });

  if (navigator.clipboard && navigator.clipboard.readText) {
    keyPaste.hidden = false;
    keyPaste.addEventListener("click", function () {
      navigator.clipboard.readText().then(function (text) {
        keyInput.value = extractKey(text);
      }).catch(function () {
        setText($("key-error"), "讀不到剪貼簿，請長按輸入框貼上");
      });
    });
  }

  // ---------- 手動同步：點作業數字重抓作業、點「未來一週」重抓天氣 ----------

  var SYNC_MIN_MS = 700; // 轉圈至少轉這麼久，太快閃一下反而看不出有沒有同步

  function makeSyncer(button, source) {
    var startedAt = 0;
    button.addEventListener("click", function () {
      if (startedAt) return; // 轉圈中再點不重送
      startedAt = Date.now();
      button.classList.add("syncing");
      refresh(source);
    });
    return {
      end: function () {
        var wait = Math.max(0, SYNC_MIN_MS - (Date.now() - startedAt));
        setTimeout(function () {
          button.classList.remove("syncing");
          startedAt = 0;
        }, wait);
      },
    };
  }

  var syncers = {
    homework: makeSyncer($("hw"), "homework"),
    weather: makeSyncer($("week-refresh"), "weather"),
  };

  // ---------- 版面：縮放、防烙印、換頁 ----------

  function fit() {
    var scale = Math.min(window.innerWidth / STAGE_W, window.innerHeight / STAGE_H);
    document.documentElement.style.setProperty("--scale", String(scale));
  }

  // 繞一圈小位移，最多偏 4px（設計稿座標）
  var SHIFTS = [[0, 0], [3, 2], [-2, 3], [-4, -1], [2, -3], [4, 1], [-3, -3], [1, 4]];
  var shiftIndex = 0;
  function shift() {
    shiftIndex = (shiftIndex + 1) % SHIFTS.length;
    var root = document.documentElement.style;
    root.setProperty("--shift-x", SHIFTS[shiftIndex][0] + "px");
    root.setProperty("--shift-y", SHIFTS[shiftIndex][1] + "px");
  }

  var pager = $("pager");
  var backTimer = null;
  pager.addEventListener("scroll", function () {
    clearTimeout(backTimer);
    if (pager.scrollLeft > pager.clientWidth / 2) {
      backTimer = setTimeout(function () { pager.scrollTo({ left: 0, behavior: "smooth" }); }, BACK_TO_FIRST_MS);
    }
  }, { passive: true });

  document.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight") pager.scrollTo({ left: pager.clientWidth, behavior: "smooth" });
    if (e.key === "ArrowLeft") pager.scrollTo({ left: 0, behavior: "smooth" });
  });

  // ---------- 全螢幕、螢幕不休眠 ----------

  var wakeLock = null;
  function requestWakeLock() {
    if (!("wakeLock" in navigator) || document.visibilityState !== "visible" || wakeLock) return;
    navigator.wakeLock.request("screen").then(function (lock) {
      wakeLock = lock;
      lock.addEventListener("release", function () { wakeLock = null; });
    }).catch(function () { /* 沒電模式或不支援 */ });
  }

  function goFullscreen() {
    var root = document.documentElement;
    var isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (!isFull) {
      var req = root.requestFullscreen || root.webkitRequestFullscreen;
      if (req) {
        var p = req.call(root, { navigationUI: "hide" });
        if (p && p.then) {
          p.then(function () {
            if (screen.orientation && screen.orientation.lock) {
              screen.orientation.lock("landscape").catch(function () {});
            }
          }).catch(function () {});
        }
      }
    }
    requestWakeLock();
  }

  // 全螢幕一定要使用者點一下才能開
  document.addEventListener("click", goFullscreen);

  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") {
      requestWakeLock();
      refresh();
    }
  });

  window.addEventListener("resize", fit);
  window.addEventListener("orientationchange", fit);

  // ---------- 開始 ----------

  fit();
  render();
  refresh();
  requestWakeLock();
  setInterval(refresh, POLL_MS);
  // 時鐘與「已經過去的行程」每 15 秒對一次
  setInterval(function () {
    var now = Date.now();
    renderClock(now);
    renderStale(now);
  }, 15 * 1000);
  setInterval(function () {
    var d = state.data;
    renderCalendar(d && d.calendar, Date.now());
  }, 60 * 1000);
  setInterval(shift, SHIFT_EVERY_MS);

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch(function () {});
  }
})();
