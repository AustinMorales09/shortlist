import zlib from "node:zlib";

/**
 * A deliberately small PDF text reader for the no-AI fallback: it inflates content streams and reads the text
 * operators (Tj, TJ, ', "). It handles simple, text-based PDFs with standard encodings; scanned pages and
 * PDFs with custom font encodings come back empty (and are then marked "needs AI"). Not a general PDF parser.
 */
export function pdfText(buf: Buffer): string {
  const bin = buf.toString("latin1");
  if (!bin.startsWith("%PDF-")) return "";
  const lines: string[] = [];
  const streamRe = /<<([\s\S]*?)>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = streamRe.exec(bin))) {
    const dict = m[1];
    const start = m.index + m[0].length;
    const end = bin.indexOf("endstream", start);
    if (end < 0) break;
    streamRe.lastIndex = end;
    if (/\/Subtype\s*\/Image|\/FontFile|\/DCTDecode|\/CCITTFaxDecode|\/JPXDecode|\/Type\s*\/(XRef|ObjStm|Metadata)/.test(dict)) continue;
    let content: string;
    try {
      const raw = Buffer.from(bin.slice(start, end).replace(/\r?\n$/, ""), "latin1");
      content = /\/FlateDecode/.test(dict) ? zlib.inflateSync(raw).toString("latin1") : raw.toString("latin1");
    } catch {
      continue;
    }
    if (!/(Tj|TJ|'|")/.test(content) || !/BT/.test(content)) continue;
    lines.push(...readTextOps(content));
  }
  const text = lines.map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean).join("\n");
  // Custom-encoded fonts decode to noise: require mostly ordinary characters before trusting it.
  const ordinary = (text.match(/[A-Za-z0-9 .,:$\-\/#@%()\n]/g) ?? []).length;
  return text.length >= 20 && ordinary / text.length > 0.85 ? text : "";
}

function unescapeLiteral(s: string): string {
  return s.replace(/\\(\d{1,3}|[\s\S])/g, (_, c: string) =>
    /^\d/.test(c) ? String.fromCharCode(parseInt(c, 8)) : ({ n: "\n", r: "", t: " ", b: "", f: "", "\n": "", "\r": "" } as Record<string, string>)[c] ?? c);
}

function readTextOps(content: string): string[] {
  const out: string[] = [];
  let line = "";
  let pending = "";
  let nums: number[] = [];
  let inArray = false;
  const flush = () => { if (line.trim()) out.push(line); line = ""; };
  const tokenRe = /\((?:\\[\s\S]|[^\\()])*\)|<[0-9A-Fa-f\s]*>|\[|\]|-?\d*\.?\d+|[A-Za-z'"*]+/g;
  let t: RegExpExecArray | null;
  while ((t = tokenRe.exec(content))) {
    const tok = t[0];
    if (tok[0] === "(") pending += unescapeLiteral(tok.slice(1, -1));
    else if (tok[0] === "<") {
      const hex = tok.slice(1, -1).replace(/\s/g, "");
      for (let i = 0; i + 1 < hex.length; i += 2) pending += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
    } else if (tok === "[") inArray = true;
    else if (tok === "]") inArray = false;
    else if (/^-?\d*\.?\d+$/.test(tok)) {
      if (inArray && Number(tok) < -200) pending += " "; // a large negative kern is a word gap
      else nums.push(Number(tok));
    } else {
      if (tok === "Tj" || tok === "TJ") { line += pending; }
      else if (tok === "'" || tok === '"') { flush(); line += pending; }
      else if (tok === "Td" || tok === "TD") { if ((nums[nums.length - 1] ?? 0) !== 0) flush(); else line += " "; }
      else if (tok === "T*" || tok === "Tm" || tok === "ET") flush();
      pending = "";
      nums = [];
    }
  }
  flush();
  return out;
}
