// Assemble renderer page PNGs into one PDF without decoding them: an 8-bit,
// non-interlaced grey or RGB PNG's IDAT stream is a valid FlateDecode stream
// with PNG predictors, so each page image is embedded byte-for-byte.
const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export function pngImage(png) {
  if (!Buffer.isBuffer(png) || png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) throw new Error('페이지 이미지가 PNG가 아닙니다.');
  let offset = 8, header = null;
  const data = [];
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset), type = png.toString('latin1', offset + 4, offset + 8);
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (body.length !== length) throw new Error('페이지 PNG가 잘렸습니다.');
    if (type === 'IHDR') header = {width: body.readUInt32BE(0), height: body.readUInt32BE(4), depth: body[8], color: body[9], interlace: body[12]};
    else if (type === 'IDAT') data.push(body);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header || !data.length) throw new Error('페이지 PNG 구조를 읽지 못했습니다.');
  const colors = {0: 1, 2: 3}[header.color];
  if (header.depth !== 8 || header.interlace !== 0 || !colors) throw new Error('PDF로 옮길 수 없는 PNG 형식입니다.');
  return {width: header.width, height: header.height, colors, data: Buffer.concat(data)};
}

// dpi is the renderer's raster resolution, so pages keep their paper size.
export function pagesToPdf(pages, {dpi = 300, title = 'HWPX'} = {}) {
  if (!pages.length) throw new Error('PDF로 만들 페이지가 없습니다.');
  const images = pages.map(pngImage);
  const chunks = [], offsets = [];
  let size = 0;
  const push = part => {const b = Buffer.isBuffer(part) ? part : Buffer.from(part, 'latin1'); chunks.push(b); size += b.length;};
  const object = (id, parts) => {offsets[id] = size; push(`${id} 0 obj\n`); for (const p of parts) push(p); push('\nendobj\n');};
  // 1 catalog, 2 pages, 3 info, then per page: page, image, content.
  const pageIds = images.map((_, i) => 4 + i * 3);
  push('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n');
  object(1, ['<< /Type /Catalog /Pages 2 0 R >>']);
  object(2, [`<< /Type /Pages /Count ${images.length} /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] >>`]);
  const utf16 = Buffer.from(`﻿${title}`, 'utf16le').swap16().toString('hex');
  object(3, [`<< /Title <${utf16}> /Producer (hwpx-plugin native preview) >>`]);
  images.forEach((image, i) => {
    const id = pageIds[i], w = image.width * 72 / dpi, h = image.height * 72 / dpi;
    const content = `q ${w.toFixed(3)} 0 0 ${h.toFixed(3)} 0 0 cm /P${i} Do Q`;
    object(id, [`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w.toFixed(3)} ${h.toFixed(3)}] /Resources << /XObject << /P${i} ${id + 1} 0 R >> >> /Contents ${id + 2} 0 R >>`]);
    object(id + 1, [`<< /Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace /${image.colors === 3 ? 'DeviceRGB' : 'DeviceGray'} /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 15 /Colors ${image.colors} /BitsPerComponent 8 /Columns ${image.width} >> /Length ${image.data.length} >>\nstream\n`, image.data, '\nendstream']);
    object(id + 2, [`<< /Length ${content.length} >>\nstream\n${content}\nendstream`]);
  });
  const count = 4 + images.length * 3, xref = size;
  push(`xref\n0 ${count}\n0000000000 65535 f \n`);
  for (let id = 1; id < count; id++) push(`${String(offsets[id]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${count} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
