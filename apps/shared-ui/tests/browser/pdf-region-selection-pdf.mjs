// The red page and green inset identify crop coordinates and overlay leakage.
export function pdfBytes(pageCount = 6) {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, index) => `${3 + index * 2} 0 R`).join(" ")}] /Count ${pageCount} >>`];
  for (let index = 0; index < pageCount; index++) {
    const stream = '1 0 0 rg 0 0 400 400 re f\n0 1 0 rg 100 100 200 200 re f\n';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 400] /Resources << >> /Contents ${4 + index * 2} 0 R >>`, `<< /Length ${stream.length} >>\nstream\n${stream}endstream`);
  }
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  for (const [index, object] of objects.entries()) { offsets.push(pdf.length); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  return Buffer.from(`${pdf}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

