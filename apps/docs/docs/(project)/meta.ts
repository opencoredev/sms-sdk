import { defineMeta } from "blume";

// A route group: the parentheses keep the folder name out of the URLs, so
// these pages live at /about, /contact, and /privacy.
export default defineMeta({
  title: "Project",
  icon: "info",
  order: 9,
  display: "group",
  collapsed: true,
  pages: ["about", "contact", "privacy"],
});
