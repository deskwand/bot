import { describe, expect, it } from "vitest";
import { toWeChatText } from "../../../src/channels/wechat/markdown";

describe("toWeChatText", () => {
  it("keeps everything the wechat client renders", () => {
    const markdown = [
      "## 小结",
      "",
      "**粗体** 与 `npm test`",
      "",
      "```js",
      "const a = 1;",
      "```",
      "",
      "| 名称 | 值 |",
      "| --- | --- |",
      "| 甲 | 1 |",
      "",
      "---",
    ].join("\n");

    expect(toWeChatText(markdown)).toBe(markdown);
  });

  it("strips markers from chinese italics only", () => {
    expect(toWeChatText("*中文斜体* 和 *english* 混排")).toBe(
      "中文斜体 和 *english* 混排",
    );
  });

  it("drops images entirely", () => {
    expect(toWeChatText("看图 ![截图](https://example.com/a.png) 完毕")).toBe(
      "看图  完毕",
    );
  });

  it("unwraps h5 and h6 headings", () => {
    expect(toWeChatText("##### 五级\n###### 六级\n#### 四级保留")).toBe(
      "五级\n六级\n#### 四级保留",
    );
  });

  it("matches the community filter on the canonical example", () => {
    expect(toWeChatText("**粗体** *中文斜体* ![img](url)")).toBe(
      "**粗体** 中文斜体 ",
    );
  });

  it("leaves unfinished markdown alone instead of throwing", () => {
    expect(toWeChatText("**还没写完的粗体")).toBe("**还没写完的粗体");
    expect(toWeChatText("")).toBe("");
  });

  it("keeps unsupported syntax inside inline code", () => {
    expect(toWeChatText("看 `*中文* ![图](url)` 和 `#####`")).toBe(
      "看 `*中文* ![图](url)` 和 `#####`",
    );
    expect(toWeChatText("``*中文* ` x`` 保留")).toBe("``*中文* ` x`` 保留");
  });

  it("keeps fences of any char and length, including inner shorter fences", () => {
    const markdown = [
      "````md",
      "```",
      "*中文* ![图](url) #####",
      "```",
      "````",
      "",
      "~~~",
      "###### 六级",
      "*中文*",
      "~~~",
    ].join("\n");

    expect(toWeChatText(markdown)).toBe(markdown);
  });

  it("keeps an unfinished fence verbatim to the end", () => {
    const markdown = "```js\nconst a = '*中文*';\n![图](url)\n##### 五级";

    expect(toWeChatText(markdown)).toBe(markdown);
  });

  it("keeps indented code lines verbatim", () => {
    const markdown = "    *中文* ![图](url)\n\t##### 五级\n    继续";

    expect(toWeChatText(markdown)).toBe(markdown);
  });

  it("keeps escaped markers literal and honours backslash parity", () => {
    expect(toWeChatText("\\*中文\\* 和 \\![图](url)")).toBe(
      "\\*中文\\* 和 \\![图](url)",
    );
    expect(toWeChatText("\\\\*中文*")).toBe("\\\\中文");
  });

  it("keeps the newline after a bare h5 marker", () => {
    expect(toWeChatText("#####\n正文")).toBe("\n正文");
  });

  it("handles heading whitespace, crlf and boundaries", () => {
    expect(toWeChatText("#####\t五级\r\n###### 六级\r\n   ##### 缩进")).toBe(
      "五级\r\n六级\r\n缩进",
    );
    expect(toWeChatText("####### 七级\n#### 四级")).toBe(
      "####### 七级\n#### 四级",
    );
    expect(toWeChatText("    ##### 缩进代码")).toBe("    ##### 缩进代码");
    expect(toWeChatText("#####五级")).toBe("#####五级");
  });

  it("removes images with balanced urls, titles or bracketed alt text", () => {
    expect(toWeChatText("a ![图](https://example.com/a_(b).png) b")).toBe(
      "a  b",
    );
    expect(
      toWeChatText('a ![图](https://example.com/a.png "标题(1)") b'),
    ).toBe("a  b");
    expect(toWeChatText("a ![图 [x]](https://example.com/a.png) b")).toBe(
      "a  b",
    );
  });

  it("keeps incomplete image syntax literal", () => {
    expect(toWeChatText("![图](https://example.com/a.png")).toBe(
      "![图](https://example.com/a.png",
    );
    expect(toWeChatText("![图](url")).toBe("![图](url");
    expect(toWeChatText("![图] (url)")).toBe("![图] (url)");
  });
});
