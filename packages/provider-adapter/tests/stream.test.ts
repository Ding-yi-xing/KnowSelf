import { describe, it, expect } from "vitest";
import { parseSseStream } from "../dist/stream.js";

function makeReadableStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
      }
      controller.close();
    },
  });
}

describe("parseSseStream", () => {
  it("parses simple data events", async () => {
    const stream = makeReadableStream(['data: {"text":"hello"}\n\n', 'data: {"text":"world"}\n\n']);
    const reader = stream.getReader();
    const events: unknown[] = [];
    for await (const evt of parseSseStream(reader)) {
      events.push(evt);
    }
    expect(events).toHaveLength(2);
    expect(events[0]).toHaveProperty("data", '{"text":"hello"}');
  });

  it("skips comment lines", async () => {
    const stream = makeReadableStream([": ping\n\n", "data: real\n\n"]);
    const reader = stream.getReader();
    const events: unknown[] = [];
    for await (const evt of parseSseStream(reader)) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
  });

  it("parses events with event type", async () => {
    const stream = makeReadableStream(['event: message_start\ndata: {"id":"1"}\n\n']);
    const reader = stream.getReader();
    const events: unknown[] = [];
    for await (const evt of parseSseStream(reader)) {
      events.push(evt);
    }
    expect(events[0]).toMatchObject({
      event: "message_start",
      data: '{"id":"1"}',
    });
  });

  it("handles multi-chunk events", async () => {
    const stream = makeReadableStream(["da", 'ta: {"partial":', "true}\n\n"]);
    const reader = stream.getReader();
    const events: unknown[] = [];
    for await (const evt of parseSseStream(reader)) {
      events.push(evt);
    }
    expect(events).toHaveLength(1);
    expect(events[0]).toHaveProperty("data", '{"partial":true}');
  });
});
