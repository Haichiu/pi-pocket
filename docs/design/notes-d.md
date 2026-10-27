# Stream D: Design agent tools

## Built

- `src/server/design/index.ts` exports `designTools(host)`, `designGuide(host)`, and `designRoutes(web, host)`.
- `design_preview` returns PNG image blocks and bounded console/request diagnostics. It defaults to mobile and desktop. Optional slide numbers start at 1. Deck previews show slide 1 by default and fit the requested device size.
- `design_export` writes PNG, PDF, PPTX, or an HTML ZIP inside the session folder. The default is `exports/<id>-v<version>.<ext>`. Existing files are replaced atomically. Directory links and outside paths are refused.
- PPTX contains full-bleed 16:9 slide images and searchable speaker notes. It includes the OPC relationships, theme, masters, layout, and content types. It has no external dependencies.
- PNG exports the full page, up to 2560 × 16000 pixels. A deck PNG shows slide 1. PDF exports all deck slides on separate widescreen pages.
- Hidden deck slides retain their authored flex/grid display. CDP matched styles recover the base display below hiding rules.
- HTML ZIP contains the original page and binary assets. Its entry page is `index.html`. If an asset uses that name, the entry becomes `pocket-design.html`, with a numeric suffix if needed.
- `design_system` reads and writes `<session folder>/.pi/design-system.md`. It bounds text to 16 KB. Reads reject nonregular files and final links. Reads and writes reject a linked `.pi` folder. Writes use an adjacent exclusive temporary file and atomic rename.
- `designGuide` gives the complete authoring workflow. It includes existing design-system text as fenced, defanged, untrusted project data.
- The read-only preview tool is replay-safe. File-writing tools do not claim replay safety or read-only access.

## Rendering and access

Each render launches a separate headless Chromium process with its own temporary profile. It never uses the browser that people watch.

A temporary HTTP server binds only to `127.0.0.1`. A random 256-bit bearer path serves only the selected committed bundle. Relative assets resolve below that path. The endpoint closes after the render. Chromium receives no session cookie, user token, or app URL.

This deliberately replaces the plan's proposed authenticated `/a/...` request to the live server. It avoids granting untrusted page scripts an app credential. The private endpoint has the same opaque-origin sandbox principle, with stricter render-only restrictions. It serves raw HTML without the interactive app bridge or saved state.

External document navigation is refused before any public fetch. A page cannot replace its render CSP with a public document. Other nonbundle requests pass through `host.fetchPublic`. Its connection-time DNS and redirect checks refuse private network addresses. Only GET and HEAD requests pass. Chromium cannot open frames, workers, popups, or sockets through the render CSP. A pre-document script removes RTC and WebTransport APIs with immutable properties. Chromium also disables nonproxied WebRTC UDP. This closes a WebRTC bypass that the fresh review reproduced.

Limits: 2 concurrent renders, 90 seconds per render, 400 requests, 20 concurrent external requests, 5 MB per external resource, and 50 MB external resources total. Console and request diagnostics each keep at most 100 entries of 2000 characters. PPTX accepts 1–100 deck slides and at most 100 MB of slide images.

The renderer closes Chromium and the endpoint on success, failure, or cancellation. It removes the profile with retries and always releases its concurrency slot.

## Interfaces for integration

### Stream A

`bundle.ts` contains a temporary adapter. It first checks for an optional `host.artifactBundle(conversation, artifact, version?)` method. Its return shape is `{ meta, version: number, content, assets: { name, type, bytes: Buffer }[] }`.

Without that method, the adapter reads committed `ArtifactsDoc` and `ArtifactBodyDoc` snapshots. It supports existing asset-free HTML artifacts. It refuses stored assets rather than silently exporting an incomplete bundle. The integrator must connect it to A's full bundle reader.

`src/server/design/zip.ts` is a temporary dependency-free ZIP adapter. The integrator must replace its imports in `pptx.ts` and `export.ts` with A's `src/server/zip.ts`, then remove the adapter. Both implement `zip(entries: { name: string; bytes: Buffer }[]): Buffer`.

### Stream C and the HTTP layer

Register the returned tools and prompt section in C's `design.ts` module.

`designRoutes(web, host)` registers `GET /api/x/design/export` with steer access. Query fields:

- `conversation`: a session ID in the signed-in person's current session list.
- `id`: the artifact's kebab-case ID.
- `version`: an optional positive integer.
- `format`: `png`, `pdf`, `pptx`, or `html`.
- `viewport`: optional `mobile`, `tablet`, `desktop`, or `WIDTHxHEIGHT`. Width is 320–2560; height is 240–2560.

The route returns a standard binary `Response` with attachment, MIME, no-store, and nosniff headers. It never accepts a local filesystem path. C must fetch with `X-Pocket`, turn the response into a blob, and download it. The current core extension HTTP layer only serializes JSON. The integrator must add binary `Response` support before the workspace download works.

## Documentation to merge

- `features.md`: describe private previews; PNG, PDF, image-slide PPTX with text notes, HTML ZIP; project design systems; and the preview-before-reply workflow. Explain that PPTX slides are images, not editable vector shapes. Canva export is not included.
- `map.md`: list the new `src/server/design/` tools, prompt guide, private renderer, bundle adapter, and PPTX writer. Document the Design module's imports and export route.
- Release notes: include design previews at phone and desktop sizes, portable exports, deck presentations, and reusable project design systems.

## Checks and remaining work

- Focused Design tests: 38 pass, including real Chromium, token-scoped assets, blocked private HTTP and UDP, blocked external navigation, preserved hidden-slide layout, device fitting, cancellation cleanup, file bounds, links, FIFO rejection, prompt fencing, ZIP structure, and tool contracts.
- `npm run format`: passed. It also fixed an inherited, unrelated unbraced `if` in `src/server/extensions/prompt.ts:123`. That incidental change was restored to respect stream ownership.
- `npm run check`: passed. Scoped ESLint on all Design source and tests passed.
- Final `npm run lint`: fails only on the inherited `prompt.ts:123` brace error. The integrator must apply that one brace correction. No unrelated source change is committed here.
- Full `npm test`: 788 passed, 0 failed, 0 skipped. The final committed-source confirmation run passed all 788 tests again.
- The throwaway copy ran with `node test/serve.ts 8904 127.0.0.2`. The mobile page loaded without console errors. The copy was stopped. C's canvas was not present in this isolated branch.
- Generated and visually inspected a deck PNG. Chromium PDF has 2 widescreen pages with searchable text. LibreOffice 26.8 opened the generated PPTX and exported 2 widescreen PDF pages. `unzip -t` passed. PowerPoint and Keynote were not available for direct checks.
- A strong-model read-only review found 3 defects. The implementation and regression tests address all 3. A follow-up review reproduced a navigation-based TURN-over-TCP bypass. The final review repeated that probe after the fix: 0 public document fetches, 0 private TCP connections, and 0 bytes. It found no remaining blocker.

Open integration requirements are the complete bundle reader, shared ZIP import, binary route response handling, and C's module registration. No npm dependencies, live-server changes, restart, push, or pull request are part of this stream.
