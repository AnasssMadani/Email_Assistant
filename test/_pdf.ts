/** PDF minimal (une page de texte, ou aucune ligne = page vide comme un scan) pour les tests de lecture des pieces jointes. */
export function makePdf(lines: string[], paddingBytes = 0): Buffer {
  const stream = lines.length
    ? `BT /F1 12 Tf 50 750 Td ${lines.map((l, i) => `${i ? "0 -16 Td " : ""}(${l.replace(/[()\\]/g, "")}) Tj`).join(" ")} ET`
    : "";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  if (paddingBytes > 0) objects.push(`<< /Length ${paddingBytes} >>\nstream\n${"A".repeat(paddingBytes)}\nendstream`);
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) out += `${String(o).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
