import { fetch } from 'undici';

const ARXIV_PATTERN = /^(\d{4}\.\d{4,5})(v\d+)?$/;

export class PaperContentLocator {
  constructor(paperKernel) {
    this.paperKernel = paperKernel;
  }

  async locate(identifier, identifierType) {
    const candidates = [];

    const doi = identifierType === 'doi' ? identifier : null;
    const arxivId = identifierType === 'arxiv' ? identifier : (ARXIV_PATTERN.test(identifier) ? identifier.match(ARXIV_PATTERN)[1] : null);

    if (arxivId) {
      candidates.push({
        url: `https://arxiv.org/pdf/${arxivId}.pdf`,
        source: 'arxiv',
        format: 'raw/pdf',
        confidence: 1.0,
        isOpenAccess: true,
        license: 'arXiv non-exclusive'
      });

      candidates.push({
        url: `https://arxiv.org/abs/${arxivId}`,
        source: 'arxiv_html',
        format: 'raw/html',
        confidence: 0.9,
        isOpenAccess: true,
        license: 'arXiv non-exclusive'
      });
    }

    if (doi) {
      if (this.paperKernel && this.paperKernel.findOpenAccess) {
        try {
          const oaResult = await this.paperKernel.findOpenAccess({ identifier: doi });
          if (oaResult && oaResult.is_open_access) {
            if (oaResult.best_pdf_url) {
              candidates.push({
                url: oaResult.best_pdf_url,
                source: 'unpaywall',
                format: 'raw/pdf',
                confidence: 0.9,
                isOpenAccess: true,
                license: oaResult.license || null
              });
            }
            if (oaResult.best_landing_page_url && !oaResult.best_pdf_url) {
              candidates.push({
                url: oaResult.best_landing_page_url,
                source: 'unpaywall_landing',
                format: 'raw/html',
                confidence: 0.7,
                isOpenAccess: true,
                license: oaResult.license || null
              });
            }
          }
        } catch (err) {
          console.warn(`[content-locator] unpaywall lookup failed for ${doi}: ${err.message}`);
        }
      }

      candidates.push({
        url: `https://doi.org/${doi}`,
        source: 'doi_resolver',
        format: 'raw/html',
        confidence: 0.5,
        isOpenAccess: false
      });
    }

    if (arxivId) {
      try {
        const ssUrl = `https://api.semanticscholar.org/graph/v1/paper/ArXiv:${arxivId}?fields=openAccessPdf,isOpenAccess`;
        const res = await fetch(ssUrl);
        if (res.ok) {
          const data = await res.json();
          if (data.openAccessPdf?.url) {
            candidates.push({
              url: data.openAccessPdf.url,
              source: 'semantic_scholar',
              format: 'raw/pdf',
              confidence: 0.85,
              isOpenAccess: true
            });
          }
        }
      } catch (err) {
        console.warn(`[content-locator] semantic scholar lookup failed for arxiv ${arxivId}: ${err.message}`);
      }
    }

    candidates.sort((a, b) => {
      const priority = { 'arxiv': 0, 'arxiv_html': 1, 'semantic_scholar': 2, 'unpaywall': 3, 'unpaywall_landing': 4, 'doi_resolver': 5 };
      return (priority[a.source] ?? 99) - (priority[b.source] ?? 99);
    });

    return candidates;
  }
}
