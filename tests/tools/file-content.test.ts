import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { describe, expect, it } from "vitest";
import {
  classifyFile,
  documentConverterFromAi,
  renderFile,
} from "../../src/tools/file-content";
import { PNG_B64, bytes } from "../helpers/images";

function textOf(result: ToolExecutionResult): string {
  return (result.output ?? [])
    .map((item) => (item.type === "text" ? item.text : ""))
    .join("");
}

describe("classifyFile", () => {
  it("sniffs a PNG regardless of the declared type", () => {
    expect(classifyFile(bytes(PNG_B64), "application/octet-stream", "x.bin"))
      .toEqual({ kind: "image", mimeType: "image/png" });
  });
  it("classifies an octet-stream file starting with %PDF- as a document", () => {
    const pdf = new TextEncoder().encode("%PDF-1.7\n...");
    expect(classifyFile(pdf, "application/octet-stream", "download"))
      .toEqual({ kind: "document", mimeType: "application/pdf" });
  });
  it("falls back to the extension", () => {
    expect(classifyFile(undefined, "application/octet-stream", "表.xlsx").kind).toBe("document");
    expect(classifyFile(undefined, "", "a.PPTX").kind).toBe("document");
  });
  it("keeps text, CSV and HTML as other", () => {
    for (const type of ["text/plain", "text/csv", "text/html; charset=utf-8", "application/json"]) {
      expect(classifyFile(undefined, type, "x").kind).toBe("other");
    }
  });
  it("trusts a declared image type before bytes are read", () => {
    expect(classifyFile(undefined, "image/jpeg", "a").kind).toBe("image");
  });
});

describe("documentConverterFromAi", () => {
  it("is undefined without toMarkdown", () => {
    expect(documentConverterFromAi(undefined)).toBeUndefined();
    expect(documentConverterFromAi({} as Ai)).toBeUndefined();
  });
  it("maps markdown and error responses", async () => {
    const ok = documentConverterFromAi({ toMarkdown: async () =>
      ({ id: "1", name: "a.pdf", mimeType: "application/pdf", format: "markdown", tokens: 3, data: "# 标题" }) } as unknown as Ai)!;
    expect(await ok({ name: "a.pdf", blob: new Blob(["x"]) })).toEqual({ ok: true, markdown: "# 标题" });
    const bad = documentConverterFromAi({ toMarkdown: async () =>
      ({ id: "1", name: "a.pdf", mimeType: "application/pdf", format: "error", error: "too large" }) } as unknown as Ai)!;
    expect(await bad({ name: "a.pdf", blob: new Blob(["x"]) })).toEqual({ ok: false, error: "too large" });
  });
});

describe("renderFile", () => {
  const header = "application/pdf · 3 字节\n\n";
  it("returns converted markdown after the header", async () => {
    const result = await renderFile(
      { bytes: new Uint8Array([1, 2, 3]), name: "a.pdf", mimeType: "application/pdf", kind: "document", header },
      { convert: async () => ({ ok: true, markdown: "# 正文" }), acceptsImages: async () => true },
    );
    expect(textOf(result)).toBe(header + "# 正文");
    expect(result.isError).toBeFalsy();
  });
  it("reports a missing converter as an error", async () => {
    const result = await renderFile(
      { bytes: new Uint8Array([1]), name: "a.pdf", mimeType: "application/pdf", kind: "document", header },
      { convert: undefined, acceptsImages: async () => true },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("不支持文档转换");
  });
  it("reports a conversion failure with its reason", async () => {
    const result = await renderFile(
      { bytes: new Uint8Array([1]), name: "a.pdf", mimeType: "application/pdf", kind: "document", header },
      { convert: async () => ({ ok: false, error: "too large" }), acceptsImages: async () => true },
    );
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("too large");
  });
  it("returns an image block for a vision model", async () => {
    const result = await renderFile(
      { bytes: bytes(PNG_B64), name: "a.png", mimeType: "image/png", kind: "image", header: "image/png · 1 字节\n\n" },
      { convert: undefined, acceptsImages: async () => true },
    );
    expect(result.output?.some((item) => item.type === "image")).toBe(true);
  });
  it("returns a notice instead of an image for a text-only model", async () => {
    const result = await renderFile(
      { bytes: bytes(PNG_B64), name: "a.png", mimeType: "image/png", kind: "image", header: "" },
      { convert: undefined, acceptsImages: async () => false },
    );
    expect(result.output?.some((item) => item.type === "image")).toBe(false);
    expect(textOf(result)).toContain("不支持图片");
  });
  it("reports an undecodable image as an error result", async () => {
    const broken = bytes(PNG_B64).slice(0, 40);
    const result = await renderFile(
      { bytes: broken, name: "a.png", mimeType: "image/png", kind: "image", header: "" },
      { convert: undefined, acceptsImages: async () => true },
    );
    expect(result.isError).toBe(true);
  });
});
