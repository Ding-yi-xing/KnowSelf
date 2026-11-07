import type { Protocol, ChatOptions, ChatChunk } from "@knowself/contracts";
import type { SseEvent } from "../stream";

export interface IAdapter {
  readonly protocol: Protocol;
  encodeRequest(opts: ChatOptions): { url: string; init: RequestInit };
  decodeStream(events: AsyncIterable<SseEvent>): AsyncIterable<ChatChunk>;
}
