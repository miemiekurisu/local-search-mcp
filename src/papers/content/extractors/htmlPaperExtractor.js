import * as cheerio from 'cheerio';

export function extractHtmlPaper(html, sourceUrl) {
  const $ = cheerio.load(html);

  $('script, style, nav, footer, header, aside, .sidebar, .menu, .advertisement, noscript').remove();

  const title = $('h1').first().text().trim()
    || $('title').text().trim()
    || $('meta[name="citation_title"]').attr('content')
    || '';

  const abstract = $('meta[name="description"]').attr('content')
    || $('meta[name="citation_abstract"]').attr('content')
    || $('.abstract, #abstract, [class*=abstract]').first().text().trim()
    || '';

  const authors = ($('meta[name="citation_author"]').map((i, el) => $(el).attr('content')).get())
    || ($('meta[name="author"]').attr('content') || '').split(',').map(s => s.trim()).filter(Boolean)
    || [];

  const doi = $('meta[name="citation_doi"]').attr('content') || '';

  const sections = [];
  const sectionHeadings = $('h2, h3, h4, [class*=section-title], [class*=heading]');

  if (sectionHeadings.length > 0) {
    sectionHeadings.each((i, el) => {
      const heading = $(el).text().trim();
      if (!heading) return;

      let content = [];
      let sibling = $(el).next();

      while (sibling.length > 0 && !sibling.is('h2, h3, h4')) {
        const text = sibling.text().trim();
        if (text) content.push(text);
        sibling = sibling.next();
      }

      sections.push({
        heading,
        text: content.join('\n'),
        level: el.tagName === 'h2' ? 2 : el.tagName === 'h3' ? 3 : 4
      });
    });
  }

  const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
  const bodyHtml = $('article, [role=main], .content, #content, .main-content, body').html() || '';

  return {
    title,
    abstract,
    authors,
    doi,
    sections: sections.length > 0 ? sections : [{ heading: 'Full Text', text: bodyText.slice(0, 50000), level: 1 }],
    fullText: bodyText,
    wordCount: bodyText.split(/\s+/).filter(Boolean).length,
    sourceUrl,
    format: 'html'
  };
}

export function canExtract(variant) {
  return variant === 'raw/html';
}
