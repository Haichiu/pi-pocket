// The theme object for the React components (styled-components reads it). It mirrors src/styles/_variables.scss.
export interface Theme {
    colors: Record<string, string>;
    radii: Record<string, number>;
    space: number[];
    fontSizes: number[];
    fonts: Record<string, string>;
    shadows: Record<string, string>;
}

export const lightTheme: Theme = {
    colors: {
        bg: "#f8f9fa",
        surface: "#ffffff",
        text: "#212529",
        muted: "#868e96",
        border: "#dee2e6",
        primary: "#1c4e80",
        info: "#1f9d8b",
        danger: "#c92a2a",
        warning: "#e67700",
        success: "#2b8a3e",
    },
    radii: { sm: 3, md: 6, lg: 12, pill: 999 },
    space: [0, 4, 8, 12, 16, 24, 32, 48],
    fontSizes: [12, 14, 16, 20, 28, 36],
    fonts: {
        body: '"Source Sans 3", "Helvetica Neue", Arial, sans-serif',
        heading: '"Merriweather", Georgia, serif',
        code: '"Fira Code", Menlo, monospace',
    },
    shadows: {
        sm: "0 1px 3px rgba(33, 37, 41, 0.12)",
        lg: "0 8px 24px rgba(33, 37, 41, 0.18)",
    },
};

export const darkTheme: Theme = {
    ...lightTheme,
    colors: {
        bg: "#101418",
        surface: "#1a2027",
        text: "#e9ecef",
        muted: "#9aa5b1",
        border: "#2d3640",
        primary: "#6aa7e8",
        info: "#3bc9b5",
        danger: "#ff8787",
        warning: "#ffa94d",
        success: "#69db7c",
    },
    shadows: {
        sm: "0 1px 3px rgba(0, 0, 0, 0.5)",
        lg: "0 8px 24px rgba(0, 0, 0, 0.6)",
    },
};
