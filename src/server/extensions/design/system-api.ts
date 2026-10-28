/**
 * The engines that the System view's routes call, behind one import. Until streams T (tokens), V (checks), and G (the
 * documentation page) land, they are the stand-ins of `system-stub.ts`; after the merge, replace the re-export below with
 *
 *     export { loadDesignSystem, writeDesignSystem } from "../../design/tokens.ts";
 *     export { checkDesign } from "../../design/lint.ts";
 *     export { renderSystemDoc } from "../../design/docsite.ts";
 *
 * (`CheckOptions` is the shape of `checkDesign`'s `options`; V's own type replaces it.) See docs/design/ds-notes-u.md.
 */
export {
    type CheckOptions,
    checkDesign,
    loadDesignSystem,
    renderSystemDoc,
    writeDesignSystem,
} from "./system-stub.ts";
