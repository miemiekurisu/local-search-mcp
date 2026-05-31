let pdfParse = null;

async function getPdfParse() {
  if (!pdfParse) {
    pdfParse = (await import('pdf-parse')).default;
  }
  return pdfParse;
}

export async function extractPdfText(buffer) {
  const parse = await getPdfParse();
  const data = await parse(buffer);

  return {
    text: data.text || '',
    pages: data.numpages || 0,
    metadata: {
      title: data.info?.Title || null,
      author: data.info?.Author || null,
      subject: data.info?.Subject || null,
      keywords: data.info?.Keywords || null,
      producer: data.info?.Producer || null,
      creator: data.info?.Creator || null,
      creationDate: data.info?.CreationDate || null
    },
    version: data.version || null
  };
}

export function canExtract(variant) {
  return variant === 'raw/pdf';
}
