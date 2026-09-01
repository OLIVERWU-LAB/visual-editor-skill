# Visual Editor

A Figma-like inspector that runs inside the page, so layout tweaks happen in the
browser instead of in a code round-trip. It works on **any element of any page**
in the site, and values are written back **in the unit they were authored in**,
which is what keeps a `cqw`/`%` responsive system intact.

---

## INSTALL FOOTPRINT — read this before removing anything

Everything this tool adds to the project, exhaustively:

| Path | What it is |
| --- | --- |
| `tools/visual-editor.js` | Editor logic. Added by this tool. |
| `tools/visual-editor.css` | Panel styling. Added by this tool. |
| `tools/README.md` | This file. Added by this tool. |
| `index.html` | **One** block near `</body>`, fenced by sentinels (below). |

No other file is touched. `script.js`, `styles.css`, `grid-overrides.css`,
`assets/` and `data/` contain no editor code.

### Uninstall — safe for any agent or human to perform

```
1. Delete the directory:  tools/
2. In index.html, delete everything from the line containing
      VE-LOADER:BEGIN
   through the line containing
      VE-LOADER:END
   inclusive. That is one HTML comment, one <script> block, and a closing
   comment — roughly 30 lines.
3. Nothing else. Do NOT touch grid-overrides.css.
```

The loader is fenced exactly like this, so it can be found by plain search:

```html
<!-- VE-LOADER:BEGIN — Visual editor loader (development only). ... -->
<script> ... </script>
<!-- VE-LOADER:END -->
```

**Design changes survive removal.** Anything saved lives in `grid-overrides.css`
as ordinary CSS, completely independent of this tool. Save before uninstalling:
unsaved values exist only in the browser.

### Saved output is self-identifying

Blocks written into `grid-overrides.css` are fenced with:

```css
/* === VE:BEGIN — visual editor output ... === */
/* === VE:END === */
```

Exported patch files open with a machine-readable banner:

```
VISUAL-EDITOR-PATCH
generator: visual-editor (tools/visual-editor.js)
format:    ve-patch/1
target:    grid-overrides.css
```

Hand that file to any agent and it can identify the source, the target
stylesheet, and the merge rules without further explanation.

---

## Turning it on / off

| Action | How |
| --- | --- |
| Enable | add `?edit=1` to the URL — e.g. `http://localhost:8133/?edit=1` |
| Stays on | after the first visit it self-enables for the session |
| Collapse | click the **logo**, or `⌘.` — shuts the bar like a drawer, keeps all state |
| Fully off | load the page **without** `?edit=1` (or with `?edit=0`) |

When it is off, **nothing loads** — no CSS, no JS, no DOM, no listeners. The
shipped page is byte-for-byte unaffected, so there is no separate "baked" build
to produce: the normal URL *is* the production page.

## The toolbar (top-right)

```
▸  │  History  ↶  ↷  ▣  │  ● Saved  │  Save as ▾  │  ◉
```

| Control | Shortcut | What it does |
| --- | --- | --- |
| Pen / cursor | `⌘E` | Pen = editing, cursor = browsing. Click to swap. |
| History | — | Opens the change list |
| Undo / Redo | `⌘Z` / `⌘⇧Z` | 100 steps |
| Image icon | — | Adds an image or SVG to the page |
| Save | `⌘S` | Writes into `grid-overrides.css`. Green dot + **Saved** when nothing is pending; a number badge counts unsaved changes. |
| Save as ▾ | `⌘⇧S` | Export a CSS patch, or a clean project copy |
| Logo | `⌘.` | **Click** collapses the toolbar down to just the mark. **Press and drag** moves the whole bar. |

Both the toolbar and the inspector can be moved anywhere: grab the toolbar by its
**logo**, or the inspector by its header. Each remembers where you left it.
Dragging one off-screen is not a trap — a strip always stays grabbable.

The logo is deliberately dual-purpose: a click toggles the drawer, while a press
that travels more than a few pixels becomes a drag. There is no separate grip.

### There is no "exit"

Once loaded the editor stays available for the whole session. The logo
*collapses* it: the bar shuts like a drawer, keeping the same shell in the same
spot but holding only the mark. The page becomes fully interactive, and the bar
can still be dragged while closed.

Edits, history and unsaved state are all preserved — the logo carries a count
badge and the shell outlines red while there is unsaved work. Click the logo (or
`⌘.`) to open it again.

A real "quit" would mean a page reload, which would strand unsaved values. To
genuinely leave edit mode, load the page **without** `?edit=1`.

### Browse mode

Clicking the ring turns the editor's click capture **off**, so the page's own
controls — back arrow, tabs, video players — behave normally, while the panel
stays on screen. The ring shows a slash while browsing. Click again to resume
editing. This is the fix for the editor and the page fighting over the same
click. (Minimising achieves the same thing plus hides the chrome.)

### Save as ▾

