---
name: visual-editor
description: >
  Install a Figma-like in-browser visual editor into any static HTML site so the
  user can select, drag-resize, restyle and re-word elements live, then save the
  result as ordinary CSS. Use when the user wants to visually tweak a website's
  layout/typography/colors/images/SVG without a code round-trip, or asks to "add
  the visual editor / Figma-like editor" to a project. Values are written back in
  the unit they were authored in (cqw/%/em), so a responsive system stays intact.
---

# Visual Editor

A self-contained inspector that runs inside the page. It works on **any element
of any page** in the site and writes values back **in the unit they were authored
in**, which is what keeps a `cqw` / `%` responsive system intact.

It loads **only** when the URL carries `?edit=1`; otherwise nothing is fetched and
the shipped page is byte-for-byte unaffected. There is no separate "baked" build —
the normal URL *is* the production page.

## ⚠️ DELIVERY RULE — read first, this is the step every agent gets wrong

When the install finishes, your **FIRST reply to the user MUST contain the
ready-to-click edit link** — start (or reuse) a local static server and hand over
the URL **with `?edit=1` already appended**, e.g. `http://localhost:8000/?edit=1`.

- Do NOT ask "装好了，要打开吗？" or any other confirmation question. Just do it
  and present the link.
- Do NOT give the plain URL and explain "加上 ?edit=1 就行" — the user will open
  the plain one, see no editor, and conclude the install failed. (This exact
  failure has happened multiple times; it is why this rule exists.)
- Do NOT walk the user through the steps you took. Three sentences max:
  what was installed, the `?edit=1` link, how to save (⌘S).
- Pick a free port and verify it serves the RIGHT project (`curl` the page and
  check the `<title>`) before presenting the link — a stale server on a reused
  port will happily serve a different project.

## What's in this package

| Path | Role |
| --- | --- |
| `assets/visual-editor.js` | All editor logic (selection, units, history, save, upload, text-edit, drag). |
| `assets/visual-editor.css` | Panel / toolbar styling, scoped under `[data-ve-active]`. |
| `assets/USAGE.md` | The end-user manual. Copy it to `tools/README.md` on install. |

## Install into a project (3 steps, no more)

1. **Copy files.** Create `tools/` at the project root:
   ```
   tools/visual-editor.js   ← from assets/
   tools/visual-editor.css  ← from assets/
   tools/README.md          ← from assets/USAGE.md
   ```
2. **One HTML edit.** Add the loader block just before `</body>` in the HTML
   entry file (`index.html`). Keep the sentinels — they make it findable and
   removable:

   ```html
   <!-- VE-LOADER:BEGIN — Visual editor loader (development only).
        REMOVAL: delete everything between VE-LOADER:BEGIN and VE-LOADER:END,
        then delete the tools/ directory. See tools/README.md. -->
   <script>
     (function () {
       var qs = new URLSearchParams(location.search);
       var on = qs.get("edit") === "1" || location.hash === "#edit";
       if (qs.get("edit") === "0") {
         try { localStorage.removeItem("ve:enabled"); } catch (e) {}
         on = false;
       } else if (!on) {
         try { on = localStorage.getItem("ve:enabled") === "1"; } catch (e) {}
       }
       if (!on) return;
       var css = document.createElement("link");
       css.rel = "stylesheet";
       css.href = "tools/visual-editor.css?v=10";
       document.head.appendChild(css);
       var js = document.createElement("script");
       js.src = "tools/visual-editor.js?v=10";
       js.defer = true;
       document.body.appendChild(js);
     })();
   </script>
   <!-- VE-LOADER:END -->
   ```

3. **Save target.** Create an empty `css/grid-overrides.css` if none exists and
   link it **after** the main stylesheet — Save (⌘S) writes into it. One line:
   `<link rel="stylesheet" href="css/grid-overrides.css">`

Then follow the DELIVERY RULE above. Nothing else: no build step, no dependency
install, no config file, no second HTML edit.

## Turn on / off

- **Enable:** open the site with `?edit=1` (e.g. `http://localhost:8000/?edit=1`).
  It self-enables for the rest of the session after the first visit.
- **Off:** load the page without `?edit=1` (or with `?edit=0`). Nothing loads.

## Save model — read before deploying

- **Save** (`⌘S`) writes into `grid-overrides.css` on the **local disk** via the
  File System Access API (Chrome/Edge). The first save asks the user to pick the
  project folder. Safari can't write files — it falls back to **Export CSS patch**.
- Because Save writes to local disk, **never edit on a live/deployed site** —
  changes won't reach the server. Edit locally, save, then deploy the files.
- Saved output is plain CSS and **survives uninstalling the editor**. Save before
  removing anything; unsaved values live only in the browser.

## Uninstall (safe for any agent)

1. Delete the `tools/` directory.
2. In the HTML entry file, delete everything from `VE-LOADER:BEGIN` through
   `VE-LOADER:END` inclusive.
3. Do **not** touch `grid-overrides.css` — the design changes live there as
   ordinary CSS.

## Key behaviours to know (full detail in USAGE.md)

- **Click** selects a whole component; **double-click** drills in one level and,
  on a text node, starts an inline text edit (`Enter` apply, `Esc` cancel).
- **Alt+click cycles the element stack** at the cursor — the way to reach
  background layers sitting under full-bleed art.
- **Drag the element** to move it; **drag the 8 handles** to resize (images keep
  ratio, `Alt` breaks it).
- **填充色 (Fill)** group edits solid colours and, for single-layer
  `linear-gradient()`/`radial-gradient()` backgrounds, offers a structured
  gradient editor (angle + per-stop colour/alpha/position).
- **替换图片 (Replace image, green)** swaps an `<img>` src or a CSS
  `background-image` url layer; the file lands in `assets/uploads/`.
- **打散编组 (Ungroup, gold)** dissolves a wrapper via `display: contents`;
  pure CSS, undoable, click again to re-group.
- **Scope warning:** editing an element with look-alikes offers
  `All N | Only this`. "Only this" isolates via `:nth-of-type` **without
  rewriting the HTML**. CSS styles a *class*, not the one node clicked.
- **History** is an operation log (not a snapshot stack): each row has an eye
  (mute/preview) and a trash (delete), and muting a middle entry recomputes the
  rest.
- **Units are preserved:** every numeric field opens on the authored unit and
  converts on switch — never leave a `cqw` value as `px` or the mobile layout
  breaks.
- **Desktop vs mobile:** below 760px, edits are stored separately and written
  inside `@media (max-width: 760px)`; desktop values are never overwritten.
- **Structural changes** (add image/SVG, delete) can't be expressed as pure CSS,
  so the exported patch appends a **STRUCTURAL CHANGES** checklist for merging
  into the HTML; uploaded files land in `assets/uploads/`.

## Known limits

- Selectors are generated from classes/ids; elements whose classes toggle at
  runtime can drift (the active selector is shown at the top of the panel).
- Runtime-inlined SVGs are not remembered across reloads.
- Safari can't write files or copy folders — use **Export CSS patch**.
