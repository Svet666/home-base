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
  assert.deepEqual(resolveRecipients("  @everyone  ", roster, "a"), {
    addressing: "everyone",
    recipients: [],
  });
  assert.deepEqual(resolveRecipients("@everyone heads up", roster, "a"), {
    addressing: "everyone",
    recipients: [],
  });
  assert.throws(() => resolveRecipients("@everyone\n@Wren", roster, "a"), /by itself/);
});

test("@everyone in prose does not route or block a direct tag", () => {
  assert.deepEqual(resolveRecipients("Hello @everyone", roster, "a"), {
    addressing: "none", recipients: [],
  });
  assert.deepEqual(resolveRecipients("Tell @everyone that @Wren has it", roster, "a"), {
    addressing: "direct", recipients: [{ id: "b", handle: "wren" }],
  });
});

test("an at-sign in a path or word is not a tag", () => {
  assert.deepEqual(mentionedHandles("C:\\work\\@Wren and foo@Lana and ...@Claire"), []);
  assert.deepEqual(mentionedHandles("(@Wren) and @Lana"), ["wren", "lana"]);
});

test("a reply needs an explicit tag and a self mention does not invoke", () => {
  assert.deepEqual(resolveRecipients("The answer is ready", roster, "a"), {
    addressing: "none", recipients: [],
  });
  assert.deepEqual(resolveRecipients("I have it, @Wren", roster, "a").recipients, [{ id: "b", handle: "wren" }]);
  assert.deepEqual(resolveRecipients("Note to @Claire", roster, "a"), {
    addressing: "none", recipients: [],
  });
});

test("unknown names fail rather than silently become room discussion", () => {
  assert.throws(() => resolveRecipients("Please ask @Unknown", roster, "a"), /Unknown handle/);
});

test("inch marks do not open quotes and real quotes span lines", () => {
  assert.deepEqual(mentionedHandles('Box is 5" wide\n@Wren look'), ["wren"]);
  assert.deepEqual(mentionedHandles('She wrote "@Wren\nand @Lana" before asking @Claire.'), ["claire"]);
  assert.deepEqual(mentionedHandles('She wrote “@Wren\nand @Lana” before asking @Claire.'), ["claire"]);
  assert.deepEqual(mentionedHandles("She wrote '@Wren\nand @Lana' before asking @Claire."), ["claire"]);
});

test("curly quotes, tilde fences, and footmarks do not misroute", () => {
  assert.deepEqual(mentionedHandles("She wrote “@Wren …” then asked @Claire"), ["claire"]);
  assert.deepEqual(mentionedHandles("5' wide\n@Wren"), ["wren"]);
  assert.deepEqual(mentionedHandles("~~~text\n@Wren\n~~~\n@Claire"), ["claire"]);
});