| Option | Result |
| --- | --- |
| **Export CSS patch…** | A `.css` file of just the changes, with the identification banner. `grid-overrides.css` untouched. |
| **Export clean project copy…** | Copies the whole site into a folder you pick, with `tools/` and the loader removed. The deliverable build, in one step. |

**Save** and the clean copy need the File System Access API (Chrome/Edge). The
first use asks you to pick the project folder; the choice is remembered. Safari
falls back to the patch export.

Everything Save writes goes between the `VE:BEGIN` / `VE:END` markers, and
saving again replaces that block rather than appending — the file will not grow
a new copy each time. The declarations carry `!important` to out-weigh existing
high-specificity rules; ask the agent to fold them into the real declarations
when the design is final.

## Editing

The editor is **site-wide**: every element on every page or view is selectable —
homepage, cards, navigation, project detail sheets. Nothing is scoped to a
particular section.

- **Click** any element to select it. A click resolves to the whole component —
  the button, the card — not the inner `<span>` under the cursor.
- **Double-click** to drill in one level, repeatedly. Landing on a text element
  starts a **text edit**: type to change the wording, <kbd>Enter</kbd> to apply,
  <kbd>Esc</kbd> to cancel. The outline turns green while editing.
- The inspector appears only while something is selected; with nothing selected
  you get just the toolbar and an unobstructed page.
- **Drag the element itself** to move it (when it is positioned). <kbd>Shift</kbd>
  locks to one axis.
- **Drag the 8 handles** to resize. Images keep their ratio; <kbd>Alt</kbd>
  breaks it.
- **Alt-click** walks up to the parent.
- `↑ Parent` steps out; `↓ Into group` steps in and then becomes
  **`Next sibling ›`** with a `2 / 6` counter, so every child of a group is
  reachable. <kbd>Tab</kbd> / <kbd>Shift-Tab</kbd> do the same from the keyboard.
- **Arrow keys** nudge position (`Shift` = ×10).
- <kbd>Esc</kbd> or the panel's × deselects and puts the inspector away.

Text hit-testing is handled specially: a multi-line heading only responds where
its glyphs are, so a click between the lines would otherwise select the
container. The editor resolves per line box, which is why headings and
paragraphs are selectable anywhere along them.

### Per-element footer

| Button | Scope |
| --- | --- |
| **← Step back** | Undoes the most recent change **to this element only** |
| **Reset element** | Drops every change to this element |

`Reset all` lives in the History panel, not here.

### Panel groups fold themselves

- **Has a value** → open, with **×** to strip the group.
- **Not set** → folded, with **+** that seeds sensible defaults and opens it.

So a heading with no shadow shows `▸ TEXT SHADOW  +` rather than meaningless
zeroes. Shadows get structured Offset X / Y / Blur / Colour rows instead of a raw
CSS string. Both `+` and `×` are undoable.

### What you get per element type

| Type | Groups |
| --- | --- |
| Text | Typography, Outline (incl. the `::before` stroke layer this design uses), Text shadow |
| Image / video | Size, Corner radius |
| SVG | SVG paint (fill, stroke, stroke width) |
| Everything | Position, Transform, Spacing, Opacity, Drop shadow, Box shadow, Blend mode |

## History panel

Every change is a row, newest first:

| Control | Effect |
| --- | --- |
| Row body | Selects that element |
| **◉ / ◌** eye | Mutes the change without deleting it — preview "what if I hadn't" |
| **🗑** trash | Deletes that change permanently |
| **Reset all** | Clears everything, both breakpoints |

History is an operation log, not a stack of snapshots, so muting or deleting a
middle entry recomputes the result from the rest. You can drop one change from an
hour ago and keep everything made after it.

## Adding and removing elements

### Delete

Selecting an element puts a red trash button on its **top-left** corner. It is
undoable (`⌘Z`), and it appears in the History list where the eye can toggle it
— so you can preview the page without an element before committing.

Deletion is implemented as `display: none` rather than ripping the node out of
the document. That keeps it reversible and lets it survive the project sheet
re-rendering. Clicking delete on one of several look-alikes switches that
element to "Only this" first, so you do not wipe all seven cards by accident.

### Add an image or SVG

**+ Image** in the toolbar opens a file picker (PNG, JPG, WebP, GIF, SVG). The
new element:

- lands **inside the current selection** if there is one, otherwise in the
  visible page panel — so select a section first to control where it goes
- is **selected automatically**, ready to drag, resize and restyle
- starts at a modest 180px so it is grabbable rather than dominating the layout

With folder access granted, files are written to **`assets/uploads/`** and
referenced by relative path. Without it, the image is embedded as a data URI and
the editor says so — workable, but the patch gets large, so granting folder
access is worth it.

**SVGs are inlined**, not linked, so their fill and stroke are editable
immediately.

### These are structural changes

CSS cannot add or truly delete markup. Both operations are stored in the history
and re-applied live, but the exported patch appends a **STRUCTURAL CHANGES**
checklist listing each added snippet with its target parent, and each hidden
element's selector, for merging into `index.html`. Uploaded files in
`assets/uploads/` must be kept with the project.

