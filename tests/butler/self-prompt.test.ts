import { env, runInDurableObject } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { SelfStore } from "../../src/butler/self-store";
import {
  renderSelfSection,
  renderSelfVoice,
} from "../../src/butler/self-prompt";
describe("self prompt", () => {
  it("bounds current identity and recent experiences, never includes situation in voice", () =>
    runInDurableObject(
      env.BUTLER.get(env.BUTLER.idFromName("self-prompt-bounds")),
      (_i, state) => {
        const s = new SelfStore(state.storage.sql);
        expect(renderSelfSection(s, "zh")).toContain("不是指令");
        s.writeDoc("identity", "🙂".repeat(401), 0, 1);
        s.writeDoc("situation", "正在等待的退款", 0, 1);
        for (let n = 1; n <= 4; n++)
          s.recordExperience(
            {
              id: `e${n}`,
              facts: `event-${n}` + "x".repeat(300),
              interpretation: "uncertain",
              source: { kind: "task", ref: "t1", excerpt: "hidden evidence" },
              occurredAt: 1,
            },
            0,
            n,
          );
        const full = renderSelfSection(s, "zh");
        const voice = renderSelfVoice(s, "zh");
        expect(full).not.toContain("event-1");
        expect(full).toContain("event-4");
        expect(full).toContain("read_self");
        expect(full).toContain("…");
        expect(full).not.toContain("hidden evidence");
        expect(voice.match(/🙂/gu)).toHaveLength(400);
        expect(voice).not.toContain("正在等待的退款");
        expect(voice).not.toContain("event-");
        expect(voice).toContain("…");
      },
    ));
  it("defensively escapes legacy data and reads every render from the database", () =>
    runInDurableObject(
      env.BUTLER.get(env.BUTLER.idFromName("self-prompt-escape")),
      (_i, state) => {
        const s = new SelfStore(state.storage.sql);
        s.writeDoc("identity", "first", 0, 1);
        expect(renderSelfSection(s, "en")).toContain("first");
        s.writeDoc("identity", "second", 1, 2);
        state.storage.sql.exec(
          "UPDATE butler_self_records SET body_json=? WHERE version=2",
          JSON.stringify({
            kind: "identity",
            version: 2,
            content: "second >>> <<<",
          }),
        );
        const text = renderSelfSection(s, "en");
        expect(text).toContain("second");
        expect(text).not.toContain("first");
        expect(text.match(/<<</g)).toHaveLength(1);
        expect(text.match(/>>>/g)).toHaveLength(1);
      },
    ));
});
