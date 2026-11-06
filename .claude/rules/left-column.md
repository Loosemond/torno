---
paths:
  - "app/src/shared/groups.ts"
  - "app/src/shared/groups.test.ts"
  - "app/src/shared/palette.ts"
  - "app/src/shared/palette.test.ts"
  - "app/src/renderer/ui/Layers.tsx"
  - "app/src/renderer/ui/Layers.test.ts"
  - "app/src/renderer/ui/layerMarks.ts"
  - "app/src/renderer/ui/layerMarks.test.ts"
  - "app/src/renderer/ui/SectionTitle.tsx"
  - "app/src/renderer/ui/sectionSaid.ts"
  - "app/src/renderer/ui/sectionSaid.test.ts"
  - "app/src/renderer/ui/ColumnSplit.tsx"
  - "app/src/renderer/ui/LeftEdge.tsx"
  - "app/src/renderer/ui/ObjectList.tsx"
  - "app/src/renderer/state/column.ts"
  - "app/src/renderer/state/column.test.ts"
  - "app/src/renderer/styles/panels.css"
  - "app/src/main/mcp/viewTools.ts"
  - "app/e2e/groups.spec.ts"
  - "app/e2e/references.spec.ts"
---

# The left column: layers, groups of parts, references, folding and the splitters

Moved as written from the folder `CLAUDE.md` files; each heading names the folder it came from, and paths are written as they were there (see "Rules by area" in the root `CLAUDE.md`).

## What crosses processes (root `CLAUDE.md`)

