const CHUNK_SIZE = 2000;
const CHUNK_OVERLAP = 200;

export function sectionChunker(extracted) {
  if (!extracted || !extracted.sections) {
    return { sections: [], chunks: [] };
  }

  const sections = extracted.sections.map((s, i) => ({
    index: i,
    heading: s.heading || `Section ${i + 1}`,
    text: s.text || '',
    subsections: s.subsections || [],
    wordCount: (s.text || '').split(/\s+/).filter(Boolean).length,
    charCount: (s.text || '').length
  }));

  const chunks = [];
  let chunkIndex = 0;

  const allText = sections.map(s => `## ${s.heading}\n\n${s.text}`).join('\n\n');
  const words = allText.split(/\s+/).filter(Boolean);

  if (words.length <= CHUNK_SIZE) {
    chunks.push({
      index: 0,
      text: allText,
      wordCount: words.length,
      sectionRefs: sections.map(s => s.index)
    });
  } else {
    let start = 0;
    while (start < words.length) {
      const end = Math.min(start + CHUNK_SIZE, words.length);
      const chunkWords = words.slice(start, end);
      const chunkText = chunkWords.join(' ');

      const chunkSections = [];
      let charPos = 0;
      for (const s of sections) {
        const sectionLen = s.text.length;
        const chunkStart = Math.max(0, start * 5 - charPos);
        const chunkEnd = end * 5 - charPos;
        if (chunkStart < sectionLen && chunkEnd > 0) {
          chunkSections.push(s.index);
        }
        charPos += sectionLen;
      }

      chunks.push({
        index: chunkIndex++,
        text: chunkText,
        wordCount: chunkWords.length,
        sectionRefs: [...new Set(chunkSections)]
      });

      start += CHUNK_SIZE - CHUNK_OVERLAP;
    }
  }

  return { sections, chunks };
}

export function splitTextIntoSections(text) {
  const lines = text.split('\n');
  const sections = [];
  let currentHeading = 'Full Text';
  let currentText = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headingMatch) {
      if (currentText.length > 0) {
        sections.push({
          heading: currentHeading,
          text: currentText.join('\n').trim()
        });
      }
      currentHeading = headingMatch[2].trim();
      currentText = [];
    } else {
      currentText.push(line);
    }
  }

  if (currentText.length > 0) {
    sections.push({
      heading: currentHeading,
      text: currentText.join('\n').trim()
    });
  }

  if (sections.length <= 1 && text.includes('\n\n')) {
    const paragraphs = text.split('\n\n').filter(Boolean);
    return paragraphs.map((p, i) => ({
      heading: `Paragraph ${i + 1}`,
      text: p.trim()
    }));
  }

  return sections;
}
