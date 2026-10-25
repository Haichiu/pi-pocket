// The server's clock as this tab can know it: how far it is ahead of this browser's, from the clocks hellos carry. No
// DOM here: `store.js` keeps the offset, and `seen.js` turns the server's times into this device's.

/**
 * The offset (the server's clock minus this browser's) after a hello whose clock says `now`, from the offset kept so far
 * (undefined before the first). The server read `now` before this tab handled the hello (`handled`, this browser's
 * clock), and after this tab asked for it (`asked`), when the hello answers a request of its own: so the offset is at
 * least `now - handled`, and at most `now - asked`. The kept offset moves only as far as those bounds need, and a first
 * one starts between them. A hello handled late (a tab woken from the background, events queued while it slept) only
 * lowers the first bound: it moves nothing, where taking `now - handled` as the offset would move every time shown.
 */
export function fitClock(kept, now, handled, asked) {
    const least = now - handled;
    const most = asked === undefined ? Infinity : now - asked;

    if (kept === undefined) {
        return most === Infinity ? least : (least + most) / 2;
    }

    return Math.min(Math.max(kept, least), most);
}
