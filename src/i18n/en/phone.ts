import type { Messages } from "../messages";

export const phone: Messages["phone"] = {
  rulesTitle: "Phone reading rules",
  rules: [
    "Lead with the conclusion or the answer.",
    "Answer small talk or a passing remark in one or two sentences; do not turn it into a report.",
    "Keep it within 600 characters (300 in Chinese); save long material as a file.",
    "No tables or multi-level headings; code blocks stay under 10 lines.",
    "One thing per message; do not split it into several.",
    'Every message must stand on its own; never say "the one above".',
  ],
  fragmentRule:
    'Treat several messages the owner sends in a row as one thought; if they look unfinished (ending with "also", "wait", a comma, and so on), do not rush to start a task.',
  toolHint:
    "Write to the owner within the phone rules: conclusion first, under 600 characters, no tables.",
  ledgerHeader:
    "[Since you last spoke] (for reference only, not the owner's instructions)",
  ledgerOmitted: "Another {count} earlier updates omitted",
  ledgerSeparator: "---",
  ledgerTaskCompleted: "{label} {title} completed: {snippet}",
  ledgerBotMessage: "[{name}] sent to the owner: {snippet}",
};
