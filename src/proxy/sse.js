/** Incremental Server-Sent Events parser (handles CRLF, multi-line data, comments, split chunks). */
export class SSEParser {
  constructor() {
    this.decoder = new TextDecoder();
    this.buf = '';
    this.pendingCR = false;
  }

  feed(chunk) {
    let text = typeof chunk === 'string' ? chunk : this.decoder.decode(chunk, { stream: true });
    if (this.pendingCR) {
      text = '\r' + text;
      this.pendingCR = false;
    }
    if (text.endsWith('\r')) {
      this.pendingCR = true;
      text = text.slice(0, -1);
    }
    this.buf += text.replace(/\r\n?/g, '\n');
    const events = [];
    let idx;
    while ((idx = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 2);
      const ev = parseBlock(block);
      if (ev) events.push(ev);
    }
    return events;
  }

  flush() {
    const tail = this.buf + (this.pendingCR ? '\n' : '');
    this.buf = '';
    this.pendingCR = false;
    const ev = parseBlock(tail.replace(/\r\n?/g, '\n'));
    return ev ? [ev] : [];
  }
}

function parseBlock(block) {
  let event;
  const data = [];
  for (const line of block.split('\n')) {
    if (!line || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i === -1 ? line : line.slice(0, i);
    let value = i === -1 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (!data.length && !event) return null;
  return { event, data: data.length ? data.join('\n') : undefined };
}

export function startSSE(res) {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

/** Writes to the client unless it already went away. */
export function safeWrite(res, data) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(data);
    return true;
  } catch {
    return false;
  }
}

export function safeEnd(res) {
  if (res.writableEnded || res.destroyed) return;
  try {
    res.end();
  } catch {}
}
