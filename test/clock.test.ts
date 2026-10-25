// The server's clock as a tab knows it (web/clock.js): a hello handled late does not move the times the tab shows.
import assert from "node:assert/strict";
import { test } from "node:test";

const { fitClock } = (await import(new URL("../web/clock.js", import.meta.url).href)) as {
    fitClock: (kept: number | undefined, now: number, handled: number, asked?: number) => number;
};

const MINUTE = 60_000;
/** A server time, and the moment the browser shows for it with an offset (`seen.js` `fromServer`). */
const at = 1_000_000_000_000;
const shown = (offset: number) => at - offset;

test("a first hello it asked for sets the offset between what the request proves", () => {
    // The browser is 5 minutes behind the server; the hello took 200 ms there and back.
    const asked = 2_000;
    const offset = fitClock(undefined, asked + 100 + 5 * MINUTE, asked + 200, asked);

    assert.equal(offset, 5 * MINUTE);
});

test("a hello handled 3 minutes late does not move the times shown", () => {
    // Same clocks: the first hello answers quickly.
    const first = fitClock(undefined, 10_000 + 50, 10_000 + 100, 10_000);
    const before = shown(first);

    // The server sends a hello of itself at 15:42; the tab sleeps and handles it at 15:45.
    const now = 20 * MINUTE;
    const late = fitClock(first, now, now + 3 * MINUTE, undefined);

    assert.equal(late, first);
    assert.equal(shown(late), before);
    // A new connection's first hello, handled late as the tab wakes, moves nothing either.
    assert.equal(fitClock(first, now, now + 3 * MINUTE, now - 10), first);
});

test("a device clock that changes is followed", () => {
    const first = fitClock(undefined, 10_000 + 50, 10_000 + 100, 10_000);

    // The browser's clock goes back 2 minutes: any hello proves the server is further ahead now.
    const back = fitClock(first, 30_000, 30_000 - 2 * MINUTE + 10, undefined);

    assert.ok(Math.abs(back - 2 * MINUTE) < 100);

    // It goes forward 2 minutes: the next hello it asks for proves the server is no longer ahead.
    const asked = 40_000 + 2 * MINUTE;
    const forward = fitClock(back, 40_000 + 20, asked + 40, asked);

    assert.ok(forward <= -2 * MINUTE + 20 && forward >= -2 * MINUTE - 40);
});

test("without a request to bound it, a first hello still counts", () => {
    assert.equal(fitClock(undefined, 5_000, 4_000, undefined), 1_000);
});
