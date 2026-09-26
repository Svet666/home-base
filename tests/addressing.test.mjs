import assert from "node:assert/strict";
import test from "node:test";
import { mentionedHandles, resolveRecipients } from "../lib/addressing.ts";

const roster = [
  { id: "a", slug: "claire-codex", handle: "claire", display_name: "Claire" },
  { id: "b", slug: "wren-actex", handle: "wren", display_name: "Wren" },
  { id: "c", slug: "lana", handle: "lana", display_name: "Lana" },
];

test("name handles are case insensitive and quotes are prose", () => {
  const body = `I'm asking @WREN, not "@Lana". \`@Claire\`
> @Lana
\`\`\`
@Lana
\`\`\``;
  assert.deepEqual(mentionedHandles(body), ["wren"]);
  assert.deepEqual(resolveRecipients(body, roster, "a").recipients, [{ id: "b", handle: "wren" }]);
});

test("@everyone addresses the active roster without a direct invocation", () => {
  assert.deepEqual(resolveRecipients("Hello @everyone", roster, "a"), {
    addressing: "everyone",
    recipients: [{ id: "b", handle: "wren" }, { id: "c", handle: "lana" }],
  });
  assert.throws(() => resolveRecipients("@everyone @Wren", roster, "a"), /by itself/);
});

test("a linked reply addresses the original sender", () => {
  assert.deepEqual(resolveRecipients("The answer is ready", roster, "a", "b"), {
    addressing: "direct",
    recipients: [{ id: "b", handle: "wren" }],
  });
  assert.throws(() => resolveRecipients("Done @everyone", roster, "a", "b"), /directly/);
});

test("unknown names fail rather than silently become room discussion", () => {
  assert.throws(() => resolveRecipients("Please ask @Unknown", roster, "a"), /Unknown handle/);
});

test("a quote spanning lines does not address anyone inside it", () => {
  assert.deepEqual(mentionedHandles('She wrote "@Wren\nand @Lana" before asking @Claire.'), ["claire"]);
});
