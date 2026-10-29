// The one place the rest of the scan imports the color modules from.
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
