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
      setText($("summary"), state.unauthorized ? "用「網址/#k=金鑰」開一次就會記住" : "");
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

  // ---------- 抓資料 ----------

  var fetching = false;
  var pendingForce = false;
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

  /** forceHomework：跳過伺服器快取，直接問 Due Now（使用者點了作業數字） */
  function refresh(forceHomework) {
    if (fetching) {
      if (forceHomework) pendingForce = true; // 等手上這次結束再補一次強制的
      return;
    }
    fetching = true;
    var headers = {};
    var token = load(TOKEN_KEY);
    if (token) headers.Authorization = "Bearer " + token;
    fetchWithTimeout("api/glance" + (forceHomework ? "?refresh=homework" : ""), { headers: headers, cache: "no-store" })
      .then(function (res) {
        if (res.status === 401) {
          state.unauthorized = true;
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
        if (forceHomework) endSync();
        if (pendingForce) {
          pendingForce = false;
          refresh(true);
        }
      });
  }

  // ---------- 手動同步作業 ----------

  var SYNC_MIN_MS = 700; // 轉圈至少轉這麼久，太快閃一下反而看不出有沒有同步
  var syncStartedAt = 0;
  var hwButton = $("hw");

  function startSync() {
    if (syncStartedAt) return;
    syncStartedAt = Date.now();
    hwButton.classList.add("syncing");
    refresh(true);
  }

  function endSync() {
    var wait = Math.max(0, SYNC_MIN_MS - (Date.now() - syncStartedAt));
    setTimeout(function () {
      hwButton.classList.remove("syncing");
      syncStartedAt = 0;
    }, wait);
  }

  hwButton.addEventListener("click", startSync);

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
