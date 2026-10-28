/**
 * Colors for the design system scan (stream T): merges near-identical colors, decides which color plays which role
 * (page background, surface, text, muted text, border, accent, danger, warning, success) from the names of the
 * project's variables first and from how the colors are used second, and names the palette by hue and lightness. The
 * work is in `scan-color-base.ts` (the entries and the merging), `scan-color-names.ts` (how a name fits a role),
 * `scan-color-roles.ts` (the choice of a color for each role), and `scan-color-palette.ts` (the palette's names); this
 * file is the one place the rest of the scan imports them from.
 */
export {
    ROLE_PATHS,
    type ColorEntry,
    type RoleName,
    distance,
    entryOf,
    merge,
    mergeColors,
    nearColors,
    totalUses,
} from "./scan-color-base.ts";
export { nameScore, words } from "./scan-color-names.ts";
export { STEPS, family, paletteName, step } from "./scan-color-palette.ts";
export { type RoleChoice, type VarColor, chooseRoles } from "./scan-color-roles.ts";
