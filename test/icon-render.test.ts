import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { inflateSync } from "node:zlib";
import { APP_ICON, renderIcon } from "../src/server/icon-render.ts";

/** An 8-bit RGB PNG with no interlacing, as pixels. */
function decode(png: Buffer): { size: number; pixels: Buffer } {
    let at = 8;
    let size = 0;
    const data: Buffer[] = [];

    while (at < png.length) {
        const length = png.readUInt32BE(at);
        const type = png.toString("latin1", at + 4, at + 8);

        if (type === "IHDR") {
            size = png.readUInt32BE(at + 8);
            assert.equal(png[at + 16], 8, "8 bits");
            assert.equal(png[at + 17], 2, "RGB");
        }

        if (type === "IDAT") {
            data.push(png.subarray(at + 8, at + 8 + length));
        }

        at += 12 + length;
    }

    const raw = inflateSync(Buffer.concat(data));
    const stride = size * 3;
    const pixels = Buffer.alloc(size * stride);

    for (let y = 0; y < size; y++) {
        const filter = raw[y * (stride + 1)]!;

        for (let x = 0; x < stride; x++) {
            const value = raw[y * (stride + 1) + 1 + x]!;
            const left = x >= 3 ? pixels[y * stride + x - 3]! : 0;
            const up = y > 0 ? pixels[(y - 1) * stride + x]! : 0;
            const upLeft = x >= 3 && y > 0 ? pixels[(y - 1) * stride + x - 3]! : 0;
            let add = 0;

            if (filter === 1) {
                add = left;
            } else if (filter === 2) {
                add = up;
            } else if (filter === 3) {
                add = (left + up) >> 1;
            } else if (filter === 4) {
                const p = left + up - upLeft;
                const [a, b, c] = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - upLeft)];

                add = a <= b && a <= c ? left : b <= c ? up : upLeft;
            }

            pixels[y * stride + x] = (value + add) & 255;
        }
    }

    return { size, pixels };
}

const meanDifference = (a: Buffer, b: Buffer) => {
    let sum = 0;

    for (let i = 0; i < a.length; i++) {
        sum += Math.abs(a[i]! - b[i]!);
    }

    return sum / a.length;
};

test("in the app's own colors the server draws the icon of web/icon-512.png", () => {
    const drawn = decode(renderIcon(APP_ICON, 512)!);
    const file = decode(readFileSync(new URL("../web/icon-512.png", import.meta.url)));

    assert.equal(drawn.size, 512);
    // Edges differ by anti-aliasing and the π was taken from this very file, so the mean difference stays small; a shape
    // in the wrong place, or a wrong color, is many pixels off at once and fails this.
    assert.ok(meanDifference(drawn.pixels, file.pixels) < 1.5, "the same drawing");
});

test("other colors give other pixels, in the places the colors name", () => {
    const grey = {
        frame: "#070707",
        card: "#000000",
        ring1: "#b0b0b0",
        ring2: "#b6b6b6",
        pi: "#b9b9b9",
    };
    const { size, pixels } = decode(renderIcon(grey, 180)!);
    const at = (x: number, y: number) => [
        ...pixels.subarray((y * size + x) * 3, (y * size + x) * 3 + 3),
    ];

    assert.deepEqual(at(2, 2), [7, 7, 7], "the frame");
    assert.deepEqual(at(40, 40), [0, 0, 0], "the card");
    // The brightest pixel of the middle is the π's, in the color given; the card and the frame are darker than it.
    let brightest = 0;

    for (let y = 40; y < 140; y++) {
        for (let x = 40; x < 140; x++) {
            brightest = Math.max(brightest, at(x, y)[0]!);
        }
    }

    assert.equal(brightest, 0xb9, "the π");
});

test("a size is kept in range, and a color that is not hex is refused", () => {
    assert.equal(decode(renderIcon(APP_ICON, 5)!).size, 64);
    assert.equal(decode(renderIcon(APP_ICON, 99999)!).size, 1024);
    assert.equal(renderIcon({ ...APP_ICON, pi: "red" }, 180), null);
});
