/**
 * A minimal Server-Sent Events client.
 *
 * Bun has no `EventSource`, so we read the stream ourselves. Cequre frames
 * events as `event: <collection>:<action>` followed by `data: <record>`.
 */
export interface SseEvent {
  event: string;
  data: any;
  id?: string;
}

export function parseSseFrame(raw: string): SseEvent | null {
  let event = "message";
  let id: string | undefined;
  const dataLines: string[] = [];

  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") dataLines.push(value);
    else if (field === "id") id = value;
  }

  if (!dataLines.length && event === "message") return null;
  const payload = dataLines.join("\n");
  let data: any = payload;
  try {
    data = JSON.parse(payload);
  } catch {
    /* keep the raw string */
  }
  return { event, data, id };
}

export interface SubscribeOptions {
  token?: string;
  signal?: AbortSignal;
  onOpen?: () => void;
}

export async function* subscribeEvents(
  url: string,
  options: SubscribeOptions = {}
): AsyncGenerator<SseEvent> {
  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (options.token) headers["Authorization"] = `Bearer ${options.token}`;

  const response = await fetch(url, { headers, signal: options.signal });
  if (!response.ok || !response.body) {
    throw new Error(`SSE connect failed: HTTP ${response.status}`);
  }
  options.onOpen?.();

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, boundary).replace(/\r/g, "");
        buffer = buffer.slice(boundary + 2);
        const event = parseSseFrame(frame);
        if (event) yield event;
      }
    }
  } catch (err) {
    if (!options.signal?.aborted) throw err;
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* already closed */
    }
  }
}
