import { defineMeta } from "blume";

export default defineMeta({
  title: "Reference",
  icon: "code",
  order: 7,
  display: "group",
  collapsed: true,
  pages: ["create-sms-client", "send", "validate", "errors", "webhook-events", "testing", "idempotency-store", "adapter-contract", "doctor-cli", "changelog"],
});
