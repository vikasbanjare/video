/*
 * CutPilot — One-Click Organizer (panel logic).
 * Self-contained: drives the "Organize" tab, loads jsx/organize.jsx via the
 * existing CutPilot CEP bridge (window.CPBridge), and renders results.
 * Adds nothing global except the IIFE; never depends on CutPilot's main.js.
 */
(function () {
  "use strict";

  var jsxLoaded = false;

  var ORDER = [
    "Sequences", "Video", "Images & Photos", "Audio", "Graphics & Titles",
    "Captions & Subtitles", "Adjustment & Generated Media", "LUTs & Presets",
    "Project & Data Files", "Other"
  ];
  var SWATCH = {
    "Sequences": "#8b87f5", "Video": "#5b9bd5", "Images & Photos": "#4ec5c1",
    "Audio": "#5fc28a", "Graphics & Titles": "#d98fb0", "Captions & Subtitles": "#d6b06a",
    "Adjustment & Generated Media": "#b08ad6", "LUTs & Presets": "#8a93a3",
    "Project & Data Files": "#8a93a3", "Other": "#6b7280"
  };

  function bridge() { return window.CPBridge; }

  function cleanPath(p) {
    if (!p) return "";
    p = String(p).replace(/\\/g, "/").replace(/^file:\/+/, "/");
    p = p.replace(/^\/([A-Za-z]:)/, "$1"); // windows drive
    return p.replace(/\/+$/, "");
  }

  function loadJsx(cb) {
    var b = bridge();
    if (!b || !b.rawEval) { if (cb) cb(false); return; }
    var root = cleanPath(b.getExtensionPath ? b.getExtensionPath() : "");
    if (!root) { if (cb) cb(false); return; }
    b.rawEval('$.evalFile("' + root + '/jsx/organize.jsx")', function () {
      jsxLoaded = true;
      if (cb) cb(true);
    });
  }

  function activateTab() {
    var tabs = document.querySelectorAll(".tab");
    for (var i = 0; i < tabs.length; i++) tabs[i].classList.remove("active");
    var pages = document.querySelectorAll(".tab-page");
    for (var j = 0; j < pages.length; j++) pages[j].classList.remove("active");
    var btn = document.querySelector('.tab[data-tab="organize"]');
    var page = document.getElementById("tab-organize");
    if (btn) btn.classList.add("active");
    if (page) page.classList.add("active");
  }

  function setStatus(msg, kind) {
    var el = document.getElementById("cpo-status");
    if (!el) return;
    el.textContent = msg || "";
    el.className = "cpo-status" + (kind ? " " + kind : "");
    el.style.display = msg ? "block" : "none";
  }

  function orderIndex(name) { var i = ORDER.indexOf(name); return i < 0 ? 99 : i; }

  function renderResults(report) {
    var sec = document.getElementById("cpo-results");
    if (!sec) return;
    sec.innerHTML = "";
    if (!report || !report.length) { sec.style.display = "none"; return; }

    var counts = {};
    for (var i = 0; i < report.length; i++) {
      var top = String(report[i].dest || "Other").split("/")[0];
      counts[top] = (counts[top] || 0) + 1;
    }
    var keys = [];
    for (var k in counts) keys.push(k);
    keys.sort(function (a, b) { return orderIndex(a) - orderIndex(b); });

    var head = document.createElement("div");
    head.className = "cpo-results-head";
    var t = document.createElement("span"); t.className = "cpo-results-title"; t.textContent = "Sorted into";
    var m = document.createElement("span"); m.className = "cpo-results-meta";
    m.textContent = report.length + (report.length === 1 ? " item" : " items");
    head.appendChild(t); head.appendChild(m);
    sec.appendChild(head);

    var ul = document.createElement("ul"); ul.className = "cpo-cat-list";
    for (var x = 0; x < keys.length; x++) {
      var li = document.createElement("li"); li.className = "cpo-cat-row";
      var sw = document.createElement("span"); sw.className = "cpo-swatch";
      sw.style.background = SWATCH[keys[x]] || "#6b7280";
      var nm = document.createElement("span"); nm.className = "cpo-cat-name"; nm.textContent = keys[x];
      var ct = document.createElement("span"); ct.className = "cpo-cat-count"; ct.textContent = counts[keys[x]];
      li.appendChild(sw); li.appendChild(nm); li.appendChild(ct);
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    sec.style.display = "block";
  }

  function organize() {
    var b = bridge();
    if (!b || !b.isCEP || !b.isCEP()) { setStatus("Open this panel inside Premiere Pro.", "error"); return; }
    var btn = document.getElementById("cpo-run");
    if (btn) { btn.disabled = true; btn.classList.add("busy"); }
    setStatus("Organizing your project…", "working");
    var results = document.getElementById("cpo-results");
    if (results) results.style.display = "none";

    var run = function () {
      b.callHost("CPO_organize").then(function (res) {
        if (res && res.moved > 0) { setStatus("", ""); renderResults(res.report || []); }
        else setStatus((res && res.message) || "Nothing to organize.", "");
        if (btn) { btn.disabled = false; btn.classList.remove("busy"); }
      }).catch(function (err) {
        setStatus(String((err && err.message) || err || "Could not organize this project."), "error");
        if (btn) { btn.disabled = false; btn.classList.remove("busy"); }
      });
    };
    if (jsxLoaded) run(); else loadJsx(function () { run(); });
  }

  function init() {
    var tabBtn = document.querySelector('.tab[data-tab="organize"]');
    if (tabBtn) tabBtn.addEventListener("click", function () { activateTab(); if (!jsxLoaded) loadJsx(); });
    var run = document.getElementById("cpo-run");
    if (run) run.addEventListener("click", organize);
    loadJsx(); // preload host script so the first click is instant
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
