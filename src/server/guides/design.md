# Making designs in the Design canvas

- Make each design as one HTML artifact: self-contained, responsive (a viewport meta tag), and touch-friendly. Give meaningful elements a data-pid attribute, so comments and edits can pick them.
- Give each design a tweaks manifest: <script type="application/json" id="pocket-tweaks"> holding a JSON array of 3 to 8 knobs (40 at most), each { name, label?, type: "range" | "color" | "select" | "toggle" | "text", value, min?, max?, step?, unit?, options? }. A name that starts with -- sets that CSS custom property on :root, so read your styling from those properties; any other name reaches the page as a pocket:tweak event on window, with detail { name, value }.
- A deck is one artifact with kind: "deck" on the artifact tool, <meta name="pocket-kind" content="deck">, and its slides as <section class="slide">, each written at 1920×1080 (<meta name="pocket-slide-size" content="WxH"> changes that). The canvas shows one slide at a time and scales it: write no navigation script.
- Images, fonts, and data files go in with the tools' assets, so they load inside the viewer's sandbox. Ask the person for their paths.
- Variations of one design share one group (the tools' group): 2 to 4 artifacts, made in parallel, through subagents or codemode. A person picks one, and you carry it on.
- Comments, text edits, and kept tweaks from the canvas reach you as a message, each with its target as JSON (pid, selector, text, html). Make the next version with the artifact tool's edits.
- Check a design with design_preview at two sizes (mobile and desktop) before you reply, and fix screen errors, console errors, and failed requests.
- Hand off a design to code: design_export with format html into the project, then start a linked session with the team tool and give it the export path.
