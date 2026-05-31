import * as cheerio from 'cheerio';

export function extractXmlPaper(xml, sourceUrl) {
  const $ = cheerio.load(xml, { xmlMode: true });

  const title = $('article-title, article-title-group article-title').first().text().trim()
    || $('title-group article-title').first().text().trim()
    || $('book-title').first().text().trim()
    || '';

  const abstract = $('abstract p').first().text().trim()
    || $('abstract').first().text().trim()
    || '';

  const authors = [];
  $('contrib[contrib-type="author"], contrib-group contrib[contrib-type="author"]').each((i, el) => {
    const given = $(el).find('given-names').text().trim();
    const surname = $(el).find('surname').text().trim();
    const name = [given, surname].filter(Boolean).join(' ');
    if (name) authors.push(name);
  });

  if (authors.length === 0) {
    $('string-name').each((i, el) => {
      const name = $(el).text().trim();
      if (name) authors.push(name);
    });
  }

  const doi = $('article-id[pub-id-type="doi"]').first().text().trim() || '';

  const sections = [];
  $('sec').each((i, el) => {
    const heading = $(el).find('title').first().text().trim() || `Section ${i + 1}`;
    const paragraphs = [];
    $(el).find('p').each((pi, pel) => {
      const text = $(pel).text().trim();
      if (text) paragraphs.push(text);
    });

    const subsections = [];
    $(el).find('sec').each((si, sel) => {
      const subHeading = $(sel).find('title').first().text().trim() || `Subsection ${si + 1}`;
      const subParagraphs = [];
      $(sel).find('p').each((pi, pel) => {
        const text = $(pel).text().trim();
        if (text) subParagraphs.push(text);
      });
      if (subHeading || subParagraphs.length > 0) {
        subsections.push({ heading: subHeading, text: subParagraphs.join('\n') });
      }
    });

    sections.push({
      heading,
      text: paragraphs.join('\n'),
      subsections: subsections.length > 0 ? subsections : undefined
    });
  });

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();

  return {
    title,
    abstract,
    authors,
    doi,
    sections,
    fullText: bodyText,
    wordCount: bodyText.split(/\s+/).filter(Boolean).length,
    sourceUrl,
    format: 'jats-xml'
  };
}

export function canExtract(variant) {
  return variant === 'raw/xml';
}
