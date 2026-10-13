// The landing page's own Shiki pair, drawn from the paintings: ink for
// identifiers, slate blue for strings, lamp rust (light) or lamp amber (dark)
// for keywords, and grey for punctuation and comments. Only CodeCard uses it,
// so docs code blocks keep Blume's default theme.
import type { CodeThemes } from "blume/markdown";

const theme = (
  name: string,
  type: "light" | "dark",
  colors: { ink: string; string: string; keyword: string; muted: string; comment: string },
) => ({
  name,
  type,
  colors: { "editor.foreground": colors.ink, "editor.background": "#00000000" },
  tokenColors: [
    { settings: { foreground: colors.ink } },
    { scope: ["comment", "punctuation.definition.comment"], settings: { foreground: colors.comment } },
    {
      scope: ["string", "string.quoted", "string.template", "punctuation.definition.string", "constant.numeric", "constant.language"],
      settings: { foreground: colors.string },
    },
    {
      scope: ["keyword", "storage", "storage.type", "storage.modifier", "keyword.control", "keyword.control.import", "keyword.control.export", "keyword.control.from", "keyword.control.flow"],
      settings: { foreground: colors.keyword },
    },
    {
      scope: ["punctuation", "meta.brace", "keyword.operator", "meta.delimiter", "punctuation.accessor", "punctuation.separator", "punctuation.terminator"],
      settings: { foreground: colors.muted },
    },
  ],
});

export const landingCodeThemes: CodeThemes = {
  light: theme("sms-landing-light", "light", {
    ink: "#1d2738",
    string: "#36578a",
    keyword: "#94512e",
    muted: "#6a7385",
    comment: "#6d7686",
  }),
  dark: theme("sms-landing-dark", "dark", {
    ink: "#e4e8ef",
    string: "#a3badf",
    keyword: "#ddaa6c",
    muted: "#8f98a9",
    comment: "#8f98a9",
  }),
};