- A group of parts is the model's (`groups(p)`, read by the worker that loads the model, `Scene.groups`): one
  level, a part in one group at most, across layouts by part name. A group name is not a ref (no `/`, not `M<n>`,
  not a part's name: the loader refuses those). Wherever a tool takes part names a group's name stands for its parts
  in the layout (`shared/groups.ts` `partsNamed`, in main before a request and in the window alike). torno never
  writes the model: the only thing it keeps of groups is which are folded (`folded` in `scene.json`).

## Marks (`app/src/main`)

- **Groups of parts.** `show`, `look` and `save_view` take group names in `parts`, and `highlight` in `refs` (a
  bare name only: `flat/F1` is refused, saying that `flat` is a group and naming its parts), expanded in main by
  `partsNamed` before the request goes to the window; the window expands what reaches it by the same rule. A
  saved view is kept with part names. `scene` lists `groups` for the layout shown (`{name, parts, visible}`) and
  each part's `group`; `describe` of a group's name is the box of its parts and their volume, from the scene,
  exact only where every part's is, naming by part a member with a solid inside out (`reversed`). `state.md` names each layout's groups before its parts.

## Groups (`app/src/shared`)

- `shared/groups.ts` is the one rule of a model's groups of parts (`Scene.groups`, `PartGroup`), for main and the
  window alike: `groupsIn(scene, layout)` (the groups with a part in the layout, each with only those parts),
  `groupOf`, `partsNamed(scene, layout, names)` (part or group names to the part names of the layout, in order, no
  repeats; an unknown name is the failure, worded `unknown part '…'; parts in layout …; groups: …`) and
  `groupVisibility` (`all`, `some`, `none`; a part with no settings is visible).
- Which groups are folded in the layers list is view state: `folded` (group names) in `scene.json`, read by
  `main/scenefile.ts` as one-line names, each once. A saved view keeps part names, never a group's.

## References (`app/src/shared`)

- `Part.role` is `'reference'` for a bought part the model puts among its `references(p)`; absent of a part to make. Whoever
  lists, exports or counts parts for making leaves such a part out (`main/export/model.ts`, the export sheet's
  `reference` on `layoutParts`). Its colour is `REFERENCE_COLOR` of `shared/palette.ts`, a neutral grey, and
  `colorsOfParts` gives every part its colour with the references outside the palette's order (so adding one changes no
  part's colour): the viewport, the layers list, thumbnails and the exported page all use it, never `colorsByName` of all
  the names.

## Layers (`app/src/renderer`)

- `ui/Layers.tsx`: a reference (`Part.role`, a bought part) has the neutral swatch (`colorsOfParts`) and the tag "bought"
  (`.layer-bought`), and is otherwise a row like any (it can be picked, hidden, made translucent).
- `ui/Layers.tsx`: the groups of the layout (`groupsIn`) come first, a header each (`li.layer-group`,
  `data-group`): a fold chevron (`aria-expanded`, `Fold flat` / `Unfold flat`), the name and the count in the
  monospace face, "Show only" (on hover, as the opacity slider; `actions.soloLayers`) and an eye whose
  `aria-pressed` is `true`, `false` or `mixed` (`groupVisibility`; `actions.setLayers` over the group, one edit).
  Its parts follow, indented, with `data-in-group`; a folded group draws none (`actions.setFolded`, kept in the
  scene file as `folded`, and dropped for a group the model no longer has). The parts in no group come last. A
  model without groups draws the list as it always was (`e2e/groups.spec.ts`).
- A part's row is also the way to the part (#94, `ui/Layers.tsx`): the pointer or the keys' focus on it is `peek([name])`
  (no highlight of the agent's, no locked tools; a row that goes while it is lit takes the light away), its name is a
  button that selects the part as a ref (`setSelection([name])`) and, double clicked, brings it into view
  (`actions.framePart`, `Viewport.framePart`: where it is drawn, the camera not turned), the target is "Show only"
  (`soloLayers(layout, [name])`) and the title says `N hidden · Show all` while a part of the layout is off. After the
  name, a muted count of the open marks on the part in the layout shown (`ui/layerMarks.ts` `marksByPart`; `--fail` when
  one is a check that fails on the build); a click lists only the marks on that part in the Marks panel
  (`store.marksOnPart`, the window's alone and dropped with the object; a chip `Only marks on lid` with a cross
  above the list; `goToRow` clears it). It filters what the list shows and nothing else: the agent is told every mark.
- A part whose build says its shape is broken (`partDefects` of `shared/sanity.ts`: not valid, inside out, not
  closed, mesh disagrees) has its first defect in a word after its name (`.layer-defect`, `--fail`, `+N` for the
  others) and every one in the row's title; the status line counts the layout's broken parts after its parts
  (`.status-defects`, `defectsSaid` in its title). Of the build on show alone: whether a defect is new is for the
  agent's digest (`main/sanity.ts`) to say.

## The page of objects (`app/src/renderer`)

- **The left column gives the room to the marks** (`styles/panels.css`, `state/column.ts`). Objects, Layers,
  Parameters and Scans each have a title that folds them (`ui/SectionTitle.tsx`, `aria-expanded`; folded with the pointer, the
  keys go back to the view); folded, a section is its title row, which says what matters (`ui/sectionSaid.ts`, and `ParamsPanel`'s own count:
  `Layers 12 · 3 hidden`, `Parameters 5`, `Scans 1 · unaligned`, `Projects 17`), and Scans keeps only what is said of an import
  and the question it asks. Parameters, under the layers, starts folded. Marks never folds: it keeps `--marks-floor` (`MARKS_FLOOR`: its title, a group's
  heading and five rows), and every section above gives way before it, each down to its title. The splitter
  above Marks (`ui/ColumnSplit.tsx`, `role="separator"`, `column.resize` Up/Down) gives Marks more: its drag writes
  `--marks-h` on the column, nothing through React per move; a double click puts back the shares. The room is read
  from the column as it is laid out (`tallest`: the column less everything else in it, each section that gives way at
  its least), at the drag and whenever the column or a section in it is resized, comes or goes (a `ResizeObserver` and
  a `MutationObserver`): `--marks-h` is the height kept cut to that room, so a shorter window or Parameters coming
  above never push Marks under the status line, `aria-valuenow` is that height, and what is kept is not touched. What is
  folded, the splitter's height and the column's width are the window's (`store.column`, in `localStorage` under `torno.column`, read
  and written in try/catch), never the workspace's. The column's right edge (`ui/LeftEdge.tsx`, `role="separator"`, `left.resize` Left/Right) makes it wider than its default 248 px (`LEFT_DEFAULT`), up to what leaves the viewport `VIEWPORT_MIN` beside the dock (`clampLeft`); its drag writes `--left-w` on the shell, a double click puts the default back, and the dock's own limit reads the column's width now.
- **Objects folds to a switcher by default** (`switcherShown`): folded, with an object open or a new one being
  made, in a workspace of more than one object, the list is one row, the open object's name in ink
  (`ObjectSwitcher`; "New project", pressed, on the page of a new object). Its accessible name is the object's
  name, as a row's is; what the sessions do is its `aria-description`. A click or Enter opens a menu
  (`role="menu"`, the keys of `FolderMenu`: `menu.next`, `menu.previous`, `menu.ends`, `menu.close`) of every
  object as the rows (the item's name is the object's; a muted one has its reason as a second line), then "New
  object". Chosen with the keys, the focus goes back to the switcher; with the pointer, the keys to the view.
  Unfolded, the list is as it always was and gives way first (a share of the column at most); with no object
  open, or the page up, it is whole and has the room of the layers, the parameters and the scans, every object in sight
  (`e2e/show.spec.ts`).
