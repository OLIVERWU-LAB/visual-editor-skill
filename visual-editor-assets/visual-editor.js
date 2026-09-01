/* ==========================================================================
   Visual Editor — a Figma-like inspector for this static site.

   Boots only when the URL carries ?edit=1 (or #edit / localStorage flag), so
   the shipped page is untouched: no listeners, no styles, no DOM.

   Workflow (deliberately Figma/Photoshop shaped):
   - Edits apply instantly. There is no "apply" button.
   - Undo/redo (Cmd+Z / Cmd+Shift+Z) via a snapshot history stack.
   - Nothing touches disk until you Save. Cmd+S writes straight into
     grid-overrides.css; "Save as" exports a patch file instead.

   Design constraints that shaped this file:
   - This site is responsive through `cqw` and `%`, not px. Writing px back
     would silently break every breakpoint, so every numeric control keeps
     the property's ORIGINAL unit and converts on the fly.
   - Overrides are keyed by a stable CSS selector, not by DOM node, so they
     survive the project sheet being torn down and re-rendered from JSON.
   - Desktop and <=760px edits are stored in separate scopes and written
     inside the matching @media block.
   ========================================================================== */

(function () {
  "use strict";

  // ---------------------------------------------------------------- config

  var MOBILE_BREAKPOINT = 760;
  var STORE_KEY = "ve:overrides:v1";
  var PANEL_POS_KEY = "ve:panelpos:v1";
  var BAR_POS_KEY = "ve:barpos:v1";
  var SAVED_KEY = "ve:savedsnapshot:v1";
  var ISOLATE_KEY = "ve:isolate:v1";

  var TARGET_CSS = "grid-overrides.css";

  /* Stable identifiers. The signature lets any agent recognise a patch from
     this tool on sight; the sentinels let the loader be located and removed
     mechanically. Do not reword these casually — other tooling matches them. */
  var PATCH_SIGNATURE = "VISUAL-EDITOR-PATCH";
  var PATCH_FORMAT = "ve-patch/1";
  var LOADER_SENTINEL = "VE-LOADER:BEGIN";
  var LOADER_SENTINEL_END = "<!-- VE-LOADER:END -->";

  /* Everything the editor writes lives between these markers, so saving
     repeatedly replaces one managed block instead of appending forever. */
  var BLOCK_BEGIN = "/* === VE:BEGIN — visual editor output. Managed block: edits here are overwritten on next save. === */";
  var BLOCK_END = "/* === VE:END === */";

  var HISTORY_LIMIT = 100;
  var MERGE_WINDOW = 500; // ms — same property keeps collapsing into one step

  /* The editor is site-wide by default: any element on any page is fair game,
     which is what makes this reusable across projects. Only the editor's own
     chrome and a few structural roots are off limits. */
  var SKIP_TAGS = /^(html|body|script|style|link|meta|title|head|noscript)$/i;

  /* Things a designer thinks of as one object. A single click resolves to the
     nearest of these; double-click drills inside. */
  var COMPONENT_SELECTOR = [
    "a", "button", "[role=button]", "label", "li",
    "figure", "article", "picture", "video",
    "[class*=card]", "[class*=btn]", "[class*=button]", "[class*=item]", "[class*=tile]"
  ].join(",");

  // Never select the editor's own chrome, or structural wrappers that would
  // be meaningless/dangerous to restyle.
  var BLOCKLIST = [
    "html", "body", ".ve-panel", ".ve-panel *", ".ve-bar", ".ve-bar *",
    ".ve-status", ".ve-status *", ".ve-modal", ".ve-modal *",
    ".ve-handles", ".ve-handles *", ".ve-toast"
  ].join(",");

  function shouldBoot() {
    var qs = new URLSearchParams(location.search);
    if (qs.get("edit") === "1") return true;
    if (qs.get("edit") === "0") {
      try { localStorage.removeItem("ve:enabled"); } catch (e) {}
      return false;
    }
    if (location.hash === "#edit") return true;
    try { return localStorage.getItem("ve:enabled") === "1"; } catch (e) { return false; }
  }

  if (!shouldBoot()) return;
  try { localStorage.setItem("ve:enabled", "1"); } catch (e) {}

  // ---------------------------------------------------------------- state

  var state = {
    selected: null,
    inlinedSvg: {},         // selector -> source url (img was swapped for <svg>)
    styleEl: null,
    panel: null,
    body: null,
    bar: null,
    handles: null,
    dragging: false,
    dirHandle: null,        // File System Access directory handle
    collapsed: {},          // groupKey -> true (per-element panel fold state)
    mode: "select",         // "select" | "browse"
    minimised: false,
    editingText: null,      // { el, original } while typing in the page
    isolate: loadIsolate(), // uniquePath -> true, "only this one" choices
    siblingRing: null,      // { items, index } while cycling siblings
    historyPanel: null,
    historyOutside: null,   // capture-phase click-away handler while open

    /* History is an operation LOG, not a stack of snapshots. Every entry knows
       the value before and after, so any single entry can be muted (eye) or
       deleted and the outcome recomputed by replaying the rest. A snapshot
       stack could only ever unwind from the top, which is not enough for the
       history list. */
    log: loadLog(),
    logIndex: -1,           // newest applied entry; -1 means "nothing applied"
    overrides: { desktop: {}, mobile: {} },
    savedSnapshot: null,
    lastTouch: 0,
    lastKey: "",
    nextId: 1
  };

  state.logIndex = state.log.length - 1;
  state.nextId = state.log.reduce(function (m, e) {
    return Math.max(m, e.id || 0);
  }, 0) + 1;
  rebuild();
  state.savedSnapshot = loadSavedSnapshot();

  function scope() {
    return window.innerWidth <= MOBILE_BREAKPOINT ? "mobile" : "desktop";
  }

  function loadLog() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && Array.isArray(parsed.log)) return parsed.log;
    } catch (e) {}
    return [];
  }

  function loadIsolate() {
    try {
      var raw = localStorage.getItem(ISOLATE_KEY);
      var parsed = raw ? JSON.parse(raw) : null;
      if (parsed && typeof parsed === "object") return parsed;
    } catch (e) {}
    return {};
  }

  function loadSavedSnapshot() {
    try {
      var v = localStorage.getItem(SAVED_KEY);
      if (v) return v;
    } catch (e) {}
    // No save on record: treat what we restored as the clean baseline.
    return snapshot();
  }

  /* Replay the log into the flat override map the renderer and panel read.
     Entries beyond the undo pointer, or muted with the eye, are skipped. */
  function rebuild() {
    var next = { desktop: {}, mobile: {} };
    for (var i = 0; i <= state.logIndex && i < state.log.length; i++) {
      var e = state.log[i];
      if (!e || e.hidden) continue;
      if (e.kind === "insert" || e.kind === "text" || e.kind === "attr") continue;  // handled below
      applyEntry(next, e);
    }
    state.overrides = next;
    syncInsertions();
    syncTextEdits();
    syncAttrEdits();
  }

  /* Inserted elements are the one thing the editor adds that CSS cannot
     express, so they live in the log as markup and are re-materialised here.
     Going through rebuild() means uploads are undoable and can be muted with
     the eye exactly like any other change. */
  function syncInsertions() {
    var wanted = {};
    for (var i = 0; i <= state.logIndex && i < state.log.length; i++) {
      var e = state.log[i];
      if (!e || e.hidden || e.kind !== "insert") continue;
      wanted[e.id] = e;
    }

    // Drop nodes whose entry is gone, undone or muted.
    [].forEach.call(document.querySelectorAll("[data-ve-inserted]"), function (node) {
      var id = parseInt(node.getAttribute("data-ve-inserted"), 10);
      if (!wanted[id]) {
        if (state.selected === node) deselect();
        node.remove();
      }
    });

    Object.keys(wanted).forEach(function (id) {
      if (document.querySelector('[data-ve-inserted="' + id + '"]')) return;
      materialiseInsert(wanted[id]);
    });
  }

  function materialiseInsert(entry) {
    var host = document.querySelector(entry.parentSel);
    if (!host) return;   // target not on screen yet; retried on the next rebuild

    var holder = document.createElement("div");
    holder.innerHTML = entry.html;
    var node = holder.firstElementChild;
    if (!node) return;

    node.setAttribute("data-ve-inserted", entry.id);
    host.appendChild(node);
    return node;
  }

  function insertedRecordFor(el) {
    if (!el || !el.hasAttribute || !el.hasAttribute("data-ve-inserted")) return null;
    var id = parseInt(el.getAttribute("data-ve-inserted"), 10);
    for (var i = 0; i < state.log.length; i++) {
      if (state.log[i].id === id) return state.log[i];
    }
    return null;
  }

  function applyEntry(map, e) {
    var bucket = map[e.scope] || (map[e.scope] = {});
    var target = bucket[e.sel] || (bucket[e.sel] = {});

    if (e.after === null || e.after === "") delete target[e.prop];
    else target[e.prop] = e.after;

    if (!Object.keys(target).length) delete bucket[e.sel];
  }

  /* Session persistence is a crash net, not the save action. */
  function persistSession() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({ log: state.log }));
    } catch (e) {}
  }

  function save() {
    persistSession();
    renderStyle();
    updateBar();
    if (state.historyPanel) renderHistory();
  }

  /* "1 change" not "1 changes" — the count is user-facing in three places. */
  function plural(n, word) {
    return n + " " + word + (n === 1 ? "" : "s");
  }

  /* Micro-icons for the inspector. Each is drawn symmetrically about (8,8) of a
     16×16 viewBox so a column of them lines up exactly — text glyphs like "×"
     and "+" have different side bearings and optical centres, which is why they
     always looked ragged next to each other. */
  var CROSS_SVG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" aria-hidden="true"><path d="M4.5 4.5l7 7M11.5 4.5l-7 7"/></svg>';
  var PLUS_SVG =
    '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
      'stroke-linecap="round" aria-hidden="true"><path d="M8 4v8M4 8h8"/></svg>';
  var CARET_DOWN_SVG =
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M3.6 6.2h8.8L8 10.9z"/></svg>';
  var CARET_RIGHT_SVG =
    '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">' +
      '<path d="M6.2 3.6v8.8L10.9 8z"/></svg>';

  function countEdits() {
    var n = 0;
    ["desktop", "mobile"].forEach(function (s) {
      Object.keys(state.overrides[s] || {}).forEach(function (sel) {
        n += Object.keys(state.overrides[s][sel]).length;
      });
    });
    // Insertions and text edits carry no declarations but are unsaved work.
    for (var i = 0; i <= state.logIndex && i < state.log.length; i++) {
      var e = state.log[i];
      if (e && !e.hidden && (e.kind === "insert" || e.kind === "text" || e.kind === "attr")) n++;
    }
    return n;
  }

  // -------------------------------------------------------------- history

  /* The dirty comparison must cover insertions and text edits too, and those
     live only in the log — not in the override map. */
  function snapshot() {
    var extra = [];
    for (var i = 0; i <= state.logIndex && i < state.log.length; i++) {
      var e = state.log[i];
      if (!e || e.hidden) continue;
      if (e.kind === "insert") extra.push("i" + e.id + ":" + e.parentSel + ":" + e.html);
      else if (e.kind === "text") extra.push("t" + e.sel + ":" + e.after);
      else if (e.kind === "attr") extra.push("a" + e.sel + ":" + e.prop + ":" + e.after);
    }
    return JSON.stringify({ o: state.overrides, x: extra });
  }

  function isDirty() {
    return snapshot() !== state.savedSnapshot;
  }

  /* Record a change. `key` identifies the control in play: repeated hits on
     the same key inside MERGE_WINDOW rewrite the last entry instead of adding
     a new one, so dragging a slider is one history item, not fifty. */
  function record(sel, prop, after, key, label) {
    var s = scope();
    var now = Date.now();
    var merging = key && key === state.lastKey && (now - state.lastTouch) < MERGE_WINDOW;

    state.lastTouch = now;
    state.lastKey = key || "";

    var last = state.log[state.logIndex];
    if (merging && last && last.sel === sel && last.prop === prop && last.scope === s) {
      last.after = after;
      last.ts = now;
      rebuild();
      save();
      return last;
    }

    // A fresh edit truncates anything that was undone — standard redo semantics.
    if (state.logIndex < state.log.length - 1) {
      state.log.length = state.logIndex + 1;
    }

    var entry = {
      id: state.nextId++,
      ts: now,
      scope: s,
      sel: sel,
      prop: prop,
      before: readEffective(sel, prop, s),
      after: after,
      label: label || null,
      hidden: false
    };

    state.log.push(entry);
    if (state.log.length > HISTORY_LIMIT) state.log.shift();
    state.logIndex = state.log.length - 1;

    rebuild();
    save();
    return entry;
  }

  // Value in force just before a new entry lands (used for the history list).
  function readEffective(sel, prop, s) {
    var bucket = state.overrides[s];
    var cur = bucket && bucket[sel] ? bucket[sel][prop] : undefined;
    return cur === undefined ? null : cur;
  }

  // Force the next record() to start a fresh entry.
  function sealStep() {
    state.lastKey = "";
    state.lastTouch = 0;
  }

  function undo() {
    if (state.logIndex < 0) return toast("Nothing to undo");
    state.logIndex--;
    afterTimeTravel();
  }

  function redo() {
    if (state.logIndex >= state.log.length - 1) return toast("Nothing to redo");
    state.logIndex++;
    afterTimeTravel();
  }

  function afterTimeTravel() {
    sealStep();
    rebuild();
    persistSession();
    renderStyle();
    updateBar();
    if (state.historyPanel) renderHistory();
    if (state.selected && document.contains(state.selected)) buildPanel(state.selected);
    positionHandles();
  }

  /* Undo only the most recent change to one element — the per-element "step
     back" button. Removing the entry (rather than moving the pointer) keeps
     unrelated later edits to other elements intact. */
  function stepBackElement(el) {
    var sel = selectorFor(el);
    var pseudo = sel + "::before";
    for (var i = Math.min(state.logIndex, state.log.length - 1); i >= 0; i--) {
      var e = state.log[i];
      if (!e || e.hidden) continue;
      if (e.sel === sel || e.sel === pseudo || e.sel.indexOf(sel) === 0) {
        state.log.splice(i, 1);
        if (state.logIndex >= i) state.logIndex--;
        afterTimeTravel();
        toast("Stepped back: " + describe(e));
        return true;
      }
    }
    toast("No changes recorded on this element");
    return false;
  }

  function deleteEntry(id) {
    for (var i = 0; i < state.log.length; i++) {
      if (state.log[i].id !== id) continue;
      state.log.splice(i, 1);
      if (state.logIndex >= i) state.logIndex--;
      afterTimeTravel();
      return;
    }
  }

  function toggleEntry(id) {
    for (var i = 0; i < state.log.length; i++) {
      if (state.log[i].id !== id) continue;
      state.log[i].hidden = !state.log[i].hidden;
      afterTimeTravel();
      return;
    }
  }

  function describe(e) {
    var name = e.sel.replace(/^.*\s/, "").replace(/::before$/, " outline");
    var val = e.after === null ? "removed" : e.after;
    if (String(val).length > 26) val = String(val).slice(0, 24) + "…";
    return name + " · " + e.prop + ": " + val;
  }


  // ------------------------------------------------- selector generation

  /* A selector must be stable across re-renders of the project sheet, and
     specific enough to win against the existing stylesheet.

     Note this deliberately returns a SHARED selector when the element is one of
     many alike (`.case-card` matches all seven cards). That mirrors how CSS
     actually works and is usually what the user wants. When they ask to target
     one instance only, uniqueSelectorFor() is used instead. */
  function selectorFor(el) {
    if (isolated(el)) return uniqueSelectorFor(el);
    return sharedSelectorFor(el);
  }

  function sharedSelectorFor(el) {
    if (el.id) return "#" + el.id;

    var parts = [];
    var node = el;
    var guard = 0;

    while (node && node.nodeType === 1 && guard++ < 6) {
      if (node === document.body) break;

      var seg = node.tagName.toLowerCase();
      var classes = classListOf(node);

      if (classes.length) {
        seg = "." + classes.join(".");
      } else {
        var idx = indexOfType(node);
        if (idx > 0) seg += ":nth-of-type(" + (idx + 1) + ")";
      }

      parts.unshift(seg);

      // A project-scoped ancestor is a good anchor: stop there.
      var sheet = node.closest && node.closest(".project-sheet[data-project-id]");
      if (sheet && node !== sheet && sheet.contains(node)) {
        var pid = sheet.getAttribute("data-project-id");
        var candidate = '.project-sheet[data-project-id="' + pid + '"] ' + parts.join(" ");
        if (isUnique(candidate, el)) return candidate;
      }

      if (parts.length >= 2 && isUnique(parts.join(" "), el)) return parts.join(" ");
      node = node.parentElement;
    }

    var joined = parts.join(" ");
    return joined || el.tagName.toLowerCase();
  }

  /* Pin down exactly one element by appending :nth-of-type while walking up.
     This needs no markup changes, so "only this one" never mutates the
     project's HTML — the isolation lives entirely in the selector. */
  function uniqueSelectorFor(el) {
    if (el.id) return "#" + el.id;

    var parts = [];
    var node = el;
    var guard = 0;

    while (node && node.nodeType === 1 && node !== document.body && guard++ < 10) {
      var seg = node.tagName.toLowerCase();
      var classes = classListOf(node);
      if (classes.length) seg = seg + "." + classes.join(".");

      var sameType = node.parentElement
        ? [].filter.call(node.parentElement.children, function (c) {
            return c.tagName === node.tagName;
          }).length
        : 1;
      if (sameType > 1) seg += ":nth-of-type(" + (indexOfType(node) + 1) + ")";

      parts.unshift(seg);

      var candidate = parts.join(" > ");
      if (isUnique(candidate, el)) return candidate;

      if (node.id) {
        var anchored = "#" + node.id + (parts.length > 1 ? " > " + parts.slice(1).join(" > ") : "");
        if (isUnique(anchored, el)) return anchored;
      }
      node = node.parentElement;
    }

    return parts.join(" > ") || el.tagName.toLowerCase();
  }

  // How many elements a shared selector would hit — drives the scope warning.
  function scopeCount(el) {
    try { return document.querySelectorAll(sharedSelectorFor(el)).length; }
    catch (e) { return 1; }
  }

  function scopeTargets(el) {
    try { return [].slice.call(document.querySelectorAll(sharedSelectorFor(el))); }
    catch (e) { return [el]; }
  }

  /* Isolation is remembered against the element's unique path, so the choice
     survives re-selection and the sheet being re-rendered from JSON. */
  function isolationKey(el) {
    return uniqueSelectorFor(el);
  }

  function isolated(el) {
    return !!state.isolate[isolationKey(el)];
  }

  function setIsolated(el, on) {
    var key = isolationKey(el);
    if (on) state.isolate[key] = true;
    else delete state.isolate[key];
    try { localStorage.setItem(ISOLATE_KEY, JSON.stringify(state.isolate)); } catch (e) {}
  }

  function classListOf(node) {
    var out = [];
    var cl = node.classList;
    for (var i = 0; i < cl.length; i++) {
      var c = cl[i];
      // Skip editor + transient state classes so selectors stay stable.
      if (c.indexOf("ve-") === 0) continue;
      if (c.indexOf("is-") === 0) continue;
      if (c.indexOf("has-") === 0) continue;
      out.push(cssEscape(c));
    }
    return out;
  }

  function cssEscape(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return s.replace(/([^\w-])/g, "\\$1");
  }

  function indexOfType(node) {
    var p = node.parentElement;
    if (!p) return 0;
    var same = [];
    for (var i = 0; i < p.children.length; i++) {
      if (p.children[i].tagName === node.tagName) same.push(p.children[i]);
    }
    return same.indexOf(node);
  }

  function isUnique(sel, el) {
    try {
      var found = document.querySelectorAll(sel);
      return found.length === 1 && found[0] === el;
    } catch (e) { return false; }
  }

  // ------------------------------------------------------- unit handling

  /* px-per-unit for the units this design actually uses. cqw resolves
     against the nearest ancestor that declares container-type, which is why
     we walk up looking for one instead of assuming the viewport. */
  function unitBasis(el, unit) {
    switch (unit) {
      case "px": return 1;
      case "cqw": return containerWidth(el) / 100;
      case "cqh": return containerHeight(el) / 100;
      case "%": return parentWidth(el) / 100;
      case "vw": return window.innerWidth / 100;
      case "vh": return window.innerHeight / 100;
      case "rem": return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      case "em": return parseFloat(getComputedStyle(el).fontSize) || 16;
      default: return 1;
    }
  }

  function containerEl(el) {
    var node = el.parentElement;
    while (node && node.nodeType === 1) {
      var ct = getComputedStyle(node).containerType;
      if (ct && ct !== "normal") return node;
      node = node.parentElement;
    }
    return document.documentElement;
  }

  function containerWidth(el) {
    return containerEl(el).getBoundingClientRect().width || window.innerWidth;
  }

  function containerHeight(el) {
    return containerEl(el).getBoundingClientRect().height || window.innerHeight;
  }

  function parentWidth(el) {
    var p = el.parentElement;
    return (p ? p.getBoundingClientRect().width : window.innerWidth) || window.innerWidth;
  }

  function pxToUnit(px, el, unit) {
    var basis = unitBasis(el, unit);
    if (!basis) return px;
    return px / basis;
  }

  function unitToPx(val, el, unit) {
    return val * unitBasis(el, unit);
  }

  /* Read the unit a property was ORIGINALLY authored in, by scanning the
     cascade for the winning declaration. getComputedStyle always reports px,
     which is exactly what we must not blindly write back. */
  function authoredValue(el, prop) {
    var override = currentOverride(el, prop);
    if (override) return parse(override);

    var found = authoredRaw(el, prop);
    if (found) return parse(found);

    // Fall back to computed px.
    var computed = getComputedStyle(el)[camel(prop)];
    return parse(computed);
  }

  /* The winning authored declaration as written in the stylesheet (still a
     string, so `var(--token)` and multi-part values survive intact).

     Our own override sheet is skipped: it is part of document.styleSheets, and
     reading it back would make the editor mistake its own output for one of
     the site's authored rules — which breaks removal and fold detection. */
  function authoredRaw(el, prop) {
    var found = null;
    var sheets = document.styleSheets;

    for (var i = 0; i < sheets.length; i++) {
      if (isOwnSheet(sheets[i])) continue;
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }
      if (!rules) continue;
      found = scanRules(rules, el, prop) || found;
    }
    return found;
  }

  function isOwnSheet(sheet) {
    var owner = sheet && sheet.ownerNode;
    if (!owner) return false;
    if (owner.id === "ve-overrides") return true;
    var href = owner.getAttribute && owner.getAttribute("href");
    return !!(href && href.indexOf("visual-editor") !== -1);
  }

  function scanRules(rules, el, prop) {
    var hit = null;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];

      if (rule.type === 4 /* media */) {
        if (matchesMediaForScope(rule.conditionText || rule.media.mediaText)) {
          hit = scanRules(rule.cssRules, el, prop) || hit;
        }
        continue;
      }
      if (rule.type !== 1 /* style */) continue;
      if (rule.selectorText && rule.selectorText.indexOf(".ve-") !== -1) continue;

      var value = rule.style.getPropertyValue(prop);
      if (!value) continue;

      try {
        if (el.matches(rule.selectorText)) hit = value.trim();
      } catch (e) {}
    }
    return hit;
  }

  function matchesMediaForScope(text) {
    if (!text) return true;
    try { return window.matchMedia(text).matches; } catch (e) { return false; }
  }

  function parse(value) {
    if (value == null) return { num: 0, unit: "px", raw: "" };
    var str = String(value).trim();
    var m = str.match(/^(-?[\d.]+)\s*(px|cqw|cqh|cqi|%|vw|vh|rem|em)?$/);
    if (m) {
      return { num: parseFloat(m[1]), unit: m[2] || "px", raw: str };
    }
    return { num: NaN, unit: "px", raw: str };
  }

  function camel(prop) {
    return prop.replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
  }

  // ------------------------------------------------- override read/write

  function currentOverride(el, prop) {
    var sel = selectorFor(el);
    var bucket = state.overrides[scope()][sel];
    return bucket ? bucket[prop] : null;
  }

  function setProp(el, prop, value, mergeKey) {
    var sel = selectorFor(el);
    record(sel, prop, value === "" ? null : value,
      mergeKey === undefined ? sel + "|" + prop : mergeKey);
  }

  /* Mutation without a log entry — used inside the drag loop, which records a
     single entry when the pointer is released. */
  function writeProp(sel, prop, value) {
    var s = scope();
    if (!state.overrides[s][sel]) state.overrides[s][sel] = {};

    if (value === null || value === "") delete state.overrides[s][sel][prop];
    else state.overrides[s][sel][prop] = value;

    if (!Object.keys(state.overrides[s][sel]).length) delete state.overrides[s][sel];
  }

  /* All overrides are applied through one <style> tag rather than inline
     styles: inline styles are wiped when the sheet re-renders from JSON, and
     they'd also pollute the DOM we later want to export cleanly. */
  function renderStyle() {
    if (!state.styleEl) {
      state.styleEl = document.createElement("style");
      state.styleEl.id = "ve-overrides";
      document.head.appendChild(state.styleEl);
    }
    state.styleEl.textContent = buildCss(true);
  }

  function buildCss(forLive) {
    var out = [];

    out.push(block(state.overrides.desktop, forLive ? "" : ""));

    var mobile = state.overrides.mobile;
    if (Object.keys(mobile).length) {
      var inner = block(mobile, "  ");
      if (inner.trim()) {
        out.push("@media (max-width: " + MOBILE_BREAKPOINT + "px) {\n" + inner + "}");
      }
    }

    return out.join("\n").replace(/\n{3,}/g, "\n\n");
  }

  function block(bucket, indent) {
    var lines = [];
    Object.keys(bucket).forEach(function (sel) {
      var props = bucket[sel];
      var keys = Object.keys(props);
      if (!keys.length) return;

      lines.push(indent + sel + " {");
      keys.forEach(function (p) {
        // !important is required to beat the highly specific existing rules.
        lines.push(indent + "  " + p + ": " + props[p] + " !important;");
      });
      lines.push(indent + "}");
      lines.push("");
    });
    return lines.join("\n");
  }

  // ----------------------------------------------------------- selection

  function editable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.test(el.tagName)) return false;
    if (el.matches(BLOCKLIST)) return false;
    if (el.closest(".ve-panel, .ve-bar, .ve-modal, .ve-handles, .ve-history")) return false;
    return true;
  }

  function select(el) {
    if (state.selected === el) return;
    deselect();
    if (!el) return;

    state.selected = el;
    el.setAttribute("data-ve-selected", "");
    buildPanel(el);
    positionHandles();
    // The inspector only exists while there is something to inspect.
    if (state.panel) {
      state.panel.removeAttribute("hidden");
      /* It has no box while hidden, so a stale off-screen position can only be
         corrected now that it is laid out. */
      keepOnScreen(state.panel, PANEL_POS_KEY, "free");
    }
  }

  function deselect() {
    if (state.selected) state.selected.removeAttribute("data-ve-selected");
    state.selected = null;
    state.panelFor = null;
    clearHandles();

    /* Hide the inspector outright rather than showing an empty shell — with
       nothing selected it has nothing to say, and it would only cover the
       page the user is trying to look at. */
    if (state.panel) state.panel.setAttribute("hidden", "");
    if (state.body) {
      state.body.innerHTML = "";
      setPanelTitle("No selection", "");
    }
  }

  // --------------------------------------------------- element typing

  function typeOf(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === "svg" || el.closest("svg")) return "svg";
    if (tag === "img") return isSvgSrc(el) ? "svg-img" : "image";
    if (tag === "video") return "video";
    if (hasOwnText(el)) return "text";
    return "box";
  }

  function isSvgSrc(el) {
    var src = el.getAttribute("src") || "";
    return /\.svg(\?|#|$)/i.test(src);
  }

  function hasOwnText(el) {
    for (var i = 0; i < el.childNodes.length; i++) {
      var n = el.childNodes[i];
      if (n.nodeType === 3 && n.nodeValue.trim()) return true;
    }
    // Pseudo-element text layers (this site paints strokes via ::before).
    if (el.hasAttribute && el.hasAttribute("data-text")) return true;
    if (hasPseudoContent(el)) return true;
    /* No tag-name fallback: an icon-only <button> or empty <span> is a box,
       not text — otherwise every icon gets a pointless Typography group. */
    return false;
  }

  // ------------------------------------------------------ SVG inlining

  /* <img src="x.svg"> renders in a separate document, so its fill/stroke are
     unreachable from CSS. To make them editable we swap in the SVG markup,
     preserving classes so all existing layout rules still apply. */
  function inlineSvg(img) {
    var src = img.getAttribute("src");
    if (!src) return Promise.resolve(null);

    return fetch(src)
      .then(function (r) { return r.text(); })
      .then(function (text) {
        var doc = new DOMParser().parseFromString(text, "image/svg+xml");
        var svg = doc.querySelector("svg");
        if (!svg) return null;

        svg.setAttribute("class", img.getAttribute("class") || "");
        svg.setAttribute("data-ve-inlined", src);
        if (img.hasAttribute("aria-hidden")) svg.setAttribute("aria-hidden", "true");

        // Preserve intrinsic ratio so width-only CSS keeps working.
        if (!svg.getAttribute("viewBox")) {
          var w = svg.getAttribute("width");
          var h = svg.getAttribute("height");
          if (w && h) svg.setAttribute("viewBox", "0 0 " + parseFloat(w) + " " + parseFloat(h));
        }
        svg.removeAttribute("width");
        svg.removeAttribute("height");

        img.replaceWith(svg);
        state.inlinedSvg[selectorFor(svg)] = src;
        return svg;
      })
      .catch(function () { return null; });
  }

  // ----------------------------------------------------------- controls

  function buildPanel(el) {
    var t = typeOf(el);
    var body = state.body;

    // Fold state is per-element: a fresh selection re-derives from presence.
    if (state.panelFor !== el) {
      state.collapsed = {};
      state.panelFor = el;
    }

    body.innerHTML = "";
    setPanelTitle(labelFor(el), t);

    scopeBanner(el, body);

    var sel = document.createElement("div");
    sel.className = "ve-selector";
    sel.textContent = selectorFor(el);
    body.appendChild(sel);

    var hop = document.createElement("div");
    hop.className = "ve-hop";

    /* Always three buttons, always this order, always equal width. Labels are
       kept to one short word so the row never wraps at the panel's 306px. */
    var up = el.parentElement && editable(el.parentElement);
    hop.appendChild(hopBtn("up", "Parent", up
      ? function () { select(el.parentElement); } : null));

    /* Drill down is always offered when there is a child to step into —
       previously it only appeared for only-children, which made groups with
       siblings impossible to enter from the panel. */
    var first = firstEditableChild(el);
    hop.appendChild(hopBtn("down", "Child", first
      ? function () { select(first); } : null));

    /* Stepping into a group used to dead-end on its first child. Now the same
       control keeps cycling through that child's siblings, which is how you
       actually reach the third image in a row. */
    var sibs = siblingsOf(el);
    if (sibs.length > 1) {
      var idx = sibs.indexOf(el);
      hop.appendChild(hopBtn("next", "Next", function () {
        select(sibs[(idx + 1) % sibs.length]);
      }, (idx + 1) + "/" + sibs.length));
    } else {
      hop.appendChild(hopBtn("next", "Next", null));
    }

    body.appendChild(hop);

    if (t === "svg-img") {
      var conv = document.createElement("div");
      conv.className = "ve-group";
      conv.innerHTML = '<div class="ve-group-title">SVG</div>';
      var btn = document.createElement("button");
      btn.className = "ve-btn ve-btn-wide";
      btn.textContent = "Enable fill / stroke editing";
      btn.onclick = function () {
        btn.disabled = true;
        btn.textContent = "Converting…";
        inlineSvg(el).then(function (svg) {
          if (svg) { state.selected = null; select(svg); toast("SVG inlined — fill and stroke are now editable"); }
          else { btn.disabled = false; btn.textContent = "Failed — click to retry"; }
        });
      };
      conv.appendChild(btn);
      var note = document.createElement("div");
      note.className = "ve-empty";
      note.style.padding = "8px 0 0";
      note.style.textAlign = "left";
      note.textContent = "Convert this &lt;img&gt; to an inline SVG so its paths can be recoloured.";
      conv.appendChild(note);
      body.appendChild(conv);
    }

    if (t === "svg") groupSvg(el);
    if (t === "text") groupText(el);
    if (t === "image" || t === "video" || t === "svg-img" || t === "svg") groupSize(el);
    if (t === "box") groupSize(el);

    groupBackground(el);
    groupPosition(el);
    groupEffects(el);

    updateFoot(el);
  }

  /* The foot's contextual buttons: Replace image works on an <img> or on any
     element whose background-image carries a url(); Ungroup only on a
     container with children to dissolve into. */
  function updateFoot(el) {
    var foot = state.panel.querySelector(".ve-panel-foot");
    var rep = foot.querySelector("[data-ve-replace-img]");
    var ung = foot.querySelector("[data-ve-ungroup]");

    var t = typeOf(el);
    var isImg = t === "image" || t === "svg-img";
    var hasBgUrl = !isImg && hasBgImageUrl(el);
    rep.hidden = !(isImg || hasBgUrl);

    var ungrouped = currentOverride(el, "display") === "contents";
    var canUngroup = t === "box" && !!firstEditableChild(el);
    ung.hidden = !canUngroup;
    ung.textContent = ungrouped ? "Re-group" : "Ungroup";
    ung.title = ungrouped
      ? "Put the wrapper back into the layout"
      : "Dissolve this wrapper (display: contents) — children lay out as if it were not there";
  }

  /* The CSS background carries an actual image file (not just gradients). */
  function hasBgImageUrl(el) {
    var bg = currentOverride(el, "background-image") ||
      getComputedStyle(el).backgroundImage || "";
    return /url\(/.test(bg);
  }

  /* The single most surprising thing about editing a web page: a rule matches
     a CLASS of elements, not the one you clicked. When the selection is one of
     several alike, say so plainly and offer the choice. */
  function scopeBanner(el, body) {
    var n = scopeCount(el);
    var iso = isolated(el);

    // A genuinely unique element needs no warning at all.
    if (n <= 1 && !iso) return;

    var wrap = document.createElement("div");
    wrap.className = "ve-scope" + (iso ? " is-single" : " is-shared");

    var msg = document.createElement("div");
    msg.className = "ve-scope-msg";
    msg.innerHTML = iso
      ? "<strong>Only this one</strong> — edits affect just the element you picked."
      : "<strong>" + n + " matching elements</strong> — edits apply to all of them.";
    wrap.appendChild(msg);

    var choice = document.createElement("div");
    choice.className = "ve-scope-choice";

    var allBtn = document.createElement("button");
    allBtn.textContent = "All " + n;
    allBtn.title = "Style every element of this kind (what CSS does by default)";
    allBtn.className = iso ? "" : "is-on";

    var oneBtn = document.createElement("button");
    oneBtn.textContent = "Only this";
    oneBtn.title = "Target this one instance only";
    oneBtn.className = iso ? "is-on" : "";

    allBtn.onclick = function () { switchScope(el, false); };
    oneBtn.onclick = function () { switchScope(el, true); };

    choice.appendChild(allBtn);
    choice.appendChild(oneBtn);
    wrap.appendChild(choice);

    /* Hovering the banner outlines everything that would change, so the blast
       radius is visible rather than described. */
    if (!iso) {
      wrap.onmouseenter = function () {
        scopeTargets(el).forEach(function (t) { t.setAttribute("data-ve-scope-peek", ""); });
      };
      wrap.onmouseleave = clearScopePeek;
    }

    body.appendChild(wrap);
  }

  function clearScopePeek() {
    [].forEach.call(document.querySelectorAll("[data-ve-scope-peek]"), function (t) {
      t.removeAttribute("data-ve-scope-peek");
    });
  }

  function labelFor(el) {
    var cls = classListOf(el)[0];
    return (el.id ? "#" + el.id : el.tagName.toLowerCase() + (cls ? "." + cls : ""));
  }

  /* Switching scope moves any edits already made onto the new selector, so the
     visual result does not change — only its reach. */
  function switchScope(el, toSingle) {
    if (isolated(el) === toSingle) return;

    var from = selectorFor(el);
    setIsolated(el, toSingle);
    var to = selectorFor(el);

    if (from !== to) {
      var moved = 0;
      state.log.forEach(function (entry) {
        if (entry.sel === from) { entry.sel = to; moved++; }
        else if (entry.sel === from + "::before") { entry.sel = to + "::before"; moved++; }
      });

      /* Going from shared to single leaves the shared rule behind, which would
         keep styling the siblings. Drop it: the user asked for one instance. */
      if (moved) {
        rebuild();
        persistSession();
        renderStyle();
        updateBar();
        if (state.historyPanel) renderHistory();
      }
    }

    clearScopePeek();
    buildPanel(el);
    toast(toSingle ? "Now editing this element only"
      : "Now editing all " + scopeCount(el) + " matching elements");
  }

  function firstEditableChild(el) {
    for (var i = 0; i < el.children.length; i++) {
      if (editable(el.children[i])) return el.children[i];
    }
    return null;
  }

  /* Editable elements sharing this element's parent, in document order. Used
     for the sibling cycle, so a group's children can be walked one by one. */
  function siblingsOf(el) {
    var parent = el.parentElement;
    if (!parent) return [el];
    var out = [];
    for (var i = 0; i < parent.children.length; i++) {
      var child = parent.children[i];
      if (editable(child)) out.push(child);
    }
    return out.length ? out : [el];
  }

  /* Walk up from the clicked node to the element a designer would consider
     "the thing" — a button, a card, a list item — rather than the inner <span>
     that happens to be under the cursor.

     Geometry alone is a poor guide: a padded button is several times taller
     than its own label, which naively reads as "too big". So semantics lead,
     and size only stops runaway climbs. */
  function outermostGroupFor(el) {
    if (!editable(el)) return el;

    /* An interactive or card-like ancestor close by is almost always the
       intended target. */
    var component = el.closest(COMPONENT_SELECTOR);
    if (component && component !== el && editable(component) && !isSectionLike(component)) {
      return component;
    }

    // Otherwise climb while the box stays comparable, stopping at structure.
    var best = el;
    var node = el.parentElement;
    var box = el.getBoundingClientRect();
    var guard = 0;

    while (node && node.nodeType === 1 && node !== document.body && guard++ < 8) {
      if (!editable(node) || isSectionLike(node)) break;

      var nb = node.getBoundingClientRect();
      if (nb.width > box.width * 2.2 + 40 || nb.height > box.height * 3 + 40) break;

      best = node;
      node = node.parentElement;
    }
    return best;
  }

  /* Containers that define page structure. Selecting these by accident is
     never what you want from a plain click. */
  function isSectionLike(node) {
    var tag = node.tagName.toLowerCase();
    if (/^(section|main|header|footer|nav|article|aside|form|ul|ol)$/.test(tag)) return true;

    /* Naming carries intent: panels, sections, wrappers and grids are page
       scaffolding regardless of tag. Selecting them from a plain click means
       grabbing half the layout. */
    var name = (node.id || "") + " " + (node.className || "");
    if (typeof name === "string" &&
        /\b(page|panel|section|wrapper|container|shell|layout|grid|row|inner|content|main)\b/i.test(name)) {
      return true;
    }

    var box = node.getBoundingClientRect();
    return box.height > window.innerHeight * 0.6 || box.width > window.innerWidth * 0.85;
  }

  /* The deepest page element at a point, ignoring the editor's own chrome.
     elementsFromPoint returns the full stack, so the overlay can be skipped
     instead of temporarily toggling pointer-events. */
  function pageElementAt(x, y) {
    var stack = document.elementsFromPoint(x, y);
    for (var i = 0; i < stack.length; i++) {
      var node = stack[i];
      if (node.closest(".ve-panel, .ve-bar, .ve-modal, .ve-handles, .ve-history, .ve-toast")) {
        continue;
      }
      return refineTextHit(node, x, y);
    }
    return null;
  }

  /* Hit-testing text is deceptive: a two-line heading only responds where the
     glyphs are, so a click between the lines lands on the CONTAINER, not the
     heading. That made headings and paragraphs unselectable.

     So when the hit is a container, look through its children for one whose
     line boxes actually span this point — getClientRects gives a rect per
     line, which is what makes the gap between lines resolvable. */
  function refineTextHit(node, x, y) {
    if (!node || !node.children || !node.children.length) return node;

    var best = null;
    for (var i = 0; i < node.children.length; i++) {
      var child = node.children[i];
      if (!editable(child)) continue;

      var rects = child.getClientRects();
      for (var r = 0; r < rects.length; r++) {
        var rect = rects[r];
        if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) {
          // Deepest match wins, so nested spans still resolve correctly.
          best = refineTextHit(child, x, y);
          break;
        }
      }
      if (best) break;
    }
    return best || node;
  }

  /* One level of descent from `current` towards `target`. Returns the child of
     `current` that contains `target`, so repeated double-clicks step inward
     rather than jumping straight to the leaf. */
  function drillTowards(current, target) {
    if (!current || !document.contains(current)) return target;
    if (current === target) return null;
    if (!current.contains(target)) return outermostGroupFor(target);

    var node = target;
    while (node && node.parentElement && node.parentElement !== current) {
      node = node.parentElement;
    }
    if (!node || !editable(node)) return target;
    return node;
  }

  /* Hierarchy icons. One structural idea drawn three ways so the set reads as
     a family: a chevron moving against a fixed edge line. Up = out to the
     parent, down = into the first child, right = along to the next sibling.

     Geometry note: the ink bbox must be centred on 8,8 in the 16×16 viewBox —
     centring the <svg> element is not enough (see the toolbar icons). The edge
     line and the arrow tail are placed symmetrically about the centre: line at
     3.5, arrow tip at 12.5, giving a span of 3.5..12.5 whose midpoint is 8. */
  function hopIcon(dir) {
    var paths = {
      up:
        '<path d="M3.5 3.5h9"/>' +
        '<path d="M8 12.5V6.5"/>' +
        '<path d="M5.4 9.1L8 6.5l2.6 2.6"/>',
      down:
        '<path d="M3.5 12.5h9"/>' +
        '<path d="M8 3.5v6"/>' +
        '<path d="M5.4 6.9L8 9.5l2.6-2.6"/>',
      next:
        '<path d="M3.5 3.5v9"/>' +
        '<path d="M12.5 8H6.5"/>' +
        '<path d="M9.9 5.4L12.5 8L9.9 10.6"/>'
    };
    return '<svg class="ve-hop-icon" viewBox="0 0 16 16" fill="none" ' +
      'stroke="currentColor" stroke-width="1.5" stroke-linecap="round" ' +
      'stroke-linejoin="round" aria-hidden="true">' + paths[dir] + "</svg>";
  }

  /* All three hops are always rendered, equal width, on one row — they are
     peers with no priority between them, so an unavailable one greys out in
     place rather than disappearing and reflowing the others. The sibling
     counter lives INSIDE its button: it describes that button's position, so
     floating it alongside as loose text made it look unrelated. */
  function hopBtn(dir, label, fn, meta) {
    var b = document.createElement("button");
    b.className = "ve-hop-btn";
    b.title = label + (meta ? " (" + meta + ")" : "");
    b.innerHTML = hopIcon(dir) +
      '<span class="ve-hop-label">' + label + "</span>" +
      (meta ? '<span class="ve-hop-n">' + meta + "</span>" : "");
    if (fn) b.onclick = fn; else b.disabled = true;
    return b;
  }

  /* A collapsible section. Figma-shaped: a group that already carries values
     opens with a × to strip it; an untouched group stays folded behind a +
     that seeds sensible defaults. `props` lists the declarations the group
     owns, so presence and removal can be derived rather than hand-wired. */
  function group(title, opts) {
    opts = opts || {};
    var el = state.selected;
    var props = opts.props || [];
    var key = title;

    var owned = opts.hasValue !== undefined
      ? opts.hasValue
      : props.some(function (p) { return hasDeclaration(el, p, opts.selectorFor); });

    // Explicit user fold wins; otherwise presence decides.
    var folded = state.collapsed[key] !== undefined ? state.collapsed[key] : !owned;

    var g = document.createElement("div");
    g.className = "ve-group" + (folded ? " is-folded" : "");

    var head = document.createElement("div");
    head.className = "ve-group-head";

    /* Caret and the +/× action are SVG, not text glyphs. A "×" and a "+"
       character have different side bearings and different optical centres, so
       as text they never line up with each other down a column of groups. */
    var caret = document.createElement("span");
    caret.className = "ve-caret";
    caret.innerHTML = folded ? CARET_RIGHT_SVG : CARET_DOWN_SVG;

    var label = document.createElement("span");
    label.className = "ve-group-title";
    label.textContent = title;

    head.appendChild(caret);
    head.appendChild(label);

    var action = document.createElement("button");
    action.className = "ve-group-action";

    if (owned && props.length) {
      action.innerHTML = CROSS_SVG;
      action.title = "Remove these properties";
      action.classList.add("is-remove");
      action.onclick = function (e) {
        e.stopPropagation();
        removeGroup(el, props, opts.selectorFor, title);
      };
    } else if (props.length && opts.defaults) {
      action.innerHTML = PLUS_SVG;
      action.title = "Add " + title;
      action.onclick = function (e) {
        e.stopPropagation();
        addGroup(el, opts.defaults, opts.selectorFor, title);
      };
    } else {
      action.style.visibility = "hidden";
      action.innerHTML = PLUS_SVG;
    }
    head.appendChild(action);

    head.onclick = function () {
      var nowFolded = !g.classList.contains("is-folded");
      g.classList.toggle("is-folded", nowFolded);
      caret.innerHTML = nowFolded ? CARET_RIGHT_SVG : CARET_DOWN_SVG;
      state.collapsed[key] = nowFolded;
    };

    var bodyWrap = document.createElement("div");
    bodyWrap.className = "ve-group-body";

    g.appendChild(head);
    g.appendChild(bodyWrap);
    state.body.appendChild(g);

    // Rows are appended into the body, so return that instead of the shell.
    return bodyWrap;
  }

  /* True when this property is actually set — either by our own override or
     by an authored declaration in the site's stylesheet. Computed values are
     deliberately ignored: every element "has" a computed text-shadow of
     `none`, and treating that as present would defeat the folding. */
  function hasDeclaration(el, prop, selectorMaker) {
    if (!el) return false;

    if (selectorMaker) {
      var sel = selectorMaker(el);
      var bucket = state.overrides[scope()][sel];
      if (bucket && bucket[prop] != null) return !isEmptyish(bucket[prop]);

      if (authoredPseudoRaw(el, prop, "::before")) return true;

      /* Strokes on this site are authored through the `-webkit-text-stroke`
         shorthand, so the longhand scan misses them. Fall back to the pseudo's
         computed width, which is only non-zero when a stroke really is set. */
      if (/text-stroke/.test(prop)) {
        var w = parseFloat(getComputedStyle(el, "::before").webkitTextStrokeWidth);
        if (w > 0) return true;
      }
      return false;
    }

    var override = currentOverride(el, prop);
    if (override != null) {
      /* A neutralising value ("none", "0") is how removal is expressed, so it
         must read as absent — otherwise the group keeps offering × for a
         property that is no longer set. */
      return !isEmptyish(override);
    }

    var authored = authoredRaw(el, prop);
    if (authored && !isEmptyish(authored)) return true;
    return false;
  }

  function isEmptyish(v) {
    var s = String(v).trim().toLowerCase();
    return !s || s === "none" || s === "normal" || s === "auto" || s === "0" || s === "0px";
  }

  function addGroup(el, defaults, selectorMaker, title) {
    sealStep();
    var sel = selectorMaker ? selectorMaker(el) : selectorFor(el);
    Object.keys(defaults).forEach(function (prop) {
      var value = typeof defaults[prop] === "function" ? defaults[prop](el) : defaults[prop];
      record(sel, prop, value, null, "Add " + title);
    });
    sealStep();
    delete state.collapsed[title];   // let presence re-open it
    buildPanel(el);
    toast(title + " added");
  }

  function removeGroup(el, props, selectorMaker, title) {
    sealStep();
    var sel = selectorMaker ? selectorMaker(el) : selectorFor(el);

    props.forEach(function (prop) {
      /* If the site's own stylesheet declares this, dropping our override is
         not enough — the authored value would simply come back. Write a
         neutralising value instead. */
      var authored = selectorMaker
        ? authoredPseudoRaw(el, prop, "::before")
        : authoredRaw(el, prop);
      var value = (authored && !isEmptyish(authored)) ? neutralFor(prop) : null;
      record(sel, prop, value, null, "Remove " + title);
    });

    sealStep();
    state.collapsed[title] = true;
    buildPanel(el);
    toast(title + " removed");
  }

  function neutralFor(prop) {
    if (/shadow/.test(prop)) return "none";
    if (prop === "filter") return "none";
    if (/stroke-width/.test(prop)) return "0";
    if (prop === "mix-blend-mode") return "normal";
    if (prop === "letter-spacing") return "normal";
    if (prop === "border-radius") return "0";
    return "none";
  }

  function row(parent, label) {
    var r = document.createElement("div");
    r.className = "ve-row";
    var l = document.createElement("label");
    l.textContent = label;
    var f = document.createElement("div");
    f.className = "ve-field";
    r.appendChild(l);
    r.appendChild(f);
    parent.appendChild(r);
    return f;
  }

  /* A number input paired with a unit picker. Changing the unit converts the
     value so the element does not visually jump — this is what makes editing
     a cqw-based layout safe. */
  function numberUnit(parent, label, el, prop, opts) {
    opts = opts || {};
    var field = row(parent, label);
    var info = authoredValue(el, prop);
    var unit = info.unit || "px";
    var num = isNaN(info.num)
      ? pxToUnit(parseFloat(getComputedStyle(el)[camel(prop)]) || 0, el, unit)
      : info.num;

    var input = document.createElement("input");
    input.type = "number";
    input.step = opts.step || stepFor(unit);
    input.value = round(num);

    var units = document.createElement("select");
    units.className = "ve-unit";
    (opts.units || ["cqw", "px", "%", "rem", "em", "vw"]).forEach(function (u) {
      var o = document.createElement("option");
      o.value = u; o.textContent = u;
      units.appendChild(o);
    });
    units.value = unit;

    function push() {
      var v = parseFloat(input.value);
      if (isNaN(v)) return;
      setProp(el, prop, round(v) + units.value, selectorFor(el) + "|" + prop);
      positionHandles();
    }

    input.oninput = push;
    input.onblur = sealStep;

    units.onchange = function () {
      // Convert current value into the newly chosen unit.
      var px = unitToPx(parseFloat(input.value) || 0, el, unit);
      unit = units.value;
      input.step = stepFor(unit);
      input.value = round(pxToUnit(px, el, unit));
      sealStep();
      push();
    };

    field.appendChild(input);
    field.appendChild(units);
    return { input: input, units: units, refresh: function () {
      var i2 = authoredValue(el, prop);
      if (!isNaN(i2.num)) { input.value = round(i2.num); units.value = i2.unit || "px"; unit = units.value; }
    } };
  }

  function stepFor(unit) {
    if (unit === "px") return 1;
    if (unit === "cqw" || unit === "%" || unit === "vw") return 0.05;
    return 0.01;
  }

  function round(v) {
    return Math.round(v * 10000) / 10000;
  }

  function colorRow(parent, label, el, prop) {
    var field = row(parent, label);
    var cur = currentOverride(el, prop) || authoredRaw(el, prop) ||
      getComputedStyle(el)[camel(prop)];
    var rgb = toHex(cur, el);

    var picker = document.createElement("input");
    picker.type = "color";
    picker.value = rgb.hex;

    var alpha = document.createElement("input");
    alpha.type = "number";
    alpha.className = "ve-num-mini";
    alpha.min = 0; alpha.max = 1; alpha.step = 0.01;
    alpha.value = rgb.a;
    alpha.title = "Alpha";

    function push() {
      var a = parseFloat(alpha.value);
      var v = (isNaN(a) || a >= 1) ? picker.value : hexToRgba(picker.value, a);
      setProp(el, prop, v, selectorFor(el) + "|" + prop);
    }

    picker.oninput = push;
    alpha.oninput = push;
    picker.onchange = alpha.onblur = sealStep;

    field.appendChild(picker);
    field.appendChild(alpha);
    return field;
  }

  function textRow(parent, label, el, prop, placeholder) {
    var field = row(parent, label);
    var input = document.createElement("input");
    input.type = "text";
    input.placeholder = placeholder || "";
    input.value = currentOverride(el, prop) || "";
    input.oninput = function () {
      setProp(el, prop, input.value.trim() || null, selectorFor(el) + "|" + prop);
    };
    input.onblur = sealStep;
    field.appendChild(input);
    return input;
  }

  // ----------------------------------------------------------- gradients

  /* Split on commas that sit outside any parentheses, so rgb()/rgba()
     arguments inside a gradient don't fragment the stop list. */
  function splitTopLevel(str) {
    var parts = [], depth = 0, cur = "";
    for (var i = 0; i < str.length; i++) {
      var c = str[i];
      if (c === "(") depth++;
      else if (c === ")") depth--;
      if (c === "," && depth === 0) { parts.push(cur); cur = ""; }
      else cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map(function (s) { return s.trim(); }).filter(Boolean);
  }

  /* A stop is "color [position]". The color itself can contain spaces inside
     parens (rgb(1, 2, 3)), so the position is split off at the LAST
     whitespace that sits outside parens. */
  function parseGradientStop(str) {
    var depth = 0, cut = -1;
    for (var i = str.length - 1; i >= 0; i--) {
      var c = str[i];
      if (c === ")") depth++;
      else if (c === "(") depth--;
      else if (/\s/.test(c) && depth === 0) { cut = i; break; }
    }
    var color = str, pos = null;
    if (cut > -1) {
      var tail = str.slice(cut + 1).trim();
      if (/^[\d.]+%$/.test(tail) || /^[\d.]+(px|em|rem)$/.test(tail)) {
        color = str.slice(0, cut).trim();
        pos = tail;
      }
    }
    if (!color) return null;
    return { color: color, pos: pos };
  }

  /* Understands a single linear-gradient() or radial-gradient() layer.
     Anything more exotic (multi-layer, conic, repeating hints) returns null
     and the caller falls back to a raw text field. */
  function parseGradient(raw) {
    var m = String(raw).match(/^(linear|radial)-gradient\(\s*([\s\S]*)\)\s*$/i);
    if (!m) return null;
    var type = m[1].toLowerCase();
    var args = splitTopLevel(m[2]);
    if (!args.length) return null;

    var out = { type: type, angle: null, direction: null, shape: null, stops: [] };
    var startIdx = 0;
    var first = args[0];

    if (type === "linear") {
      var am = first.match(/^(-?[\d.]+)deg$/i);
      if (am) { out.angle = parseFloat(am[1]); startIdx = 1; }
      else if (/^to\s/i.test(first)) { out.direction = first; startIdx = 1; }
    } else if (/^(circle|ellipse|closest|farthest|contain|cover|at\s)/i.test(first)) {
      out.shape = first; startIdx = 1;
    }

    for (var i = startIdx; i < args.length; i++) {
      var stop = parseGradientStop(args[i]);
      if (!stop) return null;
      out.stops.push(stop);
    }
    return out.stops.length >= 2 ? out : null;
  }

  function gradientToString(g) {
    var head = [];
    if (g.type === "linear") {
      head.push(g.angle != null ? round(g.angle) + "deg" : (g.direction || "180deg"));
    } else if (g.shape) {
      head.push(g.shape);
    }
    var stops = g.stops.map(function (s) {
      return s.pos ? s.color + " " + s.pos : s.color;
    });
    return g.type + "-gradient(" + head.concat(stops).join(", ") + ")";
  }

  /* Structured gradient editing: angle for linear, then one row per stop
     (colour + alpha + position). Every change re-serialises the whole
     gradient and records it as background-image, so it flows through the
     same history/save pipeline as any other property. */
  function gradientEditor(parent, el, grad) {
    var key = selectorFor(el) + "|background-image";

    if (grad.type === "linear" && grad.angle != null) {
      var ar = row(parent, "Angle");
      var aIn = document.createElement("input");
      aIn.type = "number";
      aIn.step = 1;
      aIn.value = grad.angle;
      aIn.oninput = function () {
        var v = parseFloat(aIn.value);
        if (isNaN(v)) return;
        grad.angle = v;
        setProp(el, "background-image", gradientToString(grad), key);
      };
      aIn.onblur = sealStep;
      ar.appendChild(aIn);
    }

    grad.stops.forEach(function (stop, i) {
      var sr = row(parent, "Stop " + (i + 1));
      var rgb = toHex(stop.color, el);

      var picker = document.createElement("input");
      picker.type = "color";
      picker.value = rgb.hex;

      var alpha = document.createElement("input");
      alpha.type = "number";
      alpha.className = "ve-num-mini";
      alpha.min = 0; alpha.max = 1; alpha.step = 0.01;
      alpha.value = rgb.a;
      alpha.title = "Alpha";

      var pos = document.createElement("input");
      pos.type = "number";
      pos.className = "ve-num-mini";
      pos.min = 0; pos.max = 100; pos.step = 1;
      pos.value = stop.pos && /%$/.test(stop.pos) ? parseFloat(stop.pos) : "";
      pos.placeholder = "%";
      pos.title = "Stop position (%)";

      function push() {
        var a = parseFloat(alpha.value);
        stop.color = (isNaN(a) || a >= 1) ? picker.value : hexToRgba(picker.value, a);
        stop.pos = pos.value === "" ? null : round(parseFloat(pos.value)) + "%";
        setProp(el, "background-image", gradientToString(grad), key);
      }

      picker.oninput = alpha.oninput = pos.oninput = push;
      picker.onchange = alpha.onblur = pos.onblur = sealStep;

      sr.appendChild(picker);
      sr.appendChild(alpha);
      sr.appendChild(pos);
    });

    var hint = document.createElement("div");
    hint.className = "ve-empty";
    hint.style.padding = "4px 0 0";
    hint.style.textAlign = "left";
    hint.textContent = "Editing this element’s gradient — " + (grad.stops.length) + " stops.";
    parent.appendChild(hint);
  }

  // ------------------------------------------------------- groups by type

  function groupText(el) {
    var g = group("Typography", {
      props: ["font-size", "color", "line-height", "letter-spacing"],
      hasValue: true   // always relevant for text
    });
    numberUnit(g, "Size", el, "font-size", { units: ["cqw", "px", "rem", "em", "vw"] });
    colorRow(g, "Colour", el, "color");
    numberUnit(g, "Line height", el, "line-height", { units: ["em", "px", "cqw"] });
    numberUnit(g, "Letter spacing", el, "letter-spacing", { units: ["em", "px", "cqw"] });

    var paintsPseudo = el.hasAttribute("data-text") || hasPseudoContent(el);

    /* This site paints outlines on a ::before layer, so the stroke controls
       must target the pseudo-element rather than the element itself. */
    if (paintsPseudo) {
      var ps = group("Outline (::before layer)", {
        props: ["-webkit-text-stroke-width", "-webkit-text-stroke-color"],
        selectorFor: function (e) { return selectorFor(e) + "::before"; },
        defaults: {
          "-webkit-text-stroke-width": "0.5cqw",
          "-webkit-text-stroke-color": "#153b48"
        }
      });
      if (ps) {
        pseudoNumber(ps, "Width", el, "-webkit-text-stroke-width");
        pseudoColor(ps, "Colour", el, "-webkit-text-stroke-color");
      }
    } else {
      var s = group("Stroke", {
        props: ["-webkit-text-stroke-width", "-webkit-text-stroke-color"],
        defaults: {
          "-webkit-text-stroke-width": "0.5cqw",
          "-webkit-text-stroke-color": "#153b48"
        }
      });
      if (s) {
        numberUnit(s, "Width", el, "-webkit-text-stroke-width", { units: ["cqw", "px", "em"] });
        colorRow(s, "Colour", el, "-webkit-text-stroke-color");
      }
    }

    var sh = group("Text shadow", {
      props: ["text-shadow"],
      defaults: { "text-shadow": "0.125cqw 0.125cqw 0.09cqw rgba(21, 59, 72, 0.63)" }
    });
    if (sh) shadowRows(sh, el, "text-shadow");
  }

  function hasPseudoContent(el) {
    var c = getComputedStyle(el, "::before").content;
    return c && c !== "none" && c !== "normal";
  }

  /* Fill Fill — always visible so it's discoverable. Solid colour gets the
     plain picker; a single-layer gradient gets the structured stop editor;
     unparseable background-images degrade to a raw text field. When the
     element itself has no fill but an ancestor does (the usual case: you
     clicked the icon inside a tinted button), say where the fill lives and
     offer a jump. */
  function groupBackground(el) {
    var g = group("Fill", {
      props: ["background-color", "background-image"],
      hasValue: true
    });
    colorRow(g, "Colour", el, "background-color");

    /* authoredRaw takes the LAST matching declaration in sheet order, which
       ignores specificity: a base class can reset background-image: initial
       after a more specific gradient rule, and the raw scan reports the
       reset. Only trust the authored value when it actually is the gradient;
       otherwise the computed style is the truth. */
    var overrideBg = currentOverride(el, "background-image");
    var authoredBg = authoredRaw(el, "background-image");
    var computedBg = getComputedStyle(el).backgroundImage;
    var bgImage = overrideBg ||
      (authoredBg && /-gradient\(/.test(authoredBg) ? authoredBg : computedBg);

    if (bgImage && /-gradient\(/.test(bgImage)) {
      var parsed = parseGradient(bgImage);
      if (parsed) gradientEditor(g, el, parsed);
      else textRow(g, "background-image", el, "background-image",
        "linear-gradient(135deg, #000 0%, #fff 100%)");
    }

    if (!hasOwnFill(el)) {
      var src = nearestFilledAncestor(el);
      if (src) {
        var hint = document.createElement("div");
        hint.className = "ve-empty";
        hint.style.padding = "4px 0 0";
        hint.style.textAlign = "left";
        var jump = document.createElement("button");
        jump.className = "ve-btn";
        jump.style.marginTop = "4px";
        jump.textContent = "Fill lives on " + labelFor(src) + " — click to go there";
        jump.onclick = function () { select(src); };
        hint.textContent = "This element has no fill of its own.";
        hint.appendChild(document.createElement("br"));
        hint.appendChild(jump);
        g.appendChild(hint);
      }
    }
  }

  function hasOwnFill(el) {
    if (currentOverride(el, "background-color") || currentOverride(el, "background-image")) return true;
    var cs = getComputedStyle(el);
    var c = cs.backgroundColor;
    if (c && c !== "transparent" && !/rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*0\s*\)/.test(c)) return true;
    return cs.backgroundImage && cs.backgroundImage !== "none";
  }

  function nearestFilledAncestor(el) {
    var node = el.parentElement;
    var guard = 0;
    while (node && editable(node) && guard++ < 4) {
      if (isSectionLike(node)) break;
      if (hasOwnFill(node)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /* Structured shadow editing. The stored value is still a plain CSS string,
     but it is parsed into offset/blur/colour so it can be nudged numerically
     instead of retyped — and re-serialised in the authored unit. */
  function shadowRows(parent, el, prop) {
    var raw = currentOverride(el, prop) || authoredRaw(el, prop) ||
      getComputedStyle(el)[camel(prop)];
    var parts = parseShadow(raw);

    var xr = shadowNum(parent, "Offset X", parts.x, function (v) { parts.x = v; push("x"); });
    var yr = shadowNum(parent, "Offset Y", parts.y, function (v) { parts.y = v; push("y"); });
    var br = shadowNum(parent, "Blur", parts.blur, function (v) { parts.blur = v; push("blur"); });

    var cf = row(parent, "Colour");
    var rgb = toHex(parts.color, el);
    var picker = document.createElement("input");
    picker.type = "color";
    picker.value = rgb.hex;
    var alpha = document.createElement("input");
    alpha.type = "number";
    alpha.className = "ve-num-mini";
    alpha.min = 0; alpha.max = 1; alpha.step = 0.01;
    alpha.value = rgb.a;
    alpha.title = "Alpha";
    cf.appendChild(picker);
    cf.appendChild(alpha);

    picker.oninput = alpha.oninput = function () {
      var a = parseFloat(alpha.value);
      parts.color = (isNaN(a) || a >= 1) ? picker.value : hexToRgba(picker.value, a);
      push("color");
    };

    function push(which) {
      var value = parts.x + " " + parts.y + " " + parts.blur + " " + parts.color;
      if (prop === "filter") value = "drop-shadow(" + value + ")";
      setProp(el, prop, value, selectorFor(el) + "|" + prop + "|" + which);
    }
  }

  function shadowNum(parent, label, initial, onChange) {
    var field = row(parent, label);
    var info = parse(initial);
    var unit = info.unit || "cqw";

    var input = document.createElement("input");
    input.type = "number";
    input.step = stepFor(unit);
    input.value = isNaN(info.num) ? 0 : round(info.num);

    var units = document.createElement("select");
    units.className = "ve-unit";
    ["cqw", "px", "em", "%"].forEach(function (u) {
      var o = document.createElement("option"); o.value = u; o.textContent = u;
      units.appendChild(o);
    });
    units.value = unit;

    input.oninput = function () { onChange(round(parseFloat(input.value) || 0) + units.value); };
    units.onchange = function () {
      unit = units.value;
      input.step = stepFor(unit);
      onChange(round(parseFloat(input.value) || 0) + unit);
    };
    input.onblur = sealStep;

    field.appendChild(input);
    field.appendChild(units);
    return { input: input, units: units };
  }

  /* Pulls the first shadow out of a value like
     `0.125cqw 0.125cqw 0.09cqw rgba(21,59,72,.63)` or a drop-shadow() wrap. */
  function parseShadow(raw) {
    var out = { x: "0.125cqw", y: "0.125cqw", blur: "0.09cqw", color: "rgba(21, 59, 72, 0.63)" };
    if (!raw) return out;

    var str = String(raw).trim();
    if (str === "none" || str === "normal") return out;

    var dropped = str.match(/drop-shadow\(([^)]*(?:\([^)]*\))?[^)]*)\)/i);
    if (dropped) str = dropped[1].trim();

    // Pull the colour out first so splitting on spaces is safe.
    var color = null;
    var fn = str.match(/(rgba?|hsla?)\([^)]+\)/i);
    if (fn) { color = fn[0]; str = str.replace(fn[0], "").trim(); }
    else {
      var hex = str.match(/#[0-9a-f]{3,8}\b/i);
      if (hex) { color = hex[0]; str = str.replace(hex[0], "").trim(); }
      else {
        var named = str.match(/\b(black|white|currentcolor|transparent)\b/i);
        if (named) { color = named[0]; str = str.replace(named[0], "").trim(); }
      }
    }

    var nums = str.split(/\s+/).filter(Boolean);
    if (nums[0]) out.x = nums[0];
    if (nums[1]) out.y = nums[1];
    if (nums[2]) out.blur = nums[2];
    if (color) out.color = color;
    return out;
  }

  function pseudoNumber(parent, label, el, prop) {
    var field = row(parent, label);
    var pseudoSel = selectorFor(el) + "::before";
    var input = document.createElement("input");
    input.type = "number";
    input.step = 0.01;

    var info = authoredPseudoValue(el, pseudoSel, prop, "::before");
    input.value = round(info.num || 0);

    var units = document.createElement("select");
    units.className = "ve-unit";
    ["cqw", "px", "em"].forEach(function (u) {
      var o = document.createElement("option"); o.value = u; o.textContent = u; units.appendChild(o);
    });
    var unit = info.unit || "cqw";
    units.value = unit;

    function push() {
      var v = parseFloat(input.value);
      if (isNaN(v)) return;
      setPseudo(pseudoSel, prop, round(v) + units.value);
    }
    input.oninput = push;
    units.onchange = function () {
      var px = unitToPx(parseFloat(input.value) || 0, el, unit);
      unit = units.value;
      input.step = stepFor(unit);
      input.value = round(pxToUnit(px, el, unit));
      push();
    };
    field.appendChild(input);
    field.appendChild(units);
  }

  /* Pseudo-elements need their own cascade lookup: getComputedStyle on a
     pseudo reports px, and this design authors strokes in cqw. Scan the
     stylesheets for rules whose selector targets `el` plus the pseudo, so the
     panel shows (and writes back) the real authored unit. */
  function authoredPseudoValue(el, pseudoSel, prop, pseudoName) {
    var stored = pseudoOverride(pseudoSel, prop);
    if (stored) return parse(stored);

    var found = null;
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      if (isOwnSheet(sheets[i])) continue;
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }
      if (rules) found = scanPseudoRules(rules, el, prop, pseudoName) || found;
    }
    if (found) return parse(found);

    // Last resort: computed px, converted into cqw so the number is usable.
    var computedPx = parseFloat(getComputedStyle(el, pseudoName)[camel(prop)]) || 0;
    return { num: round(pxToUnit(computedPx, el, "cqw")), unit: "cqw", raw: computedPx + "px" };
  }

  function scanPseudoRules(rules, el, prop, pseudoName) {
    var hit = null;
    for (var i = 0; i < rules.length; i++) {
      var rule = rules[i];

      if (rule.type === 4 /* media */) {
        if (matchesMediaForScope(rule.conditionText || rule.media.mediaText)) {
          hit = scanPseudoRules(rule.cssRules, el, prop, pseudoName) || hit;
        }
        continue;
      }
      if (rule.type !== 1) continue;
      var selText = rule.selectorText || "";
      if (selText.indexOf(".ve-") !== -1) continue;
      if (selText.indexOf(pseudoName) === -1 && selText.indexOf(":" + pseudoName.replace("::", "")) === -1) continue;

      var value = rule.style.getPropertyValue(prop);
      if (!value) continue;

      // Strip the pseudo suffix and test whether the base selector hits el.
      var parts = selText.split(",");
      for (var j = 0; j < parts.length; j++) {
        var base = parts[j].trim();
        if (base.indexOf(pseudoName) === -1) continue;
        base = base.split(pseudoName)[0].trim();
        if (!base) continue;
        try {
          if (el.matches(base)) { hit = value.trim(); break; }
        } catch (e) {}
      }
    }
    return hit;
  }

  function pseudoColor(parent, label, el, prop) {
    var field = row(parent, label);
    var pseudoSel = selectorFor(el) + "::before";
    var stored = pseudoOverride(pseudoSel, prop);
    /* Stroke colour is usually authored through the `-webkit-text-stroke`
       shorthand, so the longhand lookup comes back empty. Computed style is
       authoritative for colour (no unit problem), so it is the fallback. */
    var authored = stored || authoredPseudoRaw(el, prop, "::before") ||
      getComputedStyle(el, "::before")[camel(prop)];
    var rgb = toHex(authored, el);
    var picker = document.createElement("input");
    picker.type = "color";
    picker.value = rgb.hex;
    picker.oninput = function () { setPseudo(pseudoSel, prop, picker.value); };
    field.appendChild(picker);
  }

  function authoredPseudoRaw(el, prop, pseudoName) {
    var found = null;
    var sheets = document.styleSheets;
    for (var i = 0; i < sheets.length; i++) {
      if (isOwnSheet(sheets[i])) continue;
      var rules;
      try { rules = sheets[i].cssRules; } catch (e) { continue; }
      if (rules) found = scanPseudoRules(rules, el, prop, pseudoName) || found;
    }
    return found;
  }

  function pseudoOverride(sel, prop) {
    var b = state.overrides[scope()][sel];
    return b ? b[prop] : null;
  }

  function setPseudo(sel, prop, value, mergeKey) {
    record(sel, prop, value === "" ? null : value,
      mergeKey === undefined ? sel + "|" + prop : mergeKey);
  }

  function groupSvg(el) {
    var isRoot = el.tagName.toLowerCase() === "svg";
    var shapes = isRoot
      ? el.querySelectorAll("path, polygon, rect, circle, ellipse, line, polyline")
      : [];

    /* Inner shapes usually carry hardcoded fill="#..." attributes exported
       from the design tool, and a presentation attribute beats a fill rule on
       the parent <svg>. So when this SVG has its own painted shapes we target
       them directly — otherwise the picker would appear to do nothing. */
    var paintTarget = el;
    var targetSuffix = "";
    if (isRoot && shapes.length) {
      var painted = 0;
      for (var i = 0; i < shapes.length; i++) {
        if (shapes[i].getAttribute("fill") || shapes[i].getAttribute("stroke")) painted++;
      }
      if (painted) targetSuffix = " path, " + selectorFor(el) + " polygon, " +
        selectorFor(el) + " rect, " + selectorFor(el) + " circle, " +
        selectorFor(el) + " ellipse, " + selectorFor(el) + " polyline";
    }

    var g = group("SVG paint", { hasValue: true });

    if (targetSuffix) {
      var shapeSel = selectorFor(el) + targetSuffix;
      pseudoColorAt(g, "Fill", shapeSel, "fill", shapes[0]);
      pseudoColorAt(g, "Stroke", shapeSel, "stroke", shapes[0]);
      pseudoNumberAt(g, "Stroke width", shapeSel, "stroke-width", shapes[0], ["px", "cqw"]);

      var note = document.createElement("div");
      note.className = "ve-empty";
      note.style.cssText = "padding:6px 0 0;text-align:left;font-size:10px";
      note.textContent = shapes.length + " shape" + (shapes.length > 1 ? "s" : "") +
        " with baked-in fills — edits target the shapes directly. Use the Child hop to style one.";
      g.appendChild(note);
    } else {
      colorRow(g, "Fill", el, "fill");
      colorRow(g, "Stroke", el, "stroke");
      numberUnit(g, "Stroke width", el, "stroke-width", { units: ["px", "cqw"] });
    }
  }

  /* Colour control bound to an arbitrary selector (used for inner SVG shapes
     and pseudo-elements, where the target is not the selected element). */
  function pseudoColorAt(parent, label, selector, prop, sampleEl) {
    var field = row(parent, label);
    var stored = pseudoOverride(selector, prop);
    var initial = stored ||
      (sampleEl && (sampleEl.getAttribute(prop) || getComputedStyle(sampleEl)[camel(prop)]));
    var rgb = toHex(initial, sampleEl || document.documentElement);

    var picker = document.createElement("input");
    picker.type = "color";
    picker.value = rgb.hex;

    var alpha = document.createElement("input");
    alpha.type = "number";
    alpha.className = "ve-num-mini";
    alpha.min = 0; alpha.max = 1; alpha.step = 0.01;
    alpha.value = rgb.a;
    alpha.title = "Alpha";

    function push() {
      var a = parseFloat(alpha.value);
      var v = (isNaN(a) || a >= 1) ? picker.value : hexToRgba(picker.value, a);
      setPseudo(selector, prop, v);
    }
    picker.oninput = push;
    alpha.oninput = push;
    field.appendChild(picker);
    field.appendChild(alpha);
  }

  function pseudoNumberAt(parent, label, selector, prop, sampleEl, unitList) {
    var field = row(parent, label);
    var stored = pseudoOverride(selector, prop);
    var info = stored ? parse(stored)
      : parse(sampleEl ? (sampleEl.getAttribute(prop) || getComputedStyle(sampleEl)[camel(prop)]) : "0");

    var input = document.createElement("input");
    input.type = "number";
    input.step = 0.01;
    input.value = isNaN(info.num) ? 0 : round(info.num);

    var units = document.createElement("select");
    units.className = "ve-unit";
    (unitList || ["px", "cqw"]).forEach(function (u) {
      var o = document.createElement("option"); o.value = u; o.textContent = u; units.appendChild(o);
    });
    units.value = info.unit || (unitList ? unitList[0] : "px");

    function push() {
      var v = parseFloat(input.value);
      if (isNaN(v)) return;
      setPseudo(selector, prop, round(v) + units.value);
    }
    input.oninput = push;
    units.onchange = push;
    field.appendChild(input);
    field.appendChild(units);
  }

  function groupSize(el) {
    var g = group("Size", { hasValue: true });
    numberUnit(g, "Width", el, "width", { units: ["%", "cqw", "px", "vw"] });
    numberUnit(g, "Height", el, "height", { units: ["%", "cqw", "px", "vh", "auto"] });

    var r = row(g, "Object fit");
    var sel = document.createElement("select");
    sel.className = "ve-unit";
    sel.style.flex = "1";
    ["", "cover", "contain", "fill", "none", "scale-down"].forEach(function (v) {
      var o = document.createElement("option");
      o.value = v; o.textContent = v || "(inherit)";
      sel.appendChild(o);
    });
    sel.value = currentOverride(el, "object-fit") || "";
    sel.onchange = function () { setProp(el, "object-fit", sel.value || null); };
    r.appendChild(sel);

    var rad = group("Corner radius", {
      props: ["border-radius"],
      defaults: { "border-radius": "0.5cqw" }
    });
    if (rad) numberUnit(rad, "Radius", el, "border-radius", { units: ["px", "cqw", "%"] });
  }

  function groupPosition(el) {
    var cs = getComputedStyle(el);
    var g = group("Position", { hasValue: true });

    if (cs.position !== "static") {
      numberUnit(g, "Top", el, "top", { units: ["%", "cqw", "px", "vh"] });
      numberUnit(g, "Left", el, "left", { units: ["%", "cqw", "px", "vw"] });
      numberUnit(g, "Right", el, "right", { units: ["%", "cqw", "px", "vw"] });
      numberUnit(g, "Bottom", el, "bottom", { units: ["%", "cqw", "px", "vh"] });
    }

    var z = row(g, "z-index");
    var zi = document.createElement("input");
    zi.type = "number";
    var zOverride = currentOverride(el, "z-index");
    zi.value = zOverride != null ? zOverride : (cs.zIndex === "auto" ? "" : cs.zIndex);
    zi.oninput = function () { setProp(el, "z-index", zi.value === "" ? null : zi.value); };
    zi.onblur = sealStep;
    z.appendChild(zi);

    var t = group("Transform", {
      props: ["transform"],
      defaults: { "transform": function (e) {
        var cur = getComputedStyle(e).transform;
        return cur && cur !== "none" ? cur : "translate(0, 0)";
      } }
    });
    if (t) textRow(t, "transform", el, "transform", "translate(-50%, -50%)");

    var box = group("Spacing", {
      props: ["margin", "padding"],
      defaults: { "margin": "0", "padding": "0" }
    });
    if (box) {
      textRow(box, "Margin", el, "margin", "0 auto");
      textRow(box, "Padding", el, "padding", "0.1em 0.2em");
    }
  }

  function groupEffects(el) {
    var g = group("Opacity", { hasValue: true });

    var o = row(g, "Opacity");
    var slider = document.createElement("input");
    slider.type = "range";
    slider.min = 0; slider.max = 1; slider.step = 0.01;
    slider.value = currentOverride(el, "opacity") || getComputedStyle(el).opacity;
    var num = document.createElement("input");
    num.type = "number";
    num.className = "ve-num-mini";
    num.min = 0; num.max = 1; num.step = 0.01;
    num.value = slider.value;

    var okey = selectorFor(el) + "|opacity";
    slider.oninput = function () {
      num.value = slider.value;
      setProp(el, "opacity", slider.value, okey);
    };
    num.oninput = function () {
      slider.value = num.value;
      setProp(el, "opacity", num.value, okey);
    };
    slider.onchange = num.onblur = sealStep;
    o.appendChild(slider);
    o.appendChild(num);

    /* Drop shadow is how this design casts shadows over irregular artwork,
       so it gets the structured editor rather than a raw filter string. */
    var isDropShadow = function (v) { return v && /drop-shadow/i.test(v); };
    var currentFilter = currentOverride(el, "filter") || authoredRaw(el, "filter");

    if (!currentFilter || isDropShadow(currentFilter)) {
      var ds = group("Drop shadow", {
        props: ["filter"],
        defaults: { "filter": "drop-shadow(0.125cqw 0.125cqw 0.09cqw rgba(21, 59, 72, 0.63))" }
      });
      if (ds) shadowRows(ds, el, "filter");
    } else {
      // A filter chain we cannot safely decompose — expose it as text.
      var f = group("Filter", { props: ["filter"], defaults: { "filter": "none" } });
      if (f) textRow(f, "filter", el, "filter", "drop-shadow(2px 2px 3px #000)");
    }

    var bs = group("Box shadow", {
      props: ["box-shadow"],
      defaults: { "box-shadow": "0 0.25cqw 0.75cqw rgba(0, 0, 0, 0.3)" }
    });
    if (bs) shadowRows(bs, el, "box-shadow");

    var mb = group("Blend mode", {
      props: ["mix-blend-mode"],
      defaults: { "mix-blend-mode": "multiply" }
    });
    if (mb) {
      var r = row(mb, "Mode");
      var sel = document.createElement("select");
      sel.className = "ve-unit";
      sel.style.flex = "1";
      ["normal", "multiply", "screen", "overlay", "darken", "lighten",
       "color-dodge", "soft-light", "hard-light", "difference", "luminosity"]
        .forEach(function (v) {
          var op = document.createElement("option");
          op.value = v; op.textContent = v;
          sel.appendChild(op);
        });
      sel.value = currentOverride(el, "mix-blend-mode") ||
        getComputedStyle(el).mixBlendMode || "normal";
      sel.onchange = function () { setProp(el, "mix-blend-mode", sel.value); };
      r.appendChild(sel);
    }
  }

  // ------------------------------------------------------------- colors

  function toHex(value, el) {
    var out = { hex: "#000000", a: 1 };
    if (!value) return out;
    var str = String(value).trim();

    /* Colours in this design are often authored as var(--token). Resolve the
       token against the element (or :root) so the picker opens on the real
       colour instead of defaulting to black. */
    var v = str.match(/^var\(\s*(--[\w-]+)\s*(?:,\s*(.+))?\)$/);
    if (v) {
      var scopeEl = el || document.documentElement;
      var resolved = getComputedStyle(scopeEl).getPropertyValue(v[1]).trim();
      if (!resolved && v[2]) resolved = v[2].trim();
      if (!resolved) resolved = getComputedStyle(document.documentElement).getPropertyValue(v[1]).trim();
      if (resolved) { str = resolved; out.varName = v[1]; }
    }

    var hex = str.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      out.hex = "#" + h.toLowerCase();
      return out;
    }

    var rgba = str.match(/rgba?\(([^)]+)\)/i);
    if (rgba) {
      var parts = rgba[1].split(/[\s,\/]+/).filter(Boolean).map(parseFloat);
      out.hex = "#" + [parts[0], parts[1], parts[2]].map(function (n) {
        var s = Math.max(0, Math.min(255, Math.round(n || 0))).toString(16);
        return s.length === 1 ? "0" + s : s;
      }).join("");
      if (parts.length > 3 && !isNaN(parts[3])) out.a = parts[3];
      return out;
    }
    return out;
  }

  function hexToRgba(hex, a) {
    var h = hex.replace("#", "");
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16);
    var g = parseInt(h.slice(2, 4), 16);
    var b = parseInt(h.slice(4, 6), 16);
    return "rgba(" + r + ", " + g + ", " + b + ", " + a + ")";
  }

  // ------------------------------------------------------ resize handles

  var DIRS = ["nw", "n", "ne", "e", "se", "s", "sw", "w"];

  function positionHandles() {
    var el = state.selected;
    if (!el) return clearHandles();

    if (!state.handles) {
      state.handles = document.createElement("div");
      state.handles.className = "ve-handles";
      document.body.appendChild(state.handles);
    }
    var box = el.getBoundingClientRect();
    var h = state.handles;
    h.style.left = box.left + "px";
    h.style.top = box.top + "px";
    h.style.width = box.width + "px";
    h.style.height = box.height + "px";

    if (!h.children.length) {
      /* A transparent surface covering the selection, so the element can be
         dragged without the page's own click handlers firing. Sits under the
         handles, which are appended after it. */
      var surface = document.createElement("div");
      surface.className = "ve-move-surface";
      surface.addEventListener("pointerdown", startMove);
      h.appendChild(surface);

      DIRS.forEach(function (dir) {
        var k = document.createElement("div");
        k.className = "ve-handle";
        k.setAttribute("data-dir", dir);
        k.addEventListener("pointerdown", startResize);
        h.appendChild(k);
      });
      var badge = document.createElement("div");
      badge.className = "ve-size-badge";
      h.appendChild(badge);

      /* Delete sits above the selection's top-left, clear of the nw resize
         handle so scaling stays possible. */
      var del = document.createElement("button");
      del.className = "ve-del-btn";
      del.title = "Remove this element (undoable)";
      del.innerHTML =
        '<svg viewBox="0 0 16 16" fill="none" stroke="#fff" stroke-width="1.4" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M2.5 4.5h11"/>' +
          '<path d="M6.5 4.5V3h3v1.5"/>' +
          '<path d="M4 4.5l.7 8.2a1 1 0 0 0 1 .8h4.6a1 1 0 0 0 1-.8l.7-8.2"/>' +
          '<path d="M6.8 7v4M9.2 7v4"/>' +
        "</svg>";
      del.addEventListener("pointerdown", function (ev) { ev.stopPropagation(); });
      del.addEventListener("click", function (ev) {
        ev.preventDefault();
        ev.stopPropagation();
        if (state.selected) removeElement(state.selected);
      });
      h.appendChild(del);
    }

    /* Static elements used to get their move surface disabled here, which made
       them impossible to drag at all. The surface stays live now; startMove
       lifts them to position:relative on the fly. */
    var surfaceEl = h.querySelector(".ve-move-surface");
    if (surfaceEl) surfaceEl.classList.remove("is-off");

    DIRS.forEach(function (dir, i) {
      var k = h.querySelector('[data-dir="' + dir + '"]');
      if (!k) return;
      var pos = handlePos(dir);
      k.style.left = pos.x * 100 + "%";
      k.style.top = pos.y * 100 + "%";
    });

    var badgeEl = h.querySelector(".ve-size-badge");
    if (badgeEl) badgeEl.textContent = Math.round(box.width) + " × " + Math.round(box.height);
  }

  function handlePos(dir) {
    var x = dir.indexOf("w") !== -1 ? 0 : (dir.indexOf("e") !== -1 ? 1 : 0.5);
    var y = dir.indexOf("n") !== -1 ? 0 : (dir.indexOf("s") !== -1 ? 1 : 0.5);
    return { x: x, y: y };
  }

  function clearHandles() {
    if (state.handles) state.handles.remove();
    state.handles = null;
  }

  /* Removal is expressed as `display: none`, not as ripping the node out of the
     DOM. That keeps it a normal history entry — undoable, mutable with the eye
     in the history list — and it survives the project sheet re-rendering from
     JSON. Elements the editor itself inserted are genuinely deleted instead,
     since nothing in the page depends on them. */
  function removeElement(el) {
    var inserted = insertedRecordFor(el);
    if (inserted) {
      deleteEntry(inserted.id);
      deselect();
      toast("Uploaded element deleted");
      return;
    }

    var n = scopeCount(el);
    if (n > 1 && !isolated(el)) {
      /* Hiding a shared selector would wipe every sibling. Almost never what
         someone means when they click delete on one card. */
      setIsolated(el, true);
      toast("Removing this instance only");
    }

    var sel = selectorFor(el);
    record(sel, "display", "none", null, "Removed");
    deselect();
    toast("Element removed — ⌘Z to undo");
  }

  /* Dragging writes back in the property's authored unit, so a drag on a
     cqw-sized element produces cqw — the layout stays fluid. */
  function startResize(e) {
    e.preventDefault();
    e.stopPropagation();
    var el = state.selected;
    if (!el) return;

    var dir = e.currentTarget.getAttribute("data-dir");
    var box = el.getBoundingClientRect();
    var startX = e.clientX;
    var startY = e.clientY;
    var startW = box.width;
    var startH = box.height;

    var wInfo = authoredValue(el, "width");
    var hInfo = authoredValue(el, "height");
    var wUnit = wInfo.unit && wInfo.unit !== "px" ? wInfo.unit : "%";
    var hUnit = hInfo.unit && hInfo.unit !== "px" ? hInfo.unit : "%";
    var keepRatio = e.shiftKey || el.tagName.toLowerCase() === "img";
    var ratio = startH ? startW / startH : 1;

    sealStep();
    state.dragging = true;
    var pending = {};

    function move(ev) {
      var dx = ev.clientX - startX;
      var dy = ev.clientY - startY;
      if (dir.indexOf("w") !== -1) dx = -dx;
      if (dir.indexOf("n") !== -1) dy = -dy;

      var w = startW;
      var h = startH;
      if (dir.indexOf("e") !== -1 || dir.indexOf("w") !== -1) w = Math.max(4, startW + dx);
      if (dir.indexOf("n") !== -1 || dir.indexOf("s") !== -1) h = Math.max(4, startH + dy);

      if (keepRatio && !ev.altKey) {
        if (dir === "e" || dir === "w") h = w / ratio;
        else if (dir === "n" || dir === "s") w = h * ratio;
        else h = w / ratio;
      }

      if (w !== startW || dir.indexOf("e") !== -1 || dir.indexOf("w") !== -1) {
        pending.width = round(pxToUnit(w, el, wUnit)) + wUnit;
        setPropQuiet(el, "width", pending.width);
      }
      // Images keep aspect-ratio via height:auto in this design; only write
      // height when the drag actually needs it.
      if (!keepRatio && (dir.indexOf("n") !== -1 || dir.indexOf("s") !== -1)) {
        pending.height = round(pxToUnit(h, el, hUnit)) + hUnit;
        setPropQuiet(el, "height", pending.height);
      }
      positionHandles();
    }

    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      state.dragging = false;

      /* Commit the drag as one history entry per property, using the value it
         ended on. The live preview already wrote straight to overrides, so
         rebuild() from the log restores the same result. */
      var sel = selectorFor(el);
      var dragKey = "resize:" + Date.now();
      /* Flex children get stretched by the parent's flex layout, which would
         silently override the width/height we just wrote. Pin the flex basis
         so the resized value actually sticks. */
      var parentDisplay = el.parentElement ? getComputedStyle(el.parentElement).display : "";
      if (parentDisplay.indexOf("flex") !== -1 && !pending.flex) {
        pending.flex = "0 0 auto";
        setPropQuiet(el, "flex", "0 0 auto");
      }
      Object.keys(pending).forEach(function (prop) {
        record(sel, prop, pending[prop], dragKey, "Resize");
      });
      sealStep();
      if (state.selected) buildPanel(state.selected);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  /* Drag the element itself to reposition it. Only meaningful when the element
     is already positioned; static elements are laid out by flow, and writing
     top/left would do nothing visible. */
  function startMove(e) {
    var el = state.selected;
    if (!el || state.mode !== "select") return;

    var cs = getComputedStyle(el);
    /* Static elements are laid out by flow, so left/top would do nothing —
       instead of refusing to move, lift the element to position:relative and
       drive offsets from zero. */
    var wasStatic = cs.position === "static";
    if (wasStatic) setPropQuiet(el, "position", "relative");

    e.preventDefault();
    e.stopPropagation();

    var startX = e.clientX;
    var startY = e.clientY;
    var box = el.getBoundingClientRect();

    /* inset:0-style elements are pinned on BOTH edges; writing left while
       right stays 0 stretches the box instead of moving it. Pin the size and
       release the far edge first, then drive the near edge. The released
       edges and pinned size join the same history entry so undo restores
       the stretchy behaviour.

       Size MUST come from layoutCssSize (offsetWidth-based): this site scales
       the phone frame with transform, so getBoundingClientRect returns zoomed
       pixels that would blow the element up when written back. */
    var stretchFix = {};
    if (!wasStatic) {
      if (cs.left !== "auto" && cs.right !== "auto") {
        stretchFix.right = "auto";
        stretchFix.width = layoutCssSize(el, "width");
      }
      if (cs.top !== "auto" && cs.bottom !== "auto") {
        stretchFix.bottom = "auto";
        stretchFix.height = layoutCssSize(el, "height");
      }
      Object.keys(stretchFix).forEach(function (p) {
        setPropQuiet(el, p, stretchFix[p]);
      });
    }

    /* Work out which axis properties to drive. An element pinned with `right`
       must keep being driven by `right`, or it would jump when we start
       writing `left`. */
    var useRight = !wasStatic && cs.right !== "auto" && cs.left === "auto";
    var useBottom = !wasStatic && cs.bottom !== "auto" && cs.top === "auto";
    var xProp = useRight ? "right" : "left";
    var yProp = useBottom ? "bottom" : "top";

    var xInfo = authoredValue(el, xProp);
    var yInfo = authoredValue(el, yProp);
    var xUnit = wasStatic ? "px" : (xInfo.unit || "px");
    var yUnit = wasStatic ? "px" : (yInfo.unit || "px");
    var startXVal = wasStatic ? 0 : (isNaN(xInfo.num) ? pxToUnit(box.left, el, xUnit) : xInfo.num);
    var startYVal = wasStatic ? 0 : (isNaN(yInfo.num) ? pxToUnit(box.top, el, yUnit) : yInfo.num);

    sealStep();
    state.dragging = true;
    document.documentElement.setAttribute("data-ve-moving", "");
    var pending = {};

    function move(ev) {
      var dx = ev.clientX - startX;
      var dy = ev.clientY - startY;

      // Shift locks to the dominant axis, as in every design tool.
      if (ev.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0;
      }
      if (useRight) dx = -dx;
      if (useBottom) dy = -dy;

      pending[xProp] = round(startXVal + pxToUnit(dx, el, xUnit)) + xUnit;
      pending[yProp] = round(startYVal + pxToUnit(dy, el, yUnit)) + yUnit;
      setPropQuiet(el, xProp, pending[xProp]);
      setPropQuiet(el, yProp, pending[yProp]);
      positionHandles();
    }

    function up() {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      state.dragging = false;
      document.documentElement.removeAttribute("data-ve-moving");

      var sel = selectorFor(el);
      var moveKey = "move:" + Date.now();
      // The relative lift is part of the same move step, so undo reverts both.
      if (wasStatic) pending.position = "relative";
      // Edge-release + size pins from the inset fix are the same gesture too.
      Object.keys(stretchFix).forEach(function (p) { pending[p] = stretchFix[p]; });
      Object.keys(pending).forEach(function (prop) {
        record(sel, prop, pending[prop], moveKey, "move");
      });
      sealStep();
      if (state.selected) buildPanel(state.selected);
    }

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  }

  // Write + re-render CSS without hitting history on every pointermove.
  function setPropQuiet(el, prop, value) {
    writeProp(selectorFor(el), prop, value);
    renderStyle();
  }

  /* Layout-unit size for writing back as a CSS width/height. offsetWidth is
     immune to ancestor transforms (this site transform-scales the phone
     frame), while getBoundingClientRect would return zoomed pixels. Adjusted
     for box-sizing so the value matches the width property's meaning. */
  function layoutCssSize(el, prop) {
    var cs = getComputedStyle(el);
    var v = prop === "width" ? el.offsetWidth : el.offsetHeight;
    if (cs.boxSizing !== "border-box") {
      if (prop === "width") {
        v -= parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) +
             parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth);
      } else {
        v -= parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) +
             parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      }
    }
    return round(Math.max(1, v)) + "px";
  }

  // ---------------------------------------------------------------- chrome

  /* The editor's mark: blue disc, lime diamond, dark core. It doubles as the
     collapse toggle AND the drag handle for the toolbar, which is why there is
     no separate eye and no dotted grip any more. */
  var LOGO_SVG =
    '<svg class="ve-logo" viewBox="0 0 120 120" aria-hidden="true">' +
      /* The disc and gem carry classes so the collapsed state can recolour the
         mark from CSS without touching the markup. */
      '<circle class="ve-logo-disc" cx="60" cy="60" r="52" fill="#1b4dff"/>' +
      '<path class="ve-logo-gem" d="M60 22 L98 60 L60 98 L22 60 Z" fill="#ddf14a"/>' +
      '<circle cx="60" cy="60" r="16" fill="#0b0b0b" stroke="#f5f4f1" stroke-width="4"/>' +
    "</svg>";

  function buildChrome() {
    /* Master toolbar, top-right: mode, history and saving. Deliberately
       separate from the inspector so it stays put while the panel is dragged. */
    var bar = document.createElement("div");
    bar.className = "ve-bar";
    bar.innerHTML =
      /* NOTE ON ICON GEOMETRY — every path below is drawn so its *ink* bounding
         box is centred in the 16×16 viewBox. Centring the <svg> element is not
         enough: if the drawn shape sits low or left inside its own viewBox, the
         icon looks off-centre no matter how perfectly the button is aligned.
         Verified with getBBox(); keep |dx|,|dy| ≤ 0.05 when editing these. */
      '<button class="ve-bar-btn ve-mode-btn" data-ve-mode data-ve-collapsible ' +
        'title="Editing — click to browse the page normally (⌘E)">' +
        /* Pen nib for edit mode, arrow cursor for browse mode. */
        '<svg class="ve-mode-pen" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
          'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M11 3.01a1.4 1.4 0 0 1 2 2L5.6 12.41l-3 1 1-3z"/>' +
          '<path d="M9.6 4.41l2 2"/>' +
        "</svg>" +
        '<svg class="ve-mode-cursor" viewBox="0 0 16 16" fill="none" stroke="currentColor" ' +
          'stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M3.9 2.2l8.2 6.1-3.5.5 2 4.2-1.6.8-2-4.2-2.4 2.5z"/>' +
        "</svg></button>" +
      '<span class="ve-bar-sep" data-ve-collapsible></span>' +
      '<button class="ve-bar-btn" data-ve-history data-ve-collapsible ' +
        'title="Change history">History</button>' +
      /* Real SVG arrows rather than the ↶ / ↷ glyphs: a text character is sized
         by font metrics and renders visibly smaller than the 15px icons beside
         it, so the set looked inconsistent. */
      '<button class="ve-bar-btn ve-icon-only" data-ve-undo data-ve-collapsible ' +
        'title="Undo (⌘Z)">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M3.4 6.35h6.2a3.4 3.4 0 1 1 0 6.8H6.4"/>' +
          '<path d="M6.4 2.85L3 6.35 6.4 9.85"/>' +
        "</svg></button>" +
      '<button class="ve-bar-btn ve-icon-only" data-ve-redo data-ve-collapsible ' +
        'title="Redo (⌘⇧Z)">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<path d="M12.6 6.35H6.4a3.4 3.4 0 1 0 0 6.8H9.6"/>' +
          '<path d="M9.6 2.85L13 6.35 9.6 9.85"/>' +
        "</svg></button>" +
      '<button class="ve-bar-btn ve-icon-only" data-ve-upload data-ve-collapsible ' +
        'title="Add an image or SVG to the page">' +
        '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" ' +
          'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="2" y="3.25" width="12" height="9.5" rx="1.5"/>' +
          '<path d="M2 10.25l3-2.8 2.4 2.2 2.6-2.9L14 9.75"/>' +
          '<circle cx="10.4" cy="6.15" r="1.1"/>' +
        "</svg></button>" +
      '<span class="ve-bar-sep" data-ve-collapsible></span>' +
      /* The Save button carries its own state: a dot for clean/dirty and a
         badge counting unsaved changes. A separate status readout was just
         restating what this button already knows. */
      '<span class="ve-save-wrap" data-ve-collapsible>' +
        '<button class="ve-bar-btn is-primary ve-save-btn" data-ve-save>' +
          '<span class="ve-save-dot"></span>' +
          '<span class="ve-save-label">Save</span>' +
        "</button>" +
        '<span class="ve-save-badge" hidden></span>' +
      "</span>" +
      '<span class="ve-menu-wrap" data-ve-collapsible>' +
        '<button class="ve-bar-btn" data-ve-saveas title="Other ways to save">Save as ▾</button>' +
        '<div class="ve-menu" hidden>' +
          '<button data-ve-export-patch><strong>Export CSS patch…</strong>' +
            "<span>A .css file of just the changes</span></button>" +
          '<button data-ve-export-copy><strong>Export clean project copy…</strong>' +
            "<span>The whole site, editor removed</span></button>" +
        "</div>" +
      "</span>" +
      '<span class="ve-bar-sep" data-ve-collapsible></span>' +
      /* The logo is the only control that survives collapsing, so it sits at
         the trailing edge where the eye used to: the bar shuts like a drawer
         down to just the mark. It is also the drag handle — click toggles,
         press-and-move moves the bar — which is why there is no dotted grip. */
      '<button class="ve-logo-btn" data-ve-logo ' +
        'title="Click to hide the editor (⌘.) · drag to move">' +
        LOGO_SVG +
        '<span class="ve-bar-badge" hidden></span></button>';
    document.body.appendChild(bar);
    state.bar = bar;

    restorePos(bar, BAR_POS_KEY, "right");
    /* The logo is both handle and button, so the drag helper is told to treat
       it as a click when the pointer barely moves. */
    makeDraggable(bar, bar.querySelector("[data-ve-logo]"), BAR_POS_KEY, "right", function () {
      setMinimised(!state.minimised);
    });

    bar.querySelector("[data-ve-mode]").onclick = toggleMode;
    bar.querySelector("[data-ve-undo]").onclick = undo;
    bar.querySelector("[data-ve-redo]").onclick = redo;
    bar.querySelector("[data-ve-history]").onclick = toggleHistory;
    bar.querySelector("[data-ve-upload]").onclick = promptUpload;
    bar.querySelector("[data-ve-save]").onclick = function () { saveToDisk(); };
    /* Collapse lives on the logo — see makeDraggable's onTap above. */

    var menu = bar.querySelector(".ve-menu");
    bar.querySelector("[data-ve-saveas]").onclick = function (e) {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    };
    menu.querySelector("[data-ve-export-patch]").onclick = function () {
      menu.hidden = true;
      openExport();
    };
    menu.querySelector("[data-ve-export-copy]").onclick = function () {
      menu.hidden = true;
      exportCleanCopy();
    };
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !e.target.closest(".ve-menu-wrap")) menu.hidden = true;
    });

    var panel = document.createElement("div");
    panel.className = "ve-panel";
    panel.innerHTML =
      '<div class="ve-panel-head">' +
        '<span class="ve-panel-logo">' + LOGO_SVG + "</span>" +
        '<span class="ve-panel-title">No selection</span>' +
        '<span class="ve-tag" hidden></span>' +
        '<button class="ve-icon-btn ve-close-btn" data-ve-hide ' +
          'title="Deselect and close (Esc)">' +
          '<svg viewBox="0 0 16 16" aria-hidden="true">' +
            '<path d="M4 4l8 8M12 4l-8 8"/></svg></button>' +
      "</div>" +
      '<div class="ve-panel-body"></div>' +
      '<div class="ve-panel-foot">' +
        '<button class="ve-btn ve-btn-blue" data-ve-step-back ' +
          'title="Undo the most recent change to this element">← Step back</button>' +
        '<button class="ve-btn ve-btn-red" data-ve-reset-el>Reset element</button>' +
        '<button class="ve-btn ve-btn-green ve-btn-wide" data-ve-replace-img hidden ' +
          'title="Pick a local file to replace this image (or background image)">Replace image…</button>' +
        '<button class="ve-btn ve-btn-gold ve-btn-wide" data-ve-ungroup hidden>Ungroup</button>' +
      "</div>";
    document.body.appendChild(panel);
    state.panel = panel;
    state.body = panel.querySelector(".ve-panel-body");

    /* The inspector floats freely again, with a magnetic rail: drag it near
       the toolbar's right-edge inset and it snaps back into alignment. */
    restorePos(panel, PANEL_POS_KEY, "free");
    makeDraggable(panel, panel.querySelector(".ve-panel-head"), PANEL_POS_KEY, "free");

    /* The eye dismisses the inspector outright. Collapsing it to a stub was
       pointless: with nothing to inspect there is nothing to show. */
    panel.querySelector("[data-ve-hide]").onclick = function () { deselect(); };

    panel.querySelector("[data-ve-step-back]").onclick = function () {
      if (state.selected) stepBackElement(state.selected);
    };

    panel.querySelector("[data-ve-reset-el]").onclick = function () {
      if (!state.selected) return;
      resetElement(state.selected);
    };

    panel.querySelector("[data-ve-replace-img]").onclick = function () {
      if (!state.selected) return;
      var t = typeOf(state.selected);
      if (t === "image" || t === "svg-img") promptReplaceImage(state.selected);
      else promptReplaceBackground(state.selected);
    };

    panel.querySelector("[data-ve-ungroup]").onclick = function () {
      if (!state.selected) return;
      var el = state.selected;
      if (currentOverride(el, "display") === "contents") {
        setProp(el, "display", null);
        toast("Re-grouped — the wrapper is back in the layout");
      } else {
        setProp(el, "display", "contents", null);
        sealStep();
        toast("Ungrouped — children now lay out as if the wrapper were not there");
      }
      positionHandles();
      buildPanel(el);
    };

    deselect();
    updateBar();

    /* Booting into a window narrower than the expanded bar: open as a drawer
       rather than overflowing. Done last, once the panel exists for
       setMinimised to tidy up. */
    if (bar.scrollWidth > window.innerWidth - 16) setMinimised(true);
  }

  /* Drop every logged change belonging to this element, returning it to the
     state the stylesheet describes. */
  function resetElement(el) {
    var sel = selectorFor(el);
    var removed = 0;
    for (var i = state.log.length - 1; i >= 0; i--) {
      var e = state.log[i];
      if (e.sel === sel || e.sel.indexOf(sel + "::") === 0 || e.sel.indexOf(sel + " ") === 0) {
        state.log.splice(i, 1);
        if (state.logIndex >= i) state.logIndex--;
        removed++;
      }
    }
    if (!removed) return toast("No changes recorded on this element");
    afterTimeTravel();
    toast("Element reset (" + plural(removed, "change") + ")");
  }

  // ------------------------------------------------------------- edit mode

  /* Browse mode hands the page back its own interactions, so the site's own
     buttons (back arrow, tabs, video controls) can be used without the editor
     swallowing every click. */
  function toggleMode() {
    state.mode = state.mode === "select" ? "browse" : "select";

    var browsing = state.mode === "browse";
    document.documentElement.toggleAttribute("data-ve-browsing", browsing);

    var btn = state.bar.querySelector("[data-ve-mode]");
    btn.classList.toggle("is-off", browsing);
    btn.title = browsing
      ? "Browsing — click to resume editing (⌘E)"
      : "Editing — click to browse the page normally (⌘E)";

    if (browsing) {
      deselect();
    } else if (state.selected) {
      // Only restore the inspector if something is actually selected.
      state.panel.removeAttribute("hidden");
    }
    toast(browsing ? "Browse mode — page clicks work normally" : "Edit mode");
  }

  // ---------------------------------------------------------- history panel

  function closeHistory() {
    if (!state.historyPanel) return;
    if (state.historyOutside) {
      document.removeEventListener("pointerdown", state.historyOutside, true);
      state.historyOutside = null;
    }
    state.historyPanel.remove();
    state.historyPanel = null;
    var btn = state.bar && state.bar.querySelector("[data-ve-history]");
    if (btn) btn.classList.remove("is-on");
  }

  function toggleHistory() {
    if (state.historyPanel) {
      closeHistory();
      return;
    }

    var p = document.createElement("div");
    p.className = "ve-history";
    p.innerHTML =
      '<div class="ve-history-head">' +
        "<strong>Change history</strong>" +
        '<span class="ve-history-count"></span>' +
        '<button class="ve-icon-btn" data-ve-history-close>✕</button>' +
      "</div>" +
      '<div class="ve-history-list"></div>' +
      '<div class="ve-history-foot">' +
        '<span class="ve-history-hint">eye = mute · trash = delete</span>' +
        '<button class="ve-btn ve-btn-red" data-ve-reset-all>Reset all</button>' +
      "</div>";
    document.body.appendChild(p);
    state.historyPanel = p;
    state.bar.querySelector("[data-ve-history]").classList.add("is-on");

    p.querySelector("[data-ve-history-close]").onclick = closeHistory;
    p.querySelector("[data-ve-reset-all]").onclick = function () {
      if (!state.log.length) return toast("Nothing to reset");
      if (!confirm("Discard every visual change (desktop + mobile)?")) return;
      state.log = [];
      state.logIndex = -1;
      afterTimeTravel();
      toast("All changes cleared");
    };

    /* Dismiss when the user clicks anywhere that is not the panel itself or the
       toolbar that owns it (dragging the bar or hitting its buttons must not
       close the popover). Capture phase so it fires before the click lands on
       page content; the panel then feels like a normal popover. */
    state.historyOutside = function (e) {
      if (!state.historyPanel) return;
      if (state.historyPanel.contains(e.target)) return;
      if (e.target.closest(".ve-bar")) return; // toolbar owns the panel
      closeHistory();
    };
    document.addEventListener("pointerdown", state.historyOutside, true);

    positionHistory();
    renderHistory();
  }

  /* Glue the panel to the toolbar: directly below it and left-aligned with the
     toolbar's left edge. The toolbar is draggable and right-anchored, so we read
     its live rect rather than trusting any stored coordinate. Re-run whenever the
     bar moves, collapses or the window resizes. */
  function positionHistory() {
    var p = state.historyPanel;
    if (!p || !state.bar) return;

    var bar = state.bar.getBoundingClientRect();
    var gap = 8;
    var vw = window.innerWidth;
    var vh = window.innerHeight;

    var width = p.offsetWidth || 322;
    // Left-align with the toolbar, but keep the whole panel on screen.
    var left = Math.max(4, Math.min(bar.left, vw - width - 4));
    var top = Math.min(bar.bottom + gap, vh - 60);

    p.style.left = Math.round(left) + "px";
    p.style.right = "auto";
    p.style.top = Math.round(top) + "px";
    // Never let it grow past the viewport bottom.
    p.style.maxHeight = Math.max(120, vh - top - 12) + "px";
  }


  function renderHistory() {
    var p = state.historyPanel;
    if (!p) return;

    var list = p.querySelector(".ve-history-list");
    list.innerHTML = "";

    p.querySelector(".ve-history-count").textContent =
      state.log.length ? plural(state.log.length, "change") : "";

    if (!state.log.length) {
      list.innerHTML = '<div class="ve-empty">No changes yet.</div>';
      return;
    }

    // Newest first: that is the end people care about.
    for (var i = state.log.length - 1; i >= 0; i--) {
      list.appendChild(historyRow(state.log[i], i));
    }
  }

  function historyRow(entry, index) {
    var row = document.createElement("div");
    row.className = "ve-history-row";
    if (entry.hidden) row.classList.add("is-muted");
    // Anything past the undo pointer is currently rolled back.
    if (index > state.logIndex) row.classList.add("is-undone");

    var main = document.createElement("button");
    main.className = "ve-history-main";
    main.title = "Select this element";

    var title = document.createElement("span");
    title.className = "ve-history-title";
    title.textContent = entry.kind === "insert"
      ? entry.label
      : entry.kind === "text"
        ? "text edit"
        : (entry.label ? entry.label + " · " + entry.prop : entry.prop);

    var meta = document.createElement("span");
    meta.className = "ve-history-meta";
    meta.textContent = entry.kind === "insert"
      ? "into " + shortSel(entry.parentSel)
      : entry.kind === "text"
        ? "“" + truncate(entry.after, 28) + "”"
        : shortSel(entry.sel) + " → " +
          (entry.after === null ? "removed" : truncate(entry.after, 22));

    main.appendChild(title);
    main.appendChild(meta);
    main.onclick = function () {
      var target = entry.kind === "insert"
        ? document.querySelector('[data-ve-inserted="' + entry.id + '"]')
        : document.querySelector(entry.sel.replace(/::before$/, ""));
      if (target && editable(target)) select(target);
      else toast("Element is off screen");
    };

    if (entry.scope === "mobile") {
      var tag = document.createElement("span");
      tag.className = "ve-history-scope";
      tag.textContent = "≤" + MOBILE_BREAKPOINT;
      main.appendChild(tag);
    }

    var eye = document.createElement("button");
    eye.className = "ve-history-act";
    eye.textContent = entry.hidden ? "◌" : "◉";
    eye.title = entry.hidden ? "Re-apply this change" : "Mute this change to preview without it";
    eye.onclick = function (e) { e.stopPropagation(); toggleEntry(entry.id); };

    var del = document.createElement("button");
    del.className = "ve-history-act is-del";
    del.textContent = "🗑";
    del.title = "Delete this change";
    del.onclick = function (e) { e.stopPropagation(); deleteEntry(entry.id); };

    row.appendChild(main);
    row.appendChild(eye);
    row.appendChild(del);
    return row;
  }

  function shortSel(sel) {
    var s = sel.replace(/^\.project-sheet\[[^\]]+\]\s*/, "");
    return truncate(s, 30);
  }

  function truncate(v, n) {
    var s = String(v);
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  }

  /* Minimise, not exit. Once the editor is loaded it stays available for the
     session — there is no "quit" that would strand unsaved work behind a page
     reload. Collapsing hides the chrome and suspends selection, and the puck
     brings it straight back. To actually leave, load the page without ?edit=1. */
  function setMinimised(on) {
    state.minimised = on;
    document.documentElement.toggleAttribute("data-ve-minimised", on);

    /* The bar collapses in place like a drawer: the same shell stays, holding
       only the logo. Keeping the real bar (rather than swapping in a separate
       puck) means it never moves, and it stays draggable while collapsed.

       Collapsing touches NOTHING but the toolbar itself. The toolbar and the
       inspector are two independent things: shutting the bar is "get the
       chrome out of my way", not "throw away what I was working on" — the
       selection, the inspector, the handles and page interaction all keep
       working while the drawer is shut. Only the history popover is closed:
       it is a transient popover anchored to the bar, so leaving it floating
       under a shut drawer would be nonsense. */
    if (on) {
      if (state.historyPanel) closeHistory();
    }

    if (state.bar) {
      state.bar.classList.toggle("is-collapsed", on);
      var logo = state.bar.querySelector("[data-ve-logo]");
      logo.classList.toggle("is-off", on);
      logo.title = on
        ? "Click to show the editor (⌘.) · drag to move"
        : "Click to hide the editor (⌘.) · drag to move";

      /* Expanding grows the bar leftwards. On a narrow window that could push
         its far edge out of view, so re-check reachability after the change. */
      keepOnScreen(state.bar, BAR_POS_KEY, "right");
    }

    updateBar();
  }

  /* While collapsed the logo carries the unsaved count, since the Save button
     it normally rides on is hidden. */
  function refreshCollapsedBadge() {
    if (!state.bar) return;
    var badge = state.bar.querySelector(".ve-bar-badge");
    if (!badge) return;
    var n = countEdits();
    if (state.minimised && n) {
      badge.textContent = n > 99 ? "99+" : n;
      badge.removeAttribute("hidden");
    } else {
      badge.setAttribute("hidden", "");
    }
  }

  function setPanelTitle(text, type) {
    var t = state.panel.querySelector(".ve-panel-title");
    var tag = state.panel.querySelector(".ve-tag");
    t.textContent = text;
    if (type) {
      var TYPE_LABEL = {
        box: "box", text: "text", image: "image",
        "svg-img": "svg", svg: "svg", video: "video"
      };
      tag.textContent = TYPE_LABEL[type] || type;
      tag.removeAttribute("hidden");
    }
    else tag.setAttribute("hidden", "");
  }

  function updateBar() {
    if (!state.bar) return;
    var bar = state.bar;

    bar.querySelector("[data-ve-undo]").disabled = state.logIndex < 0;
    bar.querySelector("[data-ve-redo]").disabled = state.logIndex >= state.log.length - 1;

    var dirty = isDirty();
    var n = countEdits();
    var saveBtn = bar.querySelector("[data-ve-save]");
    var badge = bar.querySelector(".ve-save-badge");

    bar.classList.toggle("is-dirty", dirty);
    saveBtn.classList.toggle("is-clean", !dirty);
    saveBtn.querySelector(".ve-save-label").textContent = dirty ? "Save" : "Saved";
    saveBtn.disabled = !dirty;
    saveBtn.title = dirty
      ? "Save " + plural(n, "change") + " into " + TARGET_CSS + " (⌘S)"
      : "Everything is saved";

    // Count of pending changes rides on the button itself.
    if (dirty && n) {
      badge.textContent = n > 99 ? "99+" : n;
      badge.removeAttribute("hidden");
    } else {
      badge.setAttribute("hidden", "");
    }

    refreshCollapsedBadge();
  }

  /* Shared drag behaviour for the inspector and the toolbar. `key` decides
     where the resting position is remembered, so the two never collide.

     `anchor` picks the axis policy:
       "right" — pinned by its right edge, both axes free. The toolbar uses
                 this: it changes width when it collapses, and the logo that
                 survives collapsing sits at the right edge, so pinning `left`
                 would slide that edge sideways on every open/shut.
       "free"  — like "right", but with a magnetic home: releasing the drag
                 near the toolbar's right-edge inset snaps the element back onto
                 that rail. The inspector uses this — it drags anywhere freely,
                 yet can always be parked flush under the toolbar again without
                 pixel-hunting.
       otherwise — pinned by `left`, both axes free.

     `onTap` makes the handle dual-purpose: a press that never travels past
     DRAG_SLOP is treated as a click on the handle itself, so the toolbar logo
     can be both "collapse" and "drag me" without a separate grip. Handles
     without onTap keep the old behaviour and ignore clicks on nested buttons. */
  function makeDraggable(el, handle, key, anchor, onTap) {
    var pinRight = anchor === "right" || anchor === "free";
    var DRAG_SLOP = 4;
    /* The rail inset the inspector snaps back to. Keep in sync with the
       `right` values in the stylesheet (.ve-bar and .ve-panel). */
    var SNAP_RIGHT = 16;
    var SNAP_DIST = 28;

    handle.addEventListener("pointerdown", function (e) {
      if (!onTap && e.target.closest("button")) return;
      e.preventDefault();

      var box = el.getBoundingClientRect();
      var ox = e.clientX - box.left;
      var oy = e.clientY - box.top;
      var offRight = box.right - e.clientX;
      var startX = e.clientX;
      var startY = e.clientY;
      var travelled = false;

      function move(ev) {
        if (!travelled) {
          if (Math.max(Math.abs(ev.clientX - startX),
                       Math.abs(ev.clientY - startY)) < DRAG_SLOP) return;
          travelled = true;
          handle.classList.add("is-dragging");
        }
        /* Keep a strip of the element on screen in both axes — dragging it
           fully past an edge would leave no way to grab it again. */
        var maxTop = window.innerHeight - Math.min(box.height, 40);
        el.style.top = Math.max(4, Math.min(maxTop, ev.clientY - oy)) + "px";
        el.style.bottom = "auto";

        if (pinRight) {
          var right = window.innerWidth - (ev.clientX + offRight);
          /* The magnetic rail also acts DURING the drag, not just on release:
             when the pointer carries the element near home it seats itself, so
             the user feels the pull instead of watching it land afterwards. */
          if (anchor === "free" && Math.abs(right - SNAP_RIGHT) <= SNAP_DIST)
            right = SNAP_RIGHT;
          el.style.right = Math.max(4 - box.width + 80, Math.min(window.innerWidth - 80, right)) + "px";
          el.style.left = "auto";
        } else {
          var maxLeft = window.innerWidth - Math.min(box.width, 80);
          el.style.left = Math.max(4 - box.width + 80, Math.min(maxLeft, ev.clientX - ox)) + "px";
          el.style.right = "auto";
        }
        // Keep the history popover glued under the toolbar as it drags.
        if (el === state.bar && state.historyPanel) positionHistory();
      }
      function up() {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
        handle.classList.remove("is-dragging");

        /* Never moved: this was a click on the handle, not a drag. Fire the tap
           action and leave the stored position untouched. */
        if (!travelled) {
          if (onTap) onTap();
          return;
        }
        try {
          localStorage.setItem(key, JSON.stringify({
            anchor: pinRight ? "right" : "left",
            left: el.style.left,
            right: el.style.right,
            top: el.style.top
          }));
        } catch (err) {}
      }
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    });
  }

  function restorePos(el, key, anchor) {
    try {
      var p = JSON.parse(localStorage.getItem(key) || "null");
      if (p && p.top) {
        el.style.top = p.top;
        el.style.bottom = "auto";

        /* "free" restores like a right-pinned element: the drag stores `right`
           for it, and restoring keeps it flush wherever it was parked. */
        if ((anchor === "right" || anchor === "free") && p.right) {
          el.style.right = p.right;
          el.style.left = "auto";
        } else if (anchor !== "right" && anchor !== "free" && p.left) {
          el.style.left = p.left;
          el.style.right = "auto";
        }
      }
    } catch (e) {}

    // A window narrower than last session could leave it out of reach.
    keepOnScreen(el, key, anchor);
  }

  /* Pull a floating element back into view. Called when it is restored, when
     it changes size, and after the window resizes: shrinking the viewport can
     otherwise strand the toolbar past an edge with no way to grab it again.

     `anchor` must be passed explicitly rather than sniffed from inline styles —
     on first load the toolbar's `right` comes from the stylesheet, and guessing
     "left" there would silently convert it to left-pinned and reintroduce the
     jump-on-collapse bug. */
  function keepOnScreen(el, key, anchor) {
    if (!el || !el.isConnected) return;

    var box = el.getBoundingClientRect();
    if (!box.width) return;

    var vw = window.innerWidth;
    var vh = window.innerHeight;
    /* Keep the element fully visible when it fits; if the viewport is genuinely
       narrower than the element, settle for a grabbable strip. */
    var minVisible = box.width + 4 <= vw ? box.width : 80;
    var pinnedRight = anchor === "right" || anchor === "free";
    var moved = false;

    if (pinnedRight) {
      var right = vw - box.right;
      // Too large a `right` means the element has been pushed off to the left.
      var clampedRight = Math.max(4, Math.min(vw - minVisible, right));
      if (Math.abs(clampedRight - right) > 0.5) {
        el.style.right = Math.round(clampedRight) + "px";
        el.style.left = "auto";
        moved = true;
      }
    } else {
      var clampedLeft = Math.max(4, Math.min(vw - minVisible, box.left));
      if (Math.abs(clampedLeft - box.left) > 0.5) {
        el.style.left = Math.round(clampedLeft) + "px";
        el.style.right = "auto";
        moved = true;
      }
    }

    /* Vertically the strip should sit fully in view whenever it fits — the bar
       is only 42px tall, so letting it hang off the bottom buys nothing. Tall
       elements (the inspector) fall back to keeping their top edge reachable. */
    var maxTop = Math.max(4, vh - Math.min(box.height, vh - 8) - 4);
    var clampedTop = Math.max(4, Math.min(maxTop, box.top));
    if (Math.abs(clampedTop - box.top) > 0.5) {
      el.style.top = Math.round(clampedTop) + "px";
      el.style.bottom = "auto";
      moved = true;
    }

    /* Persist the correction, otherwise the next reload would restore the
       off-screen value all over again. */
    if (moved && key) {
      try {
        localStorage.setItem(key, JSON.stringify({
          anchor: pinnedRight ? "right" : "left",
          left: el.style.left,
          right: el.style.right,
          top: el.style.top
        }));
      } catch (e) {}
    }
  }

  // ------------------------------------------------------------ save to disk

  /* Writing to the real file needs the File System Access API. The directory
     handle is remembered in IndexedDB, so the folder is picked once per
     browser rather than once per save. */
  var HANDLE_DB = "ve-handles";
  var HANDLE_STORE = "handles";

  function idb() {
    return new Promise(function (resolve, reject) {
      var req = indexedDB.open(HANDLE_DB, 1);
      req.onupgradeneeded = function () {
        req.result.createObjectStore(HANDLE_STORE);
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }

  function idbGet(key) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(HANDLE_STORE, "readonly");
        var r = tx.objectStore(HANDLE_STORE).get(key);
        r.onsuccess = function () { resolve(r.result || null); };
        r.onerror = function () { resolve(null); };
      });
    }).catch(function () { return null; });
  }

  function idbSet(key, value) {
    return idb().then(function (db) {
      return new Promise(function (resolve) {
        var tx = db.transaction(HANDLE_STORE, "readwrite");
        tx.objectStore(HANDLE_STORE).put(value, key);
        tx.oncomplete = function () { resolve(true); };
        tx.onerror = function () { resolve(false); };
      });
    }).catch(function () { return false; });
  }

  function supportsFs() {
    return typeof window.showDirectoryPicker === "function";
  }

  function getDirHandle() {
    if (state.dirHandle) return Promise.resolve(state.dirHandle);

    return idbGet("projectDir").then(function (handle) {
      if (!handle) return pickDir();
      return handle.queryPermission({ mode: "readwrite" }).then(function (p) {
        if (p === "granted") { state.dirHandle = handle; return handle; }
        return handle.requestPermission({ mode: "readwrite" }).then(function (p2) {
          if (p2 === "granted") { state.dirHandle = handle; return handle; }
          return pickDir();
        });
      }).catch(function () { return pickDir(); });
    });
  }

  function pickDir() {
    toast("Pick the project folder (the one containing " + TARGET_CSS + ")");
    return window.showDirectoryPicker({ mode: "readwrite" }).then(function (handle) {
      state.dirHandle = handle;
      idbSet("projectDir", handle);
      return handle;
    });
  }

  function saveToDisk() {
    if (!countEdits()) return toast("No changes to save");

    if (!supportsFs()) {
      toast("This browser cannot write files — exporting a patch instead");
      return openExport();
    }

    var btn = state.bar.querySelector("[data-ve-save]");
    var label = btn.querySelector(".ve-save-label");
    btn.disabled = true;
    label.textContent = "Saving…";

    getDirHandle()
      .then(function (dir) { return dir.getFileHandle(TARGET_CSS, { create: false }); })
      .then(function (fileHandle) {
        return fileHandle.getFile()
          .then(function (file) { return file.text(); })
          .then(function (existing) {
            var merged = mergeManagedBlock(existing, buildManagedBlock());
            return fileHandle.createWritable().then(function (w) {
              return w.write(merged).then(function () { return w.close(); });
            });
          });
      })
      .then(function () {
        state.savedSnapshot = snapshot();
        try { localStorage.setItem(SAVED_KEY, state.savedSnapshot); } catch (e) {}
        updateBar();
        toast("Saved to " + TARGET_CSS);
        bumpStylesheet();
      })
      .catch(function (err) {
        var msg = err && err.name === "AbortError"
          ? "Save cancelled"
          : "Could not write " + TARGET_CSS + " — " + (err && err.message ? err.message : "unknown error");
        toast(msg);
      })
      .then(function () {
        btn.disabled = false;
        updateBar();
      });
  }

  /* Replace (or append) our managed block so repeated saves stay idempotent
     rather than piling duplicate rules at the end of the file. */
  function mergeManagedBlock(existing, blockText) {
    var start = existing.indexOf(BLOCK_BEGIN);
    var end = existing.indexOf(BLOCK_END);

    if (start !== -1 && end !== -1 && end > start) {
      var before = existing.slice(0, start);
      var after = existing.slice(end + BLOCK_END.length);
      return before.replace(/\s*$/, "\n\n") + blockText + after.replace(/^\s*/, "\n");
    }
    return existing.replace(/\s*$/, "\n") + "\n" + blockText + "\n";
  }

  function buildManagedBlock() {
    var stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    var lines = [
      BLOCK_BEGIN,
      "/* Last written " + stamp + " from the in-page editor.",
      "   Units are preserved as authored (cqw / % / em), so responsive",
      "   behaviour is intact. Values are appended here rather than folded into",
      "   the declarations above; ask the agent to merge them properly when the",
      "   design is final. */",
      ""
    ];
    lines.push(buildCss(false));
    lines.push(BLOCK_END);
    return lines.join("\n");
  }

  // Force the browser to re-read the file we just rewrote.
  function bumpStylesheet() {
    var link = document.querySelector('link[href*="' + TARGET_CSS + '"]');
    if (!link) return;
    var base = link.getAttribute("href").split("?")[0];
    link.setAttribute("href", base + "?v=" + Date.now());
  }

  // ----------------------------------------------------------- text editing

  /* A node whose content is just words — no element children worth descending
     into. Those are the ones worth typing in. */
  function isTextLeaf(el) {
    if (!el || el.nodeType !== 1) return false;
    if (/^(img|svg|video|canvas|input|select|textarea|br|hr)$/i.test(el.tagName)) return false;
    if (!el.textContent || !el.textContent.trim()) return false;

    for (var i = 0; i < el.children.length; i++) {
      // Inline decoration is fine; a block child means this is a container.
      var display = getComputedStyle(el.children[i]).display;
      if (display !== "inline" && display !== "contents") return false;
    }
    return true;
  }

  function startTextEdit(el) {
    if (state.editingText) return;

    var original = el.innerHTML;
    var originalText = el.textContent;

    state.editingText = { el: el, original: original };
    el.setAttribute("data-ve-editing", "");
    el.setAttribute("contenteditable", "plaintext-only");
    el.focus();

    // Put the caret at the end rather than selecting everything.
    var range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);

    clearHandles();
    toast("Editing text — Enter to apply, Esc to cancel");

    var done = false;

    function finish(commit) {
      /* Enter and blur both fire when committing with the keyboard, so the
         first one through wins and the second is ignored — otherwise every
         edit lands in the history twice. */
      if (done || !state.editingText) return;
      done = true;

      el.removeAttribute("contenteditable");
      el.removeAttribute("data-ve-editing");
      el.removeEventListener("keydown", onKey);
      el.removeEventListener("blur", onBlur);
      state.editingText = null;

      var nextText = el.textContent;
      if (!commit || nextText === originalText) {
        el.innerHTML = original;
        if (commit) toast("Text unchanged");
        else toast("Edit cancelled");
      } else {
        /* Store the plain string: preserving arbitrary inner markup would make
           the patch unreviewable, and these are one-line labels. */
        var text = nextText.replace(/\s+/g, " ").trim();
        el.innerHTML = original;   // restored, then re-applied through the log
        recordText(el, text, originalText.replace(/\s+/g, " ").trim());
      }

      positionHandles();
      if (state.selected === el) buildPanel(el);
    }

    function onKey(ev) {
      ev.stopPropagation();
      if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
      // Enter commits; Shift+Enter is left alone for multi-line labels.
      else if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); finish(true); }
    }

    function onBlur() { finish(true); }

    el.addEventListener("keydown", onKey);
    el.addEventListener("blur", onBlur);
  }

  /* Text lives in the log as its own entry kind, so it is undoable and shows up
     in the history list beside style changes. */
  function recordText(el, text, before) {
    sealStep();

    if (state.logIndex < state.log.length - 1) {
      state.log.length = state.logIndex + 1;
    }

    var entry = {
      id: state.nextId++,
      ts: Date.now(),
      kind: "text",
      scope: scope(),
      sel: uniqueSelectorFor(el),
      prop: "text",
      before: before,
      after: text,
      label: "text",
      hidden: false
    };

    state.log.push(entry);
    state.logIndex = state.log.length - 1;

    rebuild();
    save();
    sealStep();
    toast("Text updated");
  }

  /* Text entries are replayed by writing into the DOM, since CSS cannot carry
     content. Re-applied on every rebuild so undo and the eye both work. */
  function syncTextEdits() {
    var wanted = {};
    for (var i = 0; i <= state.logIndex && i < state.log.length; i++) {
      var e = state.log[i];
      if (!e || e.hidden || e.kind !== "text") continue;
      wanted[e.sel] = e;   // last write for a selector wins
    }

    Object.keys(wanted).forEach(function (sel) {
      var e = wanted[sel];
      var node;
      try { node = document.querySelector(sel); } catch (err) { return; }
      if (node && node.textContent !== e.after) node.textContent = e.after;
    });

    // Anything no longer wanted goes back to its recorded original.
    state.log.forEach(function (e, idx) {
      if (e.kind !== "text") return;
      var live = !e.hidden && idx <= state.logIndex && wanted[e.sel] === e;
      if (live) return;
      var node;
      try { node = document.querySelector(e.sel); } catch (err) { return; }
      if (node && !wanted[e.sel] && node.textContent !== e.before) {
        node.textContent = e.before;
      }
    });
  }

  /* Attribute changes (e.g. replacing an <img> src) get their own entry kind
     for the same reason text does: CSS cannot carry them, but they must be
     undoable and appear in history beside style changes. */
  function recordAttr(el, attr, value, label) {
    sealStep();

    if (state.logIndex < state.log.length - 1) {
      state.log.length = state.logIndex + 1;
    }

    var entry = {
      id: state.nextId++,
      ts: Date.now(),
      kind: "attr",
      scope: scope(),
      sel: uniqueSelectorFor(el),
      prop: attr,
      before: el.getAttribute(attr),
      after: value,
      label: label || "Attribute",
      hidden: false
    };

    state.log.push(entry);
    state.logIndex = state.log.length - 1;

    rebuild();
    save();
    sealStep();
    return entry;
  }

  /* Replayed on every rebuild so undo and the eye both work, mirroring
     syncTextEdits. Keyed on selector+attribute so repeated replacements of
     the same src collapse to the latest one. */
  function syncAttrEdits() {
    var wanted = {};
    for (var i = 0; i <= state.logIndex && i < state.log.length; i++) {
      var e = state.log[i];
      if (!e || e.hidden || e.kind !== "attr") continue;
      wanted[e.sel + "|" + e.prop] = e;   // last write wins
    }

    Object.keys(wanted).forEach(function (k) {
      var e = wanted[k];
      var node;
      try { node = document.querySelector(e.sel); } catch (err) { return; }
      if (node && node.getAttribute(e.prop) !== e.after) {
        node.setAttribute(e.prop, e.after);
      }
    });

    // Anything no longer wanted goes back to its recorded original.
    state.log.forEach(function (e, idx) {
      if (e.kind !== "attr") return;
      var k = e.sel + "|" + e.prop;
      var live = !e.hidden && idx <= state.logIndex && wanted[k] === e;
      if (live || wanted[k]) return;
      var node;
      try { node = document.querySelector(e.sel); } catch (err) { return; }
      if (!node) return;
      if (e.before === null) node.removeAttribute(e.prop);
      else if (node.getAttribute(e.prop) !== e.before) {
        node.setAttribute(e.prop, e.before);
      }
    });
  }

  // -------------------------------------------------------------- uploading

  var UPLOAD_DIR = "assets/uploads";

  function promptUpload() {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    input.multiple = false;
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (file) handleUpload(file);
    };
    input.click();
  }

  /* Where a new element lands: inside the current selection if one exists,
     otherwise the visible page panel, otherwise body. Appending into the
     selection is what makes "select a section, then upload into it" work. */
  function uploadHost() {
    if (state.selected && document.contains(state.selected)) {
      var el = state.selected;
      // Images cannot contain children — use the parent instead.
      if (/^(img|svg|video|input|br|hr)$/i.test(el.tagName)) {
        return el.parentElement || document.body;
      }
      return el;
    }
    var panel = document.querySelector(".page-panel.is-active, .project-sheet, main, .site-shell");
    return panel || document.body;
  }

  function handleUpload(file) {
    var host = uploadHost();
    var isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name);

    toast("Adding " + file.name + "…");

    var writeFile = supportsFs()
      ? writeUploadToDisk(file)
      : Promise.resolve(null);

    writeFile
      .then(function (relPath) {
        if (isSvg && !relPath) {
          // No disk access: inline the SVG source rather than a data URI.
          return file.text().then(function (text) { return { svg: text }; });
        }
        if (relPath) return { path: relPath };
        return readAsDataUrl(file).then(function (url) { return { data: url }; });
      })
      .then(function (source) {
        var html = buildUploadHtml(source, file, isSvg);
        var entry = recordInsert(host, html, file.name);
        var node = document.querySelector('[data-ve-inserted="' + entry.id + '"]');
        if (node) {
          select(node);
          toast(source.path
            ? "Added " + source.path
            : "Added " + file.name + " (embedded — no folder access)");
        } else {
          toast("Added, but the container is off screen");
        }
      })
      .catch(function (err) {
        toast("Upload failed — " + (err && err.message ? err.message : "unknown error"));
      });
  }

  /* Swap an existing <img> for a file from disk. The file lands in
     assets/uploads/ exactly like a fresh upload; the src swap itself is
     logged as an attr entry so undo / mute / history all work on it. */
  function promptReplaceImage(el) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    input.multiple = false;
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (file) replaceImage(el, file);
    };
    input.click();
  }

  function replaceImage(el, file) {
    toast("Replacing image…");

    var writeFile = supportsFs()
      ? writeUploadToDisk(file)
      : Promise.resolve(null);

    writeFile
      .then(function (relPath) {
        if (relPath) return { url: relPath, onDisk: true };
        return readAsDataUrl(file).then(function (url) {
          return { url: url, onDisk: false };
        });
      })
      .then(function (res) {
        recordAttr(el, "src", res.url, "Replace image");
        toast(res.onDisk
          ? "Replaced with " + res.url
          : "Replaced (embedded — no folder access)");
        if (state.selected === el) buildPanel(el);
      })
      .catch(function (err) {
        toast("Replace failed — " + (err && err.message ? err.message : "unknown error"));
      });
  }

  /* Same swap for elements whose image is a CSS background: the url() layer
     is replaced in place, gradient overlays and sizing (center/cover) keep
     working untouched. Pure CSS, so it exports like any other override. */
  function promptReplaceBackground(el) {
    var input = document.createElement("input");
    input.type = "file";
    input.accept = "image/png,image/jpeg,image/webp,image/gif,image/svg+xml";
    input.multiple = false;
    input.onchange = function () {
      var file = input.files && input.files[0];
      if (!file) return;
      toast("Replacing background…");
      var writeFile = supportsFs() ? writeUploadToDisk(file) : Promise.resolve(null);
      writeFile
        .then(function (relPath) {
          if (relPath) return { url: relPath, onDisk: true };
          return readAsDataUrl(file).then(function (url) {
            return { url: url, onDisk: false };
          });
        })
        .then(function (res) {
          var bg = currentOverride(el, "background-image") ||
            getComputedStyle(el).backgroundImage;
          var next = bg.replace(/url\(["']?[^"')]+["']?\)/, 'url("' + res.url + '")');
          setProp(el, "background-image", next, null);
          sealStep();
          toast(res.onDisk
            ? "Background replaced with " + res.url
            : "Background replaced (embedded — no folder access)");
          if (state.selected === el) buildPanel(el);
        })
        .catch(function (err) {
          toast("Replace failed — " + (err && err.message ? err.message : "unknown error"));
        });
    };
    input.click();
  }

  /* Prefer a real file in assets/uploads/ over a data URI: base64 in a
     stylesheet or in index.html bloats the page and is miserable to diff. */
  function writeUploadToDisk(file) {
    return getDirHandle()
      .then(function (dir) {
        return dir.getDirectoryHandle("assets", { create: true })
          .then(function (assets) {
            return assets.getDirectoryHandle("uploads", { create: true });
          });
      })
      .then(function (uploads) {
        var name = safeFileName(file.name);
        return uploads.getFileHandle(name, { create: true })
          .then(function (handle) { return handle.createWritable(); })
          .then(function (w) {
            return file.arrayBuffer()
              .then(function (buf) { return w.write(buf); })
              .then(function () { return w.close(); });
          })
          .then(function () { return UPLOAD_DIR + "/" + name; });
      })
      .catch(function () { return null; });   // fall back to embedding
  }

  function safeFileName(name) {
    var cleaned = String(name).replace(/[^\w.\-]+/g, "-").replace(/^-+|-+$/g, "");
    if (!cleaned) cleaned = "upload";
    // Timestamp keeps repeated uploads of the same name from clobbering.
    var dot = cleaned.lastIndexOf(".");
    var stem = dot > 0 ? cleaned.slice(0, dot) : cleaned;
    var ext = dot > 0 ? cleaned.slice(dot) : "";
    return stem + "-" + Date.now().toString(36) + ext;
  }

  function readAsDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(r.result); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(file);
    });
  }

  function buildUploadHtml(source, file, isSvg) {
    var alt = String(file.name).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");

    if (source.svg) {
      /* Inline SVG so its fill and stroke are editable straight away, which is
         usually why an SVG is being added rather than a PNG. */
      var doc = new DOMParser().parseFromString(source.svg, "image/svg+xml");
      var svg = doc.querySelector("svg");
      if (svg) {
        svg.setAttribute("class", "ve-upload");
        svg.removeAttribute("width");
        svg.removeAttribute("height");
        return svg.outerHTML;
      }
    }

    var src = source.path || source.data;
    return '<img class="ve-upload" src="' + src + '" alt="' + escapeAttr(alt) + '" />';
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;")
      .replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /* An insert is a log entry like any other, so undo/redo and the history list
     handle it without special cases. */
  function recordInsert(host, html, label) {
    sealStep();

    if (state.logIndex < state.log.length - 1) {
      state.log.length = state.logIndex + 1;
    }

    var entry = {
      id: state.nextId++,
      ts: Date.now(),
      kind: "insert",
      scope: scope(),
      parentSel: uniqueSelectorFor(host),
      html: html,
      label: "Added " + label,
      sel: "",
      prop: "element",
      before: null,
      after: label,
      hidden: false
    };

    state.log.push(entry);
    state.logIndex = state.log.length - 1;

    rebuild();
    save();
    sealStep();
    return entry;
  }

  // ---------------------------------------------------------------- export

  function openExport() {
    var modal = document.createElement("div");
    modal.className = "ve-modal";
    var css = exportCss();
    modal.innerHTML =
      '<div class="ve-modal-box">' +
        '<div class="ve-modal-head"><h3>Save as — export patch</h3>' +
        '<button class="ve-icon-btn" data-ve-close>✕</button></div>' +
        "<textarea spellcheck=\"false\"></textarea>" +
        '<div class="ve-modal-foot">' +
          '<span class="ve-modal-hint"></span>' +
          '<button class="ve-btn" data-ve-copy>Copy</button>' +
          '<button class="ve-btn ve-btn-primary" data-ve-download>Download .css</button>' +
          '<button class="ve-btn" data-ve-json>Copy JSON</button>' +
        "</div>" +
      "</div>";
    document.body.appendChild(modal);

    var ta = modal.querySelector("textarea");
    ta.value = css;
    modal.querySelector(".ve-modal-hint").textContent =
      countEdits() + " declarations · this leaves " + TARGET_CSS + "。";

    modal.querySelector("[data-ve-close]").onclick = function () { modal.remove(); };
    modal.addEventListener("click", function (e) { if (e.target === modal) modal.remove(); });

    modal.querySelector("[data-ve-copy]").onclick = function () {
      ta.select();
      navigator.clipboard.writeText(ta.value).then(function () { toast("CSS copied"); },
        function () { document.execCommand("copy"); toast("CSS copied"); });
    };

    modal.querySelector("[data-ve-download]").onclick = function () {
      download("visual-edits.css", ta.value);
      /* Exporting is an explicit save action too, so clear the dirty flag —
         otherwise the bar keeps nagging about work the user just banked. */
      state.savedSnapshot = snapshot();
      try { localStorage.setItem(SAVED_KEY, state.savedSnapshot); } catch (e) {}
      updateBar();
      toast("Exported visual-edits.css");
    };

    modal.querySelector("[data-ve-json]").onclick = function () {
      var payload = JSON.stringify({
        generated: new Date().toISOString(),
        breakpoint: MOBILE_BREAKPOINT,
        inlinedSvg: state.inlinedSvg,
        overrides: state.overrides
      }, null, 2);
      navigator.clipboard.writeText(payload).then(function () { toast("JSON copied"); });
    };
  }

  function exportCss() {
    if (!countEdits()) return "/* No edits yet. */";

    /* A machine-readable banner. Any agent handed this file can identify what
       produced it, which stylesheet it belongs to, and how to merge it —
       without the user having to explain. Keep this format stable. */
    var head = [
      "/* " + PATCH_SIGNATURE,
      " * generator: visual-editor (tools/visual-editor.js)",
      " * format:    " + PATCH_FORMAT,
      " * generated: " + new Date().toISOString(),
      " * target:    " + TARGET_CSS,
      " * breakpoint: mobile <= " + MOBILE_BREAKPOINT + "px",
      " * declarations: " + countEdits(),
      " *",
      " * FOR AGENTS — how to apply this patch:",
      " *  1. These are visual tweaks captured in-browser. Units are authored",
      " *     units (cqw / % / em) and MUST be preserved verbatim; converting",
      " *     them to px silently breaks this design's responsive behaviour.",
      " *  2. Merge each declaration into the matching existing rule in",
      " *     " + TARGET_CSS + " rather than appending this block wholesale.",
      " *  3. Drop the `!important` flags during the merge. They exist only to",
      " *     out-weigh existing high-specificity selectors while iterating.",
      " *  4. Rules inside @media (max-width: " + MOBILE_BREAKPOINT + "px) are mobile-only and must",
      " *     stay inside that query.",
      " */",
      ""
    ].join("\n");

    var svgNote = "";
    var inlined = Object.keys(state.inlinedSvg);
    if (inlined.length) {
      svgNote = "\n/* NOTE — these <img> tags were converted to inline <svg> at runtime so their\n" +
        "   paint could be edited. To bake this, inline them in index.html (or edit the\n" +
        "   source .svg files directly):\n" +
        inlined.map(function (s) { return "   - " + s + "  ←  " + state.inlinedSvg[s]; }).join("\n") +
        "\n*/\n";
    }

    return head + buildCss(false) + svgNote + structureNote();
  }

  /* CSS cannot add or truly delete markup, so structural changes are reported
     as a checklist instead of being silently dropped from the patch. */
  function structureNote() {
    var inserts = [];
    var removals = [];
    var texts = [];
    var attrs = [];

    state.log.forEach(function (e, i) {
      if (e.hidden || i > state.logIndex) return;
      if (e.kind === "insert") inserts.push(e);
      else if (e.kind === "text") texts.push(e);
      else if (e.kind === "attr") attrs.push(e);
      else if (e.prop === "display" && e.after === "none") removals.push(e);
    });

    if (!inserts.length && !removals.length && !texts.length && !attrs.length) return "";

    var lines = [
      "",
      "/* --------------------------------------------------------------------------",
      "   STRUCTURAL CHANGES — these need HTML edits; CSS alone cannot express them.",
      "   -------------------------------------------------------------------------- */",
      ""
    ];

    if (texts.length) {
      lines.push("/* COPY CHANGES — update the wording in index.html, or in the JSON under");
      lines.push("   data/projects/ if the text is rendered from there: */");
      texts.forEach(function (e) {
        lines.push("/*");
        lines.push("   at:   " + e.sel);
        lines.push("   from: " + JSON.stringify(e.before));
        lines.push("   to:   " + JSON.stringify(e.after));
        lines.push("*/");
      });
      lines.push("");
    }

    if (inserts.length) {
      lines.push("/* ADDED ELEMENTS — paste each snippet inside the given parent: */");
      inserts.forEach(function (e) {
        lines.push("/*");
        lines.push("   parent: " + e.parentSel);
        lines.push("   append: " + e.html.replace(/\s+/g, " ").trim());
        lines.push("*/");
      });
      lines.push("");
      lines.push("/* Uploaded files live in " + UPLOAD_DIR + "/ — keep them with the project. */");
      lines.push("");
    }

    if (removals.length) {
      lines.push("/* REMOVED ELEMENTS — hidden via display:none above. To delete them");
      lines.push("   properly, remove these from index.html instead: */");
      removals.forEach(function (e) {
        lines.push("/*   " + e.sel + " */");
      });
      lines.push("");
    }

    if (attrs.length) {
      lines.push("/* REPLACED ATTRIBUTES — update these in the HTML source: */");
      attrs.forEach(function (e) {
        lines.push("/*");
        lines.push("   at:   " + e.sel);
        lines.push("   set:  " + e.prop + " = " + JSON.stringify(e.after));
        if (e.before != null) lines.push("   was:  " + JSON.stringify(e.before));
        lines.push("*/");
      });
      lines.push("");
    }

    return lines.join("\n");
  }

  /* Export a copy of the whole site with the editor removed — the "give this
     to someone else" route. Needs a source folder (to read from) and a
     destination folder (to write into). */
  function exportCleanCopy() {
    if (!supportsFs()) {
      return toast("This browser cannot copy folders — use Export CSS patch");
    }
    if (isDirty() && !confirm("Unsaved changes will not be included in the copy. Continue?")) {
      return;
    }

    toast("Pick the project folder to copy (the source)");
    var source;

    getDirHandle()
      .then(function (dir) {
        source = dir;
        toast("Pick an empty folder as the destination");
        return window.showDirectoryPicker({ mode: "readwrite" });
      })
      .then(function (dest) {
        return copyTree(source, dest);
      })
      .then(function (count) {
        toast("Clean copy written — " + count + " files, editor removed");
      })
      .catch(function (err) {
        toast(err && err.name === "AbortError" ? "Export cancelled"
          : "Copy failed — " + (err && err.message ? err.message : "unknown"));
      });
  }

  function copyTree(src, dest, path) {
    path = path || "";
    var jobs = [];
    var count = 0;

    return (async function () {
      for await (var entry of src.values()) {
        // The editor itself never ships.
        if (entry.name === "tools" && !path) continue;
        if (entry.name === ".workbuddy" || entry.name === ".git") continue;
        if (entry.name === ".DS_Store") continue;

        if (entry.kind === "directory") {
          var subDest = await dest.getDirectoryHandle(entry.name, { create: true });
          count += await copyTree(entry, subDest, path + entry.name + "/");
          continue;
        }

        var file = await entry.getFile();
        var outHandle = await dest.getFileHandle(entry.name, { create: true });
        var writable = await outHandle.createWritable();

        // index.html gets the loader block surgically removed.
        if (!path && entry.name === "index.html") {
          var html = await file.text();
          await writable.write(stripLoader(html));
        } else {
          await writable.write(await file.arrayBuffer());
        }
        await writable.close();
        count++;
      }
      return count;
    })();
  }

  /* Remove the loader between its sentinels. The sentinels exist precisely so
     this can be done reliably by us, by a human, or by another agent. */
  function stripLoader(html) {
    var startTag = "<!-- " + LOADER_SENTINEL;
    var start = html.indexOf(startTag);
    if (start === -1) return html;

    var endTag = LOADER_SENTINEL_END;
    var end = html.indexOf(endTag, start);
    if (end === -1) return html;

    return html.slice(0, start).replace(/[ \t]*$/, "") +
      html.slice(end + endTag.length).replace(/^\n?/, "");
  }

  function download(name, text) {
    var blob = new Blob([text], { type: "text/css" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function toast(msg) {
    var t = document.createElement("div");
    t.className = "ve-toast";
    t.textContent = msg;
    document.body.appendChild(t);
    requestAnimationFrame(function () { t.classList.add("is-on"); });
    setTimeout(function () {
      t.classList.remove("is-on");
      setTimeout(function () { t.remove(); }, 250);
    }, 1600);
  }

  // ---------------------------------------------------------------- events

  function bind() {
    var hovered = null;

    document.addEventListener("mousemove", function (e) {
      if (state.dragging || state.mode === "browse") return;
      if (state.editingText) return;
      if (e.target.closest(".ve-panel, .ve-bar, .ve-modal, .ve-history, .ve-handles")) return;

      // Highlight what a click would actually select, gaps and overlay included.
      var el = pageElementAt(e.clientX, e.clientY);
      if (el) el = outermostGroupFor(el);

      if (hovered && hovered !== el) { hovered.removeAttribute("data-ve-hover"); hovered = null; }
      if (el && editable(el) && el !== state.selected) {
        el.setAttribute("data-ve-hover", "");
        hovered = el;
      }
    }, true);

    document.addEventListener("click", function (e) {
      if (e.target.closest(".ve-panel, .ve-bar, .ve-modal, .ve-history")) return;
      /* The move surface (.ve-handles) covers the selected element. Plain
         clicks on it belong to the drag handlers, but Alt-click must pass
         through — cycling the stack is exactly how you leave the covered
         element. */
      if (!e.altKey && e.target.closest(".ve-handles")) return;

      // Browsing: every click belongs to the page. (Collapsed is only the
      // toolbar; the editor itself keeps working.)
      if (state.mode === "browse") return;
      // A live text edit owns its own clicks.
      if (state.editingText) return;

      /* Alt-click cycles the element stack at the cursor — the only way to
         reach background layers sitting under full-bleed art, since parent
         walking can never reach a sibling layer. */
      if (e.altKey) {
        e.preventDefault(); e.stopPropagation();
        var stack = document.elementsFromPoint(e.clientX, e.clientY).filter(function (n) {
          return editable(n) &&
            !n.closest(".ve-panel, .ve-bar, .ve-modal, .ve-handles, .ve-history, .ve-toast");
        });
        if (!stack.length) return;
        var idx = stack.indexOf(state.selected);
        var next = stack[(idx + 1) % stack.length];
        if (next && next !== state.selected) {
          select(next);
          toast("Stack pick " + labelFor(next) +
            " (" + (stack.indexOf(next) + 1) + "/" + stack.length +
            " — Alt+click again for the next layer)");
        }
        return;
      }

      /* Resolve through the overlay and through text line-gaps, so clicking a
         heading selects the heading rather than the container behind it. */
      var resolved = pageElementAt(e.clientX, e.clientY) || e.target;
      if (!editable(resolved)) return;

      e.preventDefault();
      e.stopPropagation();
      if (hovered) { hovered.removeAttribute("data-ve-hover"); hovered = null; }

      /* Leaf-first selection with inline roll-up: a click lands on the exact
         element under the cursor (the page has been flattened), except that
         inline decorations like <em>/<strong>/<span> roll up to their
         text-leaf block parent — clicking italic words inside a heading
         selects the heading, not the <em>.

         Roll-up is gated on *computed display*, not the tag name: a <span>
         that CSS has turned into a block / flex / grid / inline-block box is a
         box in its own right (badges, chips, pills) and must stay selectable.
         Only genuinely inline-flowing decoration rolls up. */
      var target = resolved;
      var INLINE = /^(em|strong|span|a|b|i|u|small|mark|abbr|code|sub|sup)$/i;
      var FLOWS_INLINE = /^(inline|ruby|ruby-text|ruby-base)$/;
      while (target && INLINE.test(target.tagName) &&
             FLOWS_INLINE.test(getComputedStyle(target).display)) {
        var par = target.parentElement;
        if (!par || !editable(par)) break;
        if (isTextLeaf(par)) { target = par; break; }
        target = par;
      }
      select(target);
    }, true);

    /* Each double-click descends one level towards the element actually under
       the cursor. On a leaf text element there is nowhere left to go, so it
       becomes a text edit instead. */
    document.addEventListener("dblclick", function (e) {
      /* NOTE: deliberately no .ve-handles here — once an element is selected
         its move surface covers it, and the double-click lands on that
         overlay. pageElementAt below looks through the chrome to find the real
         target, which is how double-click-to-edit works on a selected node. */
      if (e.target.closest(".ve-panel, .ve-bar, .ve-modal, .ve-history")) return;
      if (state.mode === "browse") return;
      if (state.editingText) return;

      /* Once something is selected the move surface covers it, so e.target is
         the overlay rather than the page. Look through the chrome to find what
         is really under the cursor. */
      var deepest = pageElementAt(e.clientX, e.clientY) || e.target;
      if (!editable(deepest)) return;

      e.preventDefault();
      e.stopPropagation();

      var next = drillTowards(state.selected, deepest);
      if (next && next !== state.selected) {
        select(next);
        // Landing directly on the leaf means the intent was to edit its words.
        if (next === deepest && isTextLeaf(next)) startTextEdit(next);
        else toast("Entered " + labelFor(next));
        return;
      }

      if (deepest !== state.selected) {
        select(deepest);
        if (isTextLeaf(deepest)) startTextEdit(deepest);
        return;
      }

      // Already on the node under the cursor: edit text, or drill one level in.
      if (isTextLeaf(state.selected)) { startTextEdit(state.selected); return; }
      var drillChild = firstEditableChild(state.selected);
      if (drillChild) {
        select(drillChild);
        if (isTextLeaf(drillChild)) startTextEdit(drillChild);
        else toast("Entered " + labelFor(drillChild));
      } else {
        toast("Innermost element reached");
      }
    }, true);

    document.addEventListener("keydown", function (e) {
      var mod = e.metaKey || e.ctrlKey;

      // History + save + mode shortcuts work regardless of selection.
      if (mod && e.key.toLowerCase() === "e") { e.preventDefault(); toggleMode(); return; }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if (mod && e.key.toLowerCase() === "y") { e.preventDefault(); redo(); return; }
      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (e.shiftKey) openExport(); else saveToDisk();
        return;
      }
      // Collapsed chrome still answers the shortcut that brings it back.
      if (mod && e.key === ".") { e.preventDefault(); setMinimised(!state.minimised); return; }

      if (state.mode === "browse") return;
      // A live text edit handles its own keys (Enter commits, Esc cancels).
      if (state.editingText) return;
      if (e.key === "Escape") { deselect(); return; }
      if (!state.selected) return;
      if (/^(input|select|textarea)$/i.test(e.target.tagName)) return;

      // Delete / Backspace removes the selection — same as the corner button.
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        removeElement(state.selected);
        return;
      }

      // Tab cycles siblings — the keyboard twin of the Next sibling button.
      if (e.key === "Tab") {
        var sibs = siblingsOf(state.selected);
        if (sibs.length > 1) {
          e.preventDefault();
          var i = sibs.indexOf(state.selected);
          var step = e.shiftKey ? -1 : 1;
          select(sibs[(i + step + sibs.length) % sibs.length]);
        }
        return;
      }

      // Nudge with arrows: 1 unit step, 10 with Shift.
      var map = { ArrowUp: ["top", -1], ArrowDown: ["top", 1], ArrowLeft: ["left", -1], ArrowRight: ["left", 1] };
      var hit = map[e.key];
      if (!hit) return;
      var cs = getComputedStyle(state.selected);
      if (cs.position === "static") {
        // Lift to relative so the nudge has somewhere to go; recorded so undo works.
        var nudgeSel = selectorFor(state.selected);
        record(nudgeSel, "position", "relative", "nudge:" + Date.now(), "Nudge");
        setPropQuiet(state.selected, "position", "relative");
      }

      e.preventDefault();
      var prop = hit[0];
      var dir = hit[1] * (e.shiftKey ? 10 : 1);
      var info = authoredValue(state.selected, prop);
      var unit = info.unit || "px";
      var step = unit === "px" ? 1 : 0.1;
      var next = round((isNaN(info.num) ? 0 : info.num) + dir * step);
      // One merge key for the whole key-repeat burst.
      setProp(state.selected, prop, next + unit, "nudge|" + prop);
      positionHandles();
      buildPanel(state.selected);
    });

    document.addEventListener("keyup", function (e) {
      if (/^Arrow/.test(e.key)) sealStep();
    });

    window.addEventListener("scroll", function () { if (state.selected) positionHandles(); }, true);
    /* Resize fires in bursts while a window is dragged. Handles and the panel
       need to track it live, but pulling the chrome back on screen is only
       worth doing once the user stops — and doing it mid-drag would fight
       them. */
    var resizeSettle = null;
    window.addEventListener("resize", function () {
      if (state.selected) { positionHandles(); buildPanel(state.selected); }
      updateBar();
      if (state.historyPanel) positionHistory();

      clearTimeout(resizeSettle);
      resizeSettle = setTimeout(function () {
        /* A window narrower than the expanded bar cannot show it at all, so
           shut it into its drawer rather than leaving controls off-screen. */
        if (!state.minimised && state.bar && state.bar.scrollWidth > window.innerWidth - 16) {
          setMinimised(true);
          toast("Window too narrow — editor collapsed");
        }
        keepOnScreen(state.bar, BAR_POS_KEY, "right");
        keepOnScreen(state.panel, PANEL_POS_KEY, "free");
        if (state.historyPanel) positionHistory();
      }, 160);
    });

    // Photoshop-style guard: unsaved work should not vanish on a stray reload.
    window.addEventListener("beforeunload", function (e) {
      if (!isDirty()) return;
      e.preventDefault();
      e.returnValue = "";
      return "";
    });

    /* The project sheet is rebuilt from JSON on every open, which wipes any
       runtime SVG inlining and any element we inserted. Re-render the style tag
       and re-materialise insertions, and drop a stale selection.

       syncInsertions() itself mutates the DOM, so the observer is paused around
       it to avoid re-entering this callback. */
    var syncing = false;
    var observer = new MutationObserver(function () {
      if (syncing) return;
      if (state.selected && !document.contains(state.selected)) deselect();
      renderStyle();

      syncing = true;
      try { syncInsertions(); } finally {
        // Let the current microtask batch settle before listening again.
        setTimeout(function () { syncing = false; }, 0);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  // ------------------------------------------------------------------ boot

  function boot() {
    document.documentElement.setAttribute("data-ve-active", "");
    buildChrome();
    renderStyle();
    bind();
    console.info("[visual-editor] active — scope:", scope(), "· edits:", countEdits());
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
