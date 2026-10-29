export type Part = { name: string; filename?: string; contentType?: string; data: string | Uint8Array };

/** Builds a multipart/form-data body by hand so each part's headers match PayPal's curl examples exactly. */
export function buildMultipart(parts: Part[], boundary = `----dd${Math.random().toString(16).slice(2)}${Date.now().toString(16)}`) {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`;
    if (p.filename) head += `; filename="${p.filename}"`;
    head += '\r\n';
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`;
    head += '\r\n';
    chunks.push(enc.encode(head));
    chunks.push(typeof p.data === 'string' ? enc.encode(p.data) : p.data);
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) { body.set(c, off); off += c.length; }
  return { body, contentType: `multipart/form-data; boundary=${boundary}` };
}
