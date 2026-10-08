import { defineMeta } from "blume";

export default defineMeta({
  title: "Receiving",
  icon: "inbox",
  order: 3,
  pages: ["overview", "delivery-status-webhooks", "inbound-sms", "stop-help-and-opt-outs", "webhook-security", "duplicates-and-ordering"],
});
