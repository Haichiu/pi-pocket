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
- Run on the merged tree at the last commit: `npm run format` changes nothing, `npm run check` and `npm run lint` pass, and `npm test` passes 1167 of 1167 (the three `design-system-*` files hold 65 of them).

## Round 2: the integrator's review

- **The check's scheme.** The page in the canvas follows the app's dark scheme, so a check that ran in Light put its pins on colors that a person could not see. The check now **defaults to what the canvas shows**: its color scheme (the app's) and the size of its frame (`checkOptions` in `check.js`; the options are `null` until a person picks, and then follow the canvas). If a person picks the other scheme, the dock says that the canvas shows the other one and that the pins are for the checked one. The canvas is not forced into the checked scheme: a design is a page that this view does not control.
- **The sections at a panel's width.** At about 650 px (the panel beside the chat) the nine sections now fit one row: the counts show only on the section in use, and the tabs are closer; if they still do not fit, they wrap to a second row, so none runs off the edge. A phone scrolls them, with the one in use brought to the middle. A test checks that every section is inside the panel at that width.
- **The warnings box.** A warning is one line with a count (`⚠ 2 warnings  Show ⌄`) until a tap, at every width; an error is open where there is room, and one line on a phone. A test checks that the first token is in the first screen on a phone.
- Also: a color that is the same in every mode shown has one swatch, one value, and one badge (the flagship has hundreds); a component lists 8 of its tokens and says how many more; the contrast of a color with no declared pair is worked out only for plain text on the page (`primary`, `secondary`, `muted`, `link`…): `inverse`, `faint`, `disabled` and the like sit on other grounds, which only a declared pair can say (the flagship has several, and the first version marked them as failing); a phone with a system that has custom mode names gets a list of modes in place of the buttons; `--flagship` for `test/serve-design-system.ts` shows Pi Pocket's own system.

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

> **The design system.** The first row of the design picker (or `/design-open system`, or the launcher's "Open the design system") shows the project's design system, `.pi/design/` in the session's folder: **Colors** (an overview of the look in each mode, roles with their alias chains and contrast badges, palettes as ramps), **Type**, **Spacing**, **Radii**, **Shadows**, **Motion** (durations and easings that play), **Components** (every state, in a frame that runs nothing and loads nothing), and **Guidelines** (Markdown). Light and dark show one at a time or side by side. People who steer change a color, a size, a time, a weight, a font, or an easing in place, or link a token to another; the open design shows each change live (it follows the system when it uses its variables), **Undo** and **Redo** step through them, **Discard** gives them up, and **Save** writes the files and the generated CSS with no run of Pi (it refuses a change that the system's checks refuse, and one made on a system that changed meanwhile). Shadows and typography styles are made of parts that link to other tokens: change the tokens they use, or ask Pi. The menu publishes the documentation as a design (`design-system-docs`, a new version each time), exports the generated files as a zip, and adds or removes a mode. A design's **Check** tab renders the page on the server and lists what is not the system's (colors, fonts, sizes), contrast, tap targets, overflow, alt text, and headings, with a pin on each element; **Send to Pi** puts one message with them in the message box. People who only view see everything and change nothing. A project with no `.pi/design/` is told how to get one. **Focus mode** (the button by the menu, where the panel is beside the chat) hides the conversation for wide work. Until a size is chosen, the canvas takes the size of its panel, so a phone gets the phone's frame.

`docs/map.md`: `extensions/design/` gains `system-routes.ts`, `system-api.ts`, and the browser files above; `test/design-system-*.test.ts`, `test/serve-design-system.ts`.

`docs/extensions/built-in.md`: the module's routes `system`, `system/check`, `system/docs`, `system/export` and its event `system`.

## What is still weak

- Unsaved edits are lost when the tab reloads (they live in the module's store, which survives closing the panel and going to the chat).
- Nothing creates, renames, deletes, or reorders a token; a mode is added or removed, and tokens already there are changed.
- Multi-layer shadows, gradients, borders, and transitions are read-only.
- A shadow's tile does not move with an edit to a color it uses (above); the page check does not see unsaved edits.
- A design shows the edits only when it uses the system's variables. The view says so, but cannot tell whether a given design does.
- The first 120 tokens of a group are drawn, with "Show more"; there is no virtual list beyond that. Frames of components reload all together when an edit changes the mode's CSS.
- The contrast of a color with no declared pair is worked out against the page background for text colors only (shown with a dashed badge).
- Light app themes were checked by changing the theme's variables on a dark build, not with each shipped light theme.