## One element, or all of its kind?

**This is the single most important thing to understand.** CSS styles a *class*
of elements, not the one you clicked. The seven project cards share one
description, so a change to one is normally a change to all seven — the same
relationship as a Figma component and its instances.

The editor makes this explicit. Select something that has look-alikes and the
panel shows:

```
⚠ 7 matching elements — edits apply to all of them.     [ All 7 | Only this ]
```

| Choice | Behaviour | When to use |
| --- | --- | --- |
| **All N** (default) | One rule covers every element of this kind. Clean, minimal CSS. | Consistent styling — round every card a little more |
| **Only this** | The selector is narrowed with `:nth-of-type` to hit one instance. | One-off tweaks — nudge just the third card |

**Hover the warning** to outline every element that would change, so the blast
radius is visible rather than described.

Switching between the two carries any edits you already made across, so the
appearance does not change — only its reach. "Only this" needs **no markup
changes**: the isolation lives entirely in the selector, so your HTML is never
rewritten.

An element with an `id` (shown as `#heroTitle`) is unique by definition and gets
no warning.

Watch out for **position and size** changes in "All N" mode. A colour applied to
all seven cards just looks consistent; a position applied to all seven can push
some off screen where you will not notice.

Every numeric field has a unit picker. The field opens on the **authored** unit
(the title's font size reads `5.0625 cqw`, not `61.96 px`), and switching units
converts the value so nothing jumps. Never leave a `cqw` value as `px` unless you
intend to break the mobile layout.

## SVG fill / stroke

`<img src="*.svg">` renders in a separate document, so CSS cannot reach its
paths. Select it and press **Enable fill / stroke editing** — the editor swaps in
inline `<svg>` at runtime, preserving classes. Shapes with hardcoded `fill="#…"`
attributes are targeted directly, since a presentation attribute out-ranks a rule
on the parent. The conversion is runtime-only; the exported patch lists which
files need it baked in.

## Desktop vs mobile

The toolbar shows the active scope. Below 760px edits are stored separately and
written inside `@media (max-width: 760px)`. Desktop values are never overwritten
by mobile tweaks. The breakpoint matches the site's existing `760px`.

## Known limits

- Selectors are generated from classes/ids; an element whose classes toggle at
  runtime can drift. The selector in use is shown at the top of the panel.
- Removing a group that the site's own stylesheet declares writes a neutralising
  value (`none`, `0`) rather than deleting the rule, because the authored
  declaration would otherwise win.
- Runtime-inlined SVGs are not remembered across reloads.
- Safari cannot write files or copy folders; use **Export CSS patch**.

---

## v4 additions (this project)

- **Background gradients** — when the selected element's `background-image` is a
  single `linear-gradient()` / `radial-gradient()`, the Background group shows a
  structured editor: angle (linear) plus one row per colour stop
  (colour · alpha · position %). Multi-layer or conic backgrounds degrade to a
  raw text field. Changes are recorded as `background-image` overrides and flow
  through history / save like any other property.
- **Replace image…** — panel-foot button, visible when an `<img>` is selected.
  The chosen file is written to `assets/uploads/` (or embedded as a data URI
  without folder access) and the `src` swap is logged as an `attr` entry:
  undoable, mutable in history, and listed under STRUCTURAL CHANGES in the
  exported patch so it can be baked into the HTML.
- **Ungroup** — panel-foot button, visible on containers with editable
  children. Applies `display: contents`, dissolving the wrapper visually so its
  children lay out as direct children of the grandparent. Pure CSS, fully
  undoable, exports as a normal declaration. Click **Re-group** to restore.

## v5/v6 additions (this project)

- **填充色 Fill** — the old Background group, renamed and always visible.
  Gradient editing lives here; when the clicked element has no fill of its own
  but an ancestor does (e.g. the icon inside a tinted button), the group shows
  a jump button to the element that owns the fill.
- **Replace image… (green)** also works on elements whose *CSS background* is a
  `url()` image (`.p1-bg`, `.p2-bg`, …): only the url layer is swapped, gradient
  overlays and `center/cover` sizing are preserved, and the change is pure CSS
  so it exports normally.
- **Ungroup (gold) / Replace image (green)** sit on their own full-width row at
  the panel foot; they never appear together.
- **Icon-only buttons no longer show Typography** — an element counts as text
  only when it has real text nodes, `data-text`, or pseudo-element content.
- **Alt+click cycles the element stack** at the cursor (topmost → deepest →
  wraps), which is how you reach background layers under full-bleed art. The
  toast shows `n / total` so you know where you are.
- **Dragging no longer stretches inset-pinned elements** — elements positioned
  with both `left` and `right` (or `top`/`bottom`, e.g. `inset: 0` background
  layers) are pinned to their current size and released from the far edge
  before the move, all inside the same undoable history entry.
- Fix: the gradient editor now reads the computed style when the raw sheet
  scan reports a less-specific reset (`background-image: initial` on a base
  class), so gradients authored via the `background:` shorthand are editable.
