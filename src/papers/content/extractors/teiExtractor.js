import * as cheerio from 'cheerio';

export function extractTei(teiXml, sourceUrl) {
  const $ = cheerio.load(teiXml, { xmlMode: true });

  const title = $('titleStmt title').first().text().trim()
    || $('title').first().text().trim()
    || '';

  const authors = [];
  $('author, respStmt[name][role="author"]').each((i, el) => {
    const name = $(el).find('persName, name').first().text().trim() || $(el).text().trim();
    if (name) authors.push(name);
  });

  const abstract = $('abstract p').first().text().trim()
    || $('abstract').first().text().trim()
    || '';

  const doi = $('idno[type="DOI"]').first().text().trim()
    || $('publicationStmt idno').first().text().trim()
    || '';

  const sections = [];
  $('div[type="section"], div[type="chapter"], div').each((i, el) => {
    const heading = $(el).find('head').first().text().trim() || '';
    const paragraphs = [];
    $(el).find('p').each((pi, pel) => {
      const text = $(pel).text().trim();
      if (text) paragraphs.push(text);
    });

    if (heading || paragraphs.length > 0) {
      sections.push({ heading, text: paragraphs.join('\n') });
    }
  });

  const bodyText = $('text body').text().replace(/\s+/g, ' ').trim()
    || $('body').text().replace(/\s+/g, ' ').trim();

  return {
    title,
    abstract,
    authors,
    doi,
    sections,
    fullText: bodyText,
    wordCount: bodyText.split(/\s+/).filter(Boolean).length,
    sourceUrl,
    format: 'tei-xml'
  };
}

export function canExtract(variant) {
  return variant === 'raw/tei';
}
