# Stream U: the System view

Branch `ds/ui`. The design system as a place to work in, inside the Design workspace: sections of tokens, edits in place that show live on the open design, undo and redo, Save and Discard, a page check with pins and Send to Pi, the documentation page, the files for code, focus mode, and the phone's frame.

## How to look at it

```
node test/serve-design-system.ts 8913 127.0.0.13      # a throwaway copy with designs and a system ("Harbor")
node test/serve-design-system.ts 8913 127.0.0.13 --no-system
```

It prints sign-in links for an owner, a guest, and a viewer, and a kill command. Open the Design panel, then the first row of the picker ("Design system"), `/design-open system`, or the launcher action "Open the design system". The hooks that tests and the bench can use: `.dsy-main` (the view), `.dsy-tabs [role=tab]` (the sections), `[data-token="color.bg.surface"]` (a token's row or tile), `.dsy-savebar`, `.dsy-preview` (the open design beside the view).

## What is built

Server (`src/server/extensions/design/`, called from `design.ts`):

- `system-routes.ts`: the routes (all through `web.conversationRoute`; read = view access, write = steer access). Under `/api/x/design/c/:conversation/`:
    - `GET system` (`?revision=` answers `{ unchanged }`): `{ system, legacy }`. `system` is the loaded system without the generated files (only the components' CSS, and the sizes of the four files); `legacy` is the size of `.pi/design-system.md` when `.pi/design/` is absent.
    - `POST system` (steer): `{ set?, modes?, guidelines?, baseRevision? }`. `set` is `[{ mode, token, value }]` (500 at most; a name of up to 8 segments of `[A-Za-z0-9_-]`, never `__proto__`, `constructor`, or `prototype`; a value of text, a number, a boolean, a list of up to 32, or an object of up to 32 keys, 5 deep, 8 KB). `modes` adds (`{}`) or removes (`null`) a mode. `guidelines` is text up to 16,000 characters without control characters. A save that the engine refuses answers **200 with `{ ok: false, error, problems }`** (a module's route error carries only words, so the structured problems go in the body); a stale `baseRevision` answers 409 and writes nothing. Saves for one folder go one at a time. Success: `{ ok: true, system }`, and the event `system` goes to every tab.
    - `POST system/check` (steer): `{ id, version?, colorScheme?, viewport? }` → `{ report, id, version }`. The report is cut to a fixed shape (300 findings, text lengths, the 12 rules, numbers finite).
    - `POST system/docs` (steer): `{ key }` → `{ id: "design-system-docs", version }`. Writes a new version of that artifact (HTML, with the page's assets by hash) in one commit; the same key finds its version. Refused (409) while the system has an error.
    - `POST system/export` (steer): writes `exports/<name>-tokens.zip` (`tokens.css`, `tailwind.css`, `tokens.resolved.json`, `components.css`, from the engine's compile) and answers `{ path, relative, name, size }`; the browser downloads it through core's route. Refused (409) while the system has an error.
- `system-api.ts`: the one import of the engines (see "The engines").

Browser module (`src/server/extensions/design/`):

- `system.js`, `color.js`, `specimen.js`: pure logic with tests. `system.js` has the sections and groups, the model (saved values with the person's edits laid over them, aliases followed, loops found), contrast (declared pairs, or worked out for text colors), the history of edits (undo, redo, steps of one thing merged within 1.2 s, 500 kept), the change a save sends, and the CSS custom properties a design is told. `color.js` reads every form a token file has (hex, rgb, hsl, oklch, oklab, `color(srgb …)`, the 2025.10 objects) and measures WCAG 2.2 contrast. `specimen.js` makes the page of a component's states.
- `system-view.js` (bar, section tabs, modes, menu, problems, save bar, the open design beside it), `system-sections.js` (Colors with an overview card, roles, and palette ramps; Type; Spacing; Radii; Shadows; Motion with playable durations and easings; Other; Components; Guidelines), `system-widgets.js` (swatch, copy-name, badge, number and color fields, curve, alias picker, the token editor), `system-actions.js`, `system-data.js`, `system-preview.js`, `picker.js` (the design picker, with the pinned item, moved out of `workspace.js`), `check.js` (the Check dock).
- The state is in `state.js` (`systemState()`), so going back to the chat on a phone leaves the view as it was, unsaved edits included.

Also fixed, as asked:

- **The phone's frame on a phone.** The canvas size is `auto` until a person picks one: it follows the panel (under 700 px the phone's frame, under 1000 the tablet's, else the desktop's). An explicit pick is kept as before; `auto` is never saved.
- **Focus mode.** A button in both bars (only where the panel is beside the chat, 1100 px and up) hides the conversation and gives the panel the whole width (`html[data-dsn-focus]` in `style.css`). With the room the view and the open design sit side by side (from 900 px of panel).

## How it behaves

- **Edits** are a list of steps (`{ mode, token, raw }`), never written until Save. An edit that puts a saved value back changes nothing and is left out of the count and the save. A mode that takes the default's value follows an edit of the default (as far as the saved values can tell). Editing a token that links to another replaces the link; "Link to a token" opens a searchable list of the tokens of the same type that do not lead back. "Match Light" gives a mode the default's value. A color is written back as hex, in the dialect of the value it replaces (text, or the 2025.10 object).
- **Live preview.** `system-preview.js` computes, from the system and the steps, the custom properties to show; the canvas sends them through `pocket-tweak-set` in batches of 100 (the bridge's limit), with `null` to take one away. It sends the tokens that vary between modes (set to the mode in view, so a page that follows the OS's dark setting still shows the mode in view) and the tokens that differ from the saved default. A design on the canvas outside the view keeps showing unsaved edits (with a banner) in the default mode until they are saved or given up.
- **Components** are shown in a frame per component and mode, `sandbox="allow-same-origin"` (no scripts; the same origin only so that the page can read the frame's height), a CSP of `default-src 'none'`, markup without `script`, `meta`, `link`, `base`, `iframe`, `object`, `embed`, `form`, and CSS that cannot end its own `<style>`.
- **Check.** The Check tab of a design (people who steer) runs `POST system/check`, lists findings (pin number, rule, level, message, value → suggestion, the element), pins them with `pocket-highlight`, and **Send N to Pi** puts one message in the message box (each finding as JSON in a fence that nothing in it can end, marked as data from the page). It leaves the comment pins alone while it is open.
- **Viewers** see everything and change nothing: no undo, no save bar, no alias links, no check, no publish or export, no ask to Pi.
- **Not set up.** A project with no `.pi/design/` shows what to do: ask Pi to scan the project (or, with `.pi/design-system.md`, to convert it). A session with no designs has a way to the view from its empty page.
- **Safety.** Everything from project files is data: names, descriptions, and values are text nodes; styles that use a value pass `safeCss` (no `;{}<>\`, `url(`, `@`, comments, over 400 characters); the bridge names are checked with its own pattern and values over 200 characters are left out (a refused batch changes nothing); the message to Pi uses fences and one-line cuts.

## Tests

- `test/design-system-parts.test.ts`: color reading and contrast, sections and groups, search, edits through aliases, loops, inherited modes, contrast, roles, typed values, undo and redo and the cap, the change of a save, preview CSS and `safeCss`, specimen pages with hostile markup, font stacks.
- `test/design-system-routes.test.ts`: access (view, steer, one-session guest), the revision, no system and the old file, a linked folder, saves and their refusals, a stale revision, the shape checks of every field, guidelines and modes, the check and its report cut, publishing (once for each key, assets by hash), the zip and its download, a system with an error.
- `test/design-system-ui.test.ts` (real Chromium, 26 tests): the picker and every section; copy; live preview through the frame bridge (the page reports its button's color), undo, redo, discard, save; links; modes and side by side; typing checks; sizes, easings, and Ask Pi for a shadow; search; component frames; guidelines; a conflict; a refused save; the check and Send to Pi; publish and export from the menu; modes from the menu; a viewer; no system and the old file; an error in the system; focus mode; a phone (fits, the open design a tap away, the phone's frame, no overflow); `/design-open system` and the launcher; Ctrl+Z, Ctrl+Shift+Z, and Ctrl+S; Discard asking again, and Save saying what it wrote.
- `test/design-system-fixtures.ts` (the "Harbor" system and a page that uses it) and `test/serve-design-system.ts`.
- Run on the merged tree at the last commit: `npm run format` changes nothing, `npm run check` and `npm run lint` pass, and `npm test` passes 1167 of 1167 (the three `design-system-*` files hold 59 of them).

## Round 2: the integrator's review

- **The check's scheme.** The page in the canvas follows the app's dark scheme, so a check that ran in Light put its pins on colors that a person could not see. The check now **defaults to what the canvas shows**: its color scheme (the app's) and the size of its frame (`checkOptions` in `check.js`; the options are `null` until a person picks, and then follow the canvas). If a person picks the other scheme, the dock says that the canvas shows the other one and that the pins are for the checked one. The canvas is not forced into the checked scheme: a design is a page that this view does not control.
- **The sections at a panel's width.** At about 650 px (the panel beside the chat) the nine sections now fit one row: the counts show only on the section in use, and the tabs are closer; if they still do not fit, they wrap to a second row, so none runs off the edge. A phone scrolls them, with the one in use brought to the middle. A test checks that every section is inside the panel at that width.
- **The warnings box.** A warning is one line with a count (`⚠ 2 warnings  Show ⌄`) until a tap, at every width; an error is open where there is room, and one line on a phone. A test checks that the first token is in the first screen on a phone.
- Also: a color that is the same in every mode shown has one swatch, one value, and one badge (the flagship has hundreds); a component lists 8 of its tokens and says how many more; the contrast of a color with no declared pair is worked out only for plain text on the page (`primary`, `secondary`, `muted`, `link`…): `inverse`, `faint`, `disabled` and the like sit on other grounds, which only a declared pair can say (the flagship has several, and the first version marked them as failing); a phone with a system that has custom mode names gets a list of modes in place of the buttons; `--flagship` for `test/serve-design-system.ts` shows Pi Pocket's own system.

## Round 3: the integrator's second review

The judges gave people 6, enforcement 7, accessibility 7. The eight items, and what was done.

1. **Roles first, the palette after.** `groupsOf` (system.js) now orders every section as semantic tokens, then primitives, then a component's own tokens. Primitives start folded when the section has semantic tokens too; component tokens always start folded. Colors shows **Roles** as compact cards (swatch, short name, value, the contrast badge with its words when it fails). Every ramp goes into **one folded "Palette" group** as a strip: one row per ramp, swatches side by side, a tap opens the editor under the strip. **Component colors** is a second folded group. Type folds its sizes, families, weights and line heights under the styles; motion, spacing, radii, shadows and Other do the same with their component tokens. A group that has the same title in two tiers says the tier (`Durations · semantic`). A search opens every folded group that has a match, and a tap on a token from elsewhere (a component's "used" list, a problem) unfolds its group.
2. **The color overview is neutral.** It is a card made only of the system's roles: "Card title", "Body text reads at a glance.", "Muted text for the details.", a Primary and a Secondary button, and an Error, Warning and Success chip. It says nothing about ferries. It shows one card for each mode shown.
3. **Phone Check is a sheet.** On a narrow panel the Check dock is a bottom sheet of 62 % of the room, with a handle. The handle takes a drag (it settles on 34, 62 or 90 %), a tap (the next height), and the arrow keys; it is a `separator` with a value. The page stays visible above. Each finding has a pin button with a name ("Show finding 3 on the page"); a tap on the finding marks it, sets the canvas back to Fit, and asks the frame to scroll that element into view and ring its pin (a new `reveal` flag on a `pocket-highlight` target, see B below).
4. **Two tiles named "shadow".** Radii and shadow tiles are named by the shortest tail of the path that tells them apart: `lift`, and `card.shadow` against `menu.shadow` (`tails` in system.js; a test checks it).
5. **One count.** A tab says the number of tokens in its section; the rule is the docs page's: **every token is in exactly one section (`sectionOf`, the same function in system.js and in `docsite.ts`), whatever its tier, and a component's own tokens count too.** The sections add up to the system's tokens (the flagship: Colors 211, Other 54, Type 33, Motion 30, Spacing 28, Radii 18, Shadows 6 = 380), and a tab's number is what its section lists, folded groups included. G wrote the same rule in `ds-notes-g.md`; `sectionCounts` has a test that the sums agree. (The first version here left out component tokens and said 149; G's page and a tab that lists 211 colors would not agree, so that rule was dropped.)
6. **The picker's name on a phone.** The picker keeps 142 px, the mode list gives way (108 px, and its words are short: "Both modes"), and a test checks at 360 px that "Design system" is not cut.
7. **The pin badge.** The bridge's `update` (B's file) now puts a badge where it covers no text: above the element, else to its left, right, below, or inside its right edge; a place is free when no text of the page and no picture lies under it. A pin keeps its place while that stays free (a scroll moves all together).
8. **Keyboard and screen reader.** The nine sections are one tab stop with the arrow keys, Home and End (`role=tablist`, roving `tabindex`, `aria-controls`, a `tabpanel`). A two-pixel focus ring on every control of the view, the bars and the docks. Role cards are named with their value and contrast ("color.text.primary, #1c1e26, contrast 16.6:1 AAA"); strips with the token and value; the pins are buttons. A `role=status` region that is always in the page says a save ("Saved 1 change · tokens.css 9.1 KB") and the result of a check ("Checked version 1: 4 errors and 5 warnings."); refusals keep their `alert`. Tests: the tab order and rings of the main controls in the view and the dock, the arrow keys, the live regions, the sheet's three heights, and the 360 px picker.

### Round 3, second judge: three more items

1. **The check offers every mode of the system.** The Check dock lists the modes that the system has (the flagship: Light, Dark, High contrast), as buttons, or as a list when there are more than three or a phone cannot fit them. The route `system/check` takes `mode` (refused with the engine's words when the system has no such mode) and checks the page against that mode, in the color scheme the system gives it (`schemes`); the check kept for a design is per mode and size. The mode that the dock starts at is the one of the canvas: the page in the canvas follows the app's theme, or the backdrop when a person chose Light or Dark there (the frame now has that `color-scheme`, so the backdrop in the zoom bar and in the menu changes the page, not only what is behind it). When that mode changes while the dock is open (the app's theme, or the backdrop), a check that was made is made again in the new mode, unless that mode was checked already. A mode that a person picked in the dock is theirs: the canvas changes, nothing runs, and the dock says that the canvas shows another mode, with "Follow the canvas". The app's theme is kept in the store (`appDark`), so what depends on it draws again when it changes. The message to Pi names the mode ("high-contrast mode").
2. **The sections on a phone.** The bar of sections and the two buttons (the open design, the search) were one scroll bar with the buttons laid over its end, so the last tab showed half behind them. They are side by side now: the sections scroll in their own bar (it fades where more is out of sight), and the buttons stay at its end. On a phone only the section in use shows its count, so that four or five sections fit. A test checks that the bar and the buttons do not overlap at 390 px.
3. **The slow test.** "A system with an error says so at the top…" took 1.4 to 5 s alone here, and 11 to 14 s with four copies in parallel; it could not be made to take 32 s. What it spends is full page loads: three `go()`s, each of which loads the whole app, and a full run has a few dozen browsers doing that at once, so that on a busy machine the load alone can pass the 30 s that a `go` allows. The test now swaps the session inside the page (`navigate` of `store.js`, the way a tap on a session row does) and takes 0.2 to 3 s, also when four run together. The older 32 s in `r1-test.log` was a failure of the first round's version of this test ("Timed out waiting for the row"), which is gone. Two other tests had counted on the page that an earlier test left behind (the focus mode, the design that the view follows): they set that up themselves now.

### What B must know (these are B's files; U changed them)

`src/server/http/artifact-inspect.ts` and `web/artifact-bridge.js` changed, because pin placement is there. The change is `docs/design/ds-u-bridge.patch`. If B's branch changed the same lines, keep B's and apply the patch again: **(a)** `findPlace` and `covered` in `updatePins` put a pin where it covers no text (the first draft ran its hit tests on every frame for every pin: 148 ms a frame for 100 pins in view; now a place is found when a pin first shows, and again only when its element's place on the page or its size changes, when the content changes (a mutation observer, at most once a second), when the page is resized (a resize observer), or when the place leaves the screen; a frame spends at most 3 ms on first places, and a pin is hidden until it has one; a frame reads all the rectangles first and writes all the styles after, by `transform`, and only the ones that changed). Measured in Chromium on a long page, 1200 rows, 100 pins, scrolled by 40 px a frame: median 0.3 ms, 95th percentile 0.4 ms, worst 5.3 ms a frame. With all 100 pins on the screen at once (rows 9 px high): median 4.2 ms, 95th percentile 8.3 ms (the code before pin placement: 20 ms); **(b)** a `pocket-highlight` target may carry `reveal: true` (checked as a boolean in `checkAppMessage`): the page scrolls that element into view and draws its pin and outline stronger. `test/design-bridge-ui.test.ts` has two new lines for (b), and a test that a quiet page and a small scroll make no hit tests.

### What G must know

Nothing changed in `docsite.ts`. The count rule above is the one in `ds-notes-g.md`.

### Weak after round 3

- A tapped finding resets the zoom to Fit and asks the frame to scroll; the canvas does not pan to the pin when the page is zoomed in (the app cannot see where the pin is inside a frame; the bridge would have to send its place back).
- The sheet's drag was tried by hand with made-up pointer events; the test uses the keys, not a touch drag.
- Pin places are chosen by the text rectangles at that moment; a page that moves its text later (an animation) can put a badge over it until the next update.
- Role cards drop the alias chain (the editor has it); a person who wants to see "→ color.white" at a glance opens the card.
- The palette is folded: a person who looks for one primitive opens "Palette" first (a search opens it).

## Round 4: what T's engine gives the editor

T's `shadow` parts, `overrides` for each mode, `contrasts`, and the exempt pairs are all used now.

1. **A shadow is edited by its parts, and keeps its links.** The editor shows each layer with its X and Y offset, blur, spread and color, and whether it is inset. A member is a value of its own in the field of its kind (a size with a unit, a color), or a link to a token (`space.4`, `color.scrim.40`): a link has "Change" (the same list of tokens as for any link, here of the member's kind) and "Use a value" (the token's value becomes the member's); a value has "Link to a token". A layer is added (a copy of the last) or taken away. The parts are read from `ModeValue.parts` (the `var(--…)` of a member names the token it links to, found by `byVar`); an edit holds the DTCG value as the file has it (`{space.4}` stays that, one layer is an object, several are a list), and the model follows each link in the mode, so the tile, the open design (the `box-shadow` keeps `var()`) and the dark mode that takes the shadow from light all move with it. A shadow that is a link to another shadow shows that one's parts, read only, and "Use a value" copies them with their links. A typography style is still shown, and changed with Pi.
2. **Inherited, and give it back.** A mode other than the default says, in its editor, **Inherited from Light** (the mode's file does not set the token: `overrides`) or **Dark sets this itself** with **Use Light's value**, which is a removal: the edit is `{ inherit: true }`, `changeOf` makes it `remove: [{ mode, token }]` (only for a token that the file sets now), and the save sends `remove`. The route takes `remove` (the mode and the token, nothing more), refuses it in the default mode (it would delete the token), for a token the mode does not set, and for a mode or a token that is not there. A mode's token that is inherited follows an edit of the default's; one the file sets does not (before this, the view guessed from equal values). In one mode, an inherited color card has its value underlined dotted, a title, and "inherited from Light" in its name for a screen reader. Reset puts back the saved state of each mode (an inherited token is inherited again). "Match Light", which wrote a copy, is gone.
3. **All the pairs of a color.** The editor lists every pair a token declares (up to four) with its badge, and for a body text color with none, the page it is checked against; each pair names its ground, which opens. The badge in a card is the first pair, as before.
4. **An exempt pair is a note.** A pair below its minimum that is `exempt: "disabled" | "decorative"` has a neutral badge (**Exempt**), the line "exempt: decorative" in the list, and is in **N notes, no action needed**, a quiet line under the problems that opens to the notes (`DesignSystem.notes`); it is never counted as a warning, nor shown red.

The test fixture (Harbor) has a text color with two pairs (`color.text.link`), one with an exempt pair that falls (`color.text.placeholder`), and a shadow made of links (`shadow.lg`). New tests: the model (`design-system-parts.test.ts`: inheritance, a removal, a shadow's parts and its change, the pairs), the route (`design-system-routes.test.ts`: a removal and its refusals, a shadow saved with its links, the shape check), and the view (`design-system-ui.test.ts`: the three of them, in a browser; the typography test took the place of the shadow's Ask Pi).

Weak: a shadow's color that is a literal is shown as a hex field, and its alpha is in the hex (eight digits); there is no alpha slider. A shadow has no preview of its own in the editor (the tile above it moves). A part's list of links has every token of the kind (spacing, radii, font sizes), by name search. The inherited mark of a card is for one mode in view; side by side shows the values as before.

## Round 4: a cheap start

The app loads Design's browser module for everyone at every start, on phones too, also when nobody opens Design. It had grown to 24 files. Now the app loads three small files at start, the workspace when the panel first opens, and the rest when a person first needs it.

| Measured in Chromium, page loaded, nothing clicked | files                                      | bytes (source) | bytes on the wire |
| -------------------------------------------------- | ------------------------------------------ | -------------- | ----------------- |
| Before (`fd2178e`)                                 | 25 (24 JavaScript, `style.css`)            | 462,953        | 125,084           |
| After                                              | **3** (`index.js`, `paths.js`, `state.js`) | **17,506**     | **7,214**         |
| After, the panel opened (a design shown)           | 18                                         | 176,575        |                   |
| After, the System view opened as well              | 29                                         | 457,569        |                   |

The files, by when they load:

- **At the app's start:** `index.js` (the store, the rail button, the launcher actions, the command and event handlers, and a loading state), `paths.js` (the one icon), and `state.js`. The designs are not listed and no stylesheet loads until the panel opens (the designs list used to be read on every session change).
- **When the panel first opens** (`app.js`, with a loading state in the panel): the data, the actions, the picker, the toolbar, the canvas with the Check helpers, `style.css` (the workspace's sheet, 33 KB; the panel waits for its rules to apply, so nothing flashes bare).
- **When first needed:** `docks.js` (the tabs beside the canvas), `views.js` (compare, the variations grid, the slide strip, presentation), and the System view as one part, `system-ui.js` with `system.js`, `color.js`, `specimen.js`, `system-view.js`, `system-sections.js`, `system-widgets.js`, `system-actions.js`, `system-preview.js`, and its own sheet `system.css` (the rules of `style.css` that only the System view uses: 38 KB). A short loading state shows while a part loads.

What moved to make that so: `state.js` no longer imports `system.js` (it has its own empty history); the unsaved count and the change a save sends go through `unsaved.js`, which the System view fills in when it loads (with no edits the answer is 0 and nothing is loaded); `openSystem` and `focusFinding`, which the workspace needs, moved from `system-actions.js` to `app.js`; the preview watcher starts when the System view first loads (edits are only made there). `style.css` was split by what each rule styles (a `dsy-` class that the workspace's own parts use, such as the Check dock and the picker's pinned row, stays in `style.css`).

`test/design-system-ui.test.ts` holds the budget: on a page that starts with the panel shut, only those three files load and they are under 40,000 bytes; when the panel opens, none of the System view's files, nor `docks.js` or `views.js`, has loaded; the System view's files load when it opens. It prints the numbers.

Left alone: `docs/map.md` (the description of the `design/` folder there says that `index.js` sets up everything: it should name `app.js`, `system-ui.js`, `unsaved.js`, `paths.js` and `system.css`, and say which load when); the 33 KB of `style.css` is the panel's first cost (a split of the workspace's own sheet, such as the docks, would save more); `docks.js` still imports the Check dock, which `canvas.js` shares in part (`check.js`).

## The engines (round 2: the real ones)

`system-api.ts` re-exports `loadDesignSystem` and `writeDesignSystem` (T), `checkDesign` (V), and `renderSystemDoc` (G). The stand-ins are gone. With the real engines six tests of this stream failed. The causes, and what was done:

1. **A save that must be refused was accepted.** The real `set` makes a mode file for a mode that does not exist, and a token for a name that does not exist (it is how Pi adds them). The view only changes tokens that are there, in modes that are there, so the route now refuses a `set` that names a mode or token the loaded system does not have (400). The route also refuses `{}` for a mode that exists (it would empty its file) and the removal of the default mode. T does not need to change this: it is the route's rule.
2. **The fixture had two real warnings** (T's checks): `color.bg.overlay` held a raw value (a semantic color), and `color.text.disabled` failed its 4.5:1 pair on purpose. The fixture's tokens are fixed, not the warnings hidden: `overlay` links to a new primitive `color.scrim.40` (the 2025.10 object with an alpha; dark uses `scrim.60`), and `disabled` declares the quieter 3:1 pair that it reaches. The tests that wanted a failing badge now cause one with an edit (the pair falls, the badge says Fail, undo brings it back). The Harbor system loads with no problem.
3. **`loadDesignSystem` throws for a linked `.pi/design`** (it did not return `undefined`). The route answers 400 with the engine's words, and the view says it could not read it. The test says so.
4. **The error test.** The engine leaves out a token that failed (`color.accent.hover` with a link to nothing), so it has no row to go to: a problem whose token is not in the system is now a label, not a button. The warning test uses a real warning (too faint in dark) whose token has a row.
5. **The focus test** failed only because the test before it left the session on a system with no design.
6. **The messages for a person.** `DesignSystemError.message` is written for Pi ("Fix it and call again"). The route says `Not saved: …` with the problems' own messages (3 at most, then "and N more"), and sends the problems cut to a fixed shape.

Used from the new engine: `schemes` (a mode's colour scheme: the specimen's page and `color-scheme`), the `parts` of a typography token (`font-size: var(--font-size-base)`): a type style is drawn from them, so an edit to the size token moves the specimen and its line (`20px / 1.5 · 400 · Geist`); a contrast pair's `on` as a bare name; the token left out of a mode that failed.

What T could still change (none of it blocks the view):

- `DesignSystemError` could carry a short `summary` for people next to the message written for Pi.
- A shadow has no `parts`: its box-shadow is drawn from the resolved value, so an edit to a color that a shadow uses does not move the shadow's tile. `parts` for a shadow (`color`, `offset-x`, … as `var(--…)`) would let it, and let the view edit a shadow's members.
- Which tokens a mode file overrides (`overrides: string[]` on a mode): the view cannot tell an override from a value that is inherited, so "Match Light" writes the default's value as an override. With it the view could show "inherited" and use `remove` to reset.
- `ResolvedToken.contrast` is the first pair only; a token with several pairs shows its first.

What V and G need to keep: findings with a `pid` or a `selector` (no pin without one) and `suggestion` as `var(--color-…)`; the docs page's asset names are valid bundle names (the route refuses 200 assets or 2 MB).

## Differences from the plan, and choices made

- The route that saves answers 200 with `{ ok: false }` when the engine refuses a change (see above). A stale revision is a 409.
- The zip has the four generated files at its root (no `dist/` folder); the file is `<system name>-tokens.zip`.
- An "Other" section holds what no other section takes (z-index, breakpoints, plain numbers). Plan sections are all there.
- Components show all the states of one component in one frame (a grid), per mode, not one frame per state.
- Composite tokens are read-only (above). A shadow's fields, a typography style's parts, and gradients are changed with Pi: "Ask Pi" puts a request about the token, with its values as data, in the message box.
- Check runs on the saved system (the server loads it), not on unsaved edits.
- The default size of the canvas is `auto` (above), which is a change of `state.js`'s prefs.
- `/design-open system` opens the view (no new command: a second built-in command would change `test/extension-commands.test.ts`, which is not mine); a launcher action "Open the design system" does the same.
- Undo is kept to 500 steps; a step that a later one makes no difference to goes first.
- `src/server/extensions/design/picker.js` is new: the picker moved out of `workspace.js` so that the System bar can use it.

## What the docs must say (for the integrator)

`docs/features.md`, in **Design**, a bullet after **Decks**:

> **The design system.** The first row of the design picker (or `/design-open system`, or the launcher's "Open the design system") shows the project's design system, `.pi/design/` in the session's folder: **Colors** (a neutral card of the look in each mode, roles as cards with their value and contrast badge, the palette as one folded group of ramp strips), **Type**, **Spacing**, **Radii**, **Shadows**, **Motion** (durations and easings that play), **Components** (every state, in a frame that runs nothing and loads nothing), and **Guidelines** (Markdown). Light and dark show one at a time or side by side. People who steer change a color, a size, a time, a weight, a font, or an easing in place, or link a token to another; the open design shows each change live (it follows the system when it uses its variables), **Undo** and **Redo** step through them, **Discard** gives them up, and **Save** writes the files and the generated CSS with no run of Pi (it refuses a change that the system's checks refuse, and one made on a system that changed meanwhile). A shadow is edited by its parts (each a value or a link to a token, kept as a link), a mode says which of its tokens it takes from the default mode and can give one back, a color lists all its contrast pairs (a pair that is exempt is a note, not a failure), and a typography style is changed with Pi. The menu publishes the documentation as a design (`design-system-docs`, a new version each time), exports the generated files as a zip, and adds or removes a mode. A design's **Check** tab (in any mode of the system, the one of the canvas to start with) renders the page on the server and lists what is not the system's (colors, fonts, sizes), contrast, tap targets, overflow, alt text, and headings, with a pin on each element (on a phone the list is a bottom sheet with a handle, and a tap on a finding shows its pin); **Send to Pi** puts one message with them in the message box. People who only view see everything and change nothing. A project with no `.pi/design/` is told how to get one. **Focus mode** (the button by the menu, where the panel is beside the chat) hides the conversation for wide work. Until a size is chosen, the canvas takes the size of its panel, so a phone gets the phone's frame.

`docs/map.md`: `extensions/design/` gains `system-routes.ts`, `system-api.ts`, and the browser files above; `test/design-system-*.test.ts`, `test/serve-design-system.ts`.

`docs/extensions/built-in.md`: the module's routes `system`, `system/check`, `system/docs`, `system/export` and its event `system`.

## What is still weak

- Unsaved edits are lost when the tab reloads (they live in the module's store, which survives closing the panel and going to the chat).
- Nothing creates, renames, deletes, or reorders a token; a mode is added or removed, and tokens already there are changed.
- Gradients, borders, transitions, and typography styles are read-only (a shadow is edited by its parts).
- The page check does not see unsaved edits.
- A design shows the edits only when it uses the system's variables. The view says so, but cannot tell whether a given design does.
- The first 120 tokens of a group are drawn, with "Show more"; there is no virtual list beyond that. Frames of components reload all together when an edit changes the mode's CSS.
- The contrast of a color with no declared pair is worked out against the page background for text colors only (shown with a dashed badge).
- Light app themes were checked by changing the theme's variables on a dark build, not with each shipped light theme.
