/** SSE parser tolerant of CRLF, multi-line data and chunk boundaries inside lines. */
export interface SseEvent { event: string; data: string; id?: string }

export async function* parseSse(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let event = "message";
  let data: string[] = [];
  let id: string | undefined;
  const onAbort = () => reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort, { once: true });
  const line = (raw: string): boolean => {
    const l = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (l === "") return true;
    if (l.startsWith(":")) return false;
    const c = l.indexOf(":");
    const field = c < 0 ? l : l.slice(0, c);
    let v = c < 0 ? "" : l.slice(c + 1);
    if (v.startsWith(" ")) v = v.slice(1);
    if (field === "data") data.push(v);
    else if (field === "event") event = v;
    else if (field === "id") id = v;
    return false;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const l = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (line(l)) {
          if (data.length) yield { event, data: data.join("\n"), id };
          event = "message"; data = []; id = undefined;
        }
      }
    }
    if (buf) line(buf);
    if (data.length) yield { event, data: data.join("\n"), id };
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}
