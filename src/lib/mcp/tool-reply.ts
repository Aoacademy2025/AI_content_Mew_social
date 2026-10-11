/**
 * W4 (get_preview_frame): a tool result that is an IMAGE plus one short JSON text line, instead
 * of the usual single JSON text block. route.ts's `runTool` recognises the marker and emits
 * `[{type:"image"}, {type:"text"}]`; everything else is unchanged. The marker key is a Symbol, so
 * the audit (which only stores non-ok replies anyway) and any JSON serialisation never carry the
 * image bytes.
 */

const IMAGE_REPLY = Symbol.for("heroai.mcp.image-reply");

export type McpImageReply = {
  readonly [IMAGE_REPLY]: true;
  /** base64, no data: prefix */
  data: string;
  mimeType: string;
  body: Record<string, unknown>;
};

export function mcpImageReply(image: Buffer, mimeType: string, body: Record<string, unknown>): McpImageReply {
  return { [IMAGE_REPLY]: true, data: image.toString("base64"), mimeType, body };
}

export function isMcpImageReply(value: unknown): value is McpImageReply {
  return !!value && typeof value === "object" && (value as Record<symbol, unknown>)[IMAGE_REPLY] === true;
}

export function mcpImageReplyContent(reply: McpImageReply) {
  return {
    content: [
      { type: "image" as const, data: reply.data, mimeType: reply.mimeType },
      { type: "text" as const, text: JSON.stringify(reply.body) },
    ],
  };
}
