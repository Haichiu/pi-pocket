// A toast. Colors come from the theme: never hard-code one here.
import type { Theme } from "../theme";

export function toastStyle(theme: Theme, kind: "info" | "danger" | "success") {
    return {
        background: theme.colors.surface,
        color: theme.colors.text,
        borderLeft: `${theme.space[1]}px solid ${theme.colors[kind]}`,
        borderRadius: theme.radii.md,
        padding: theme.space[4],
        boxShadow: theme.shadows.lg,
    };
}
