import { defineMeta } from "blume";

export default defineMeta({
  title: "Sending",
  icon: "send",
  order: 2,
  pages: ["send-a-message", "fallback-and-retries", "idempotency", "length-and-cost"],
});
