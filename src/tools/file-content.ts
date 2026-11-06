import type { Context } from "@earendil-works/chord";
import type { ToolExecutionApi, ToolExecutionResult } from "@earendil-works/pi-durable";
import { prepareInboundImage, sniffImageType } from "../channels/media";
import { modelAcceptsImages } from "../llm/models";
import { truncate } from "./http-body";

/** Converts a PDF or Office document to markdown; undefined when the runtime has no converter. */
export type DocumentConverter = (doc: { name: string; blob: Blob }) =>
  Promise<{ ok: true; markdown: string } | { ok: false; error: string }>;

export type FileKind = "image" | "document" | "other";

/** Everything Cloudflare's `toMarkdown` can read. `text/*` stays raw and images never go here. */
const DOCUMENT_MIME_TYPES = new Set([
  "application/pdf",
  "application/msword",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
]);

/** The declared type is often octet-stream, so the extension still identifies the document. */
const DOCUMENT_EXTENSION_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
};

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // "%PDF-"

function normalizeType(contentType: string): string {
  return contentType.split(";")[0]!.trim().toLowerCase();
}

function looksLikePdf(bytes: Uint8Array): boolean {
  return bytes.length >= PDF_MAGIC.length && PDF_MAGIC.every((byte, i) => bytes[i] === byte);
}

function extensionOf(name: string): string | undefined {
  return /\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
}

/**
 * Decide what a downloaded or uploaded file is. `bytes` is optional: without
 * it the declared type and extension still decide whether the caller should
 * read the whole file. Image extensions never count — an unread file cannot
 * prove it is a decodable image.
 */
export function classifyFile(
  bytes: Uint8Array | undefined,
  contentType: string,
  name: string,
): { kind: FileKind; mimeType: string } {
  const declared = normalizeType(contentType);

  if (bytes) {
    const sniffed = sniffImageType(bytes);
    if (sniffed) return { kind: "image", mimeType: sniffed };
    if (looksLikePdf(bytes)) return { kind: "document", mimeType: "application/pdf" };
  }

  if (declared.startsWith("image/")) return { kind: "image", mimeType: declared };
  if (DOCUMENT_MIME_TYPES.has(declared)) return { kind: "document", mimeType: declared };

  const extension = extensionOf(name);
  const fromExtension = extension === undefined ? undefined : DOCUMENT_EXTENSION_TYPES[extension];
  if (fromExtension) return { kind: "document", mimeType: fromExtension };

  return { kind: "other", mimeType: declared || "application/octet-stream" };
}

/** Adapt the Workers AI binding's `toMarkdown` to the converter seam; never throws. */
export function documentConverterFromAi(ai: Ai | undefined): DocumentConverter | undefined {
  if (typeof ai?.toMarkdown !== "function") return undefined;

  return async ({ name, blob }) => {
    try {
      const response = await ai.toMarkdown({ name, blob });
      if (response.format === "error") return { ok: false, error: response.error };
      return { ok: true, markdown: response.data };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };
}

/**
 * Whether the conversation's current model takes images. Without a resolved
 * model the answer is yes, matching pi's `read` tool: the request will fail
 * with a clearer error than a silently skipped image.
 */
export async function callAcceptsImages(
  api: ToolExecutionApi,
  context: Context,
): Promise<boolean> {
  const ref = (await api.agent(context)).model;
  if (!ref) return true;
  return modelAcceptsImages(api.models, { provider: ref.provider, id: ref.modelId });
}

/** Turn file bytes into the model-facing output: markdown for documents, an image block for vision models. */
export async function renderFile(
  input: {
    bytes: Uint8Array;
    name: string;
    mimeType: string;
    kind: "image" | "document";
    header: string;
  },
  deps: { convert: DocumentConverter | undefined; acceptsImages: () => Promise<boolean> },
): Promise<ToolExecutionResult> {
  if (input.kind === "document") {
    if (!deps.convert) {
      return {
        output: [
          { type: "text", text: `当前环境不支持文档转换（PDF / Office），无法读取 ${input.name}` },
        ],
        isError: true,
      };
    }
    const converted = await deps.convert({
      name: input.name,
      blob: new Blob([input.bytes]),
    });
    if (!converted.ok) {
      return {
        output: [{ type: "text", text: `文档转换失败：${converted.error}` }],
        isError: true,
      };
    }
    return { output: [{ type: "text", text: input.header + truncate(converted.markdown) }] };
  }

  // Ask before decoding: a text-only model should not pay for a resize it cannot use.
  if (!(await deps.acceptsImages())) {
    return {
      output: [{ type: "text", text: `当前模型不支持图片，无法查看 ${input.name}` }],
    };
  }

  const outcome = await prepareInboundImage(input.bytes);
  if (!outcome.ok) {
    return {
      output: [
        { type: "text", text: `图片无法处理（${outcome.reason}）：${input.name}` },
      ],
      isError: true,
    };
  }

  return {
    output: [
      { type: "text", text: input.header.trim() },
      { type: "image", data: outcome.image.data, mimeType: outcome.image.mimeType },
    ],
  };
}
