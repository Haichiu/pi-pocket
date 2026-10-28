/** The engines that the System view's routes call, behind one import: tokens (T), checks (V), and the docs page (G). */
export { loadDesignSystem, writeDesignSystem } from "../../design/tokens.ts";
export { type CheckOptions, checkDesign } from "../../design/lint.ts";
export { renderSystemDoc } from "../../design/docsite.ts";
// The rewrite of exact matches (`var(--token)` for a literal that is a token's): a stand-in with the signature that V's
// function will have (`FixExactMatches`), until V's lands. Replace this line, and the route and the dock stay as they are.
export { fixExactMatches, type FixResult, isFixable } from "./system-fix.ts";
