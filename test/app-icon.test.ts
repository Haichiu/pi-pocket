import assert from "node:assert/strict";
import { test } from "node:test";

type Vars = Record<string, string>;

// A web module, loaded as the browser loads it; its path as a value keeps the type checker from looking for types.
const ICON: string = "../web/app-icon.js";
const { iconSvg } = (await import(ICON)) as {
    iconSvg(vars: Vars, options?: { maskable?: boolean }): string;
};

// Vantablack's palette as theme.js's `themeVars` maps it (theme.js needs a page, so the variables are written out).
const vantablack: Vars = {
    "--o-bg": "#000000",
    "--o-bg-darker": "#070707",
    "--o-orange": "#b9b9b9",
    "--o-cyan": "#b0b0b0",
    "--o-green": "#b6b6b6",
};
const tokyo: Vars = {
    "--o-bg": "#1a1b26",
    "--o-bg-darker": "#16161e",
    "--o-orange": "#ff9e64",
    "--o-cyan": "#449dab",
    "--o-green": "#9ece6a",
};

test("the icon is drawn in the palette's colors", () => {
    const svg = iconSvg(vantablack);

    assert.match(svg, /fill="#000000"/, "the card is the palette's background");
    assert.match(svg, /fill="#070707"/, "the frame around it is the darker background");
    assert.match(svg, /fill="#b9b9b9"/, "the π is the palette's orange");
    assert.doesNotMatch(
        svg,
        /#ff9e64|#33ccff|#00ff99|#1a1b26/,
        "no color of the app's own icon is left",
    );
});

test("two palettes give two icons", () => {
    assert.notEqual(iconSvg(tokyo), iconSvg(vantablack));
});

test("a maskable icon fills the square and keeps the art inside the safe zone", () => {
    const svg = iconSvg(vantablack, { maskable: true });

    assert.match(
        svg,
        /<rect width="512" height="512" fill="#070707"/,
        "the whole square has the frame's color",
    );
    assert.match(
        svg,
        /translate\(80 80\) scale\(0\.6875\)/,
        "352 of 512 pixels, as the 80-pixel margins leave",
    );
    assert.doesNotMatch(iconSvg(vantablack), /scale\(/, "the plain icon is not scaled");
});
