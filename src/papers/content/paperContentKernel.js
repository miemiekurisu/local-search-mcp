import { DocumentFetcher } from './documentFetcher.js';
import { PaperContentLocator } from './paperContentLocator.js';
import { sectionChunker, splitTextIntoSections } from './sectionChunker.js';
import { canExtract as canExtractPdf, extractPdfText } from './extractors/pdfTextExtractor.js';
import { canExtract as canExtractHtml, extractHtmlPaper } from './extractors/htmlPaperExtractor.js';
import { canExtract as canExtractXml, extractXmlPaper } from './extractors/xmlPaperExtractor.js';
import { canExtract as canExtractTei, extractTei } from './extractors/teiExtractor.js';

export class PaperContentKernel {
  constructor({ paperKernel, paperCacheStore, paperCacheCleanup } = {}) {
    this.paperKernel = paperKernel;
    this.cache = paperCacheStore || null;
    this.cleanup = paperCacheCleanup || null;
    this.fetcher = new DocumentFetcher();
    this.locator = new PaperContentLocator(paperKernel);
  }

  async locateContent(args = {}) {
    const identifier = String(args.identifier || '').trim();
    if (!identifier) throw new Error('identifier is required');

    const identifierType = args.identifier_type || this._detectType(identifier);
    const candidates = await this.locator.locate(identifier, identifierType);

    return { identifier, identifier_type: identifierType, candidates };
  }

  async fetchContent(args = {}) {
    const identifier = String(args.identifier || '').trim();
    if (!identifier) throw new Error('identifier is required');

    const identifierType = args.identifier_type || this._detectType(identifier);
    const paperKey = args.paper_key || this._deriveKey(identifier, identifierType);

    if (this.cache && this.cache.enabled) {
      const cached = this.cache.findPaper(paperKey);
      if (cached.sections && cached.sections.length > 0) {
        const entry = cached.sections[0];
        const data = this.cache.readJson(entry.id);
        if (data) {
          return {
            paper_key: paperKey,
            identifier,
            identifier_type: identifierType,
            cached: true,
            sections: data.data
          };
        }
      }
    }

    const candidates = await this.locator.locate(identifier, identifierType);
    if (candidates.length === 0) {
      return {
        paper_key: paperKey,
        identifier,
        identifier_type: identifierType,
        error: 'No open access locations found',
        candidates: []
      };
    }

    let lastError = null;
    for (const candidate of candidates) {
      try {
        const result = await this.fetcher.fetch(candidate.url, {
          expectedType: candidate.format
        });

        if (this.cache && this.cache.enabled) {
          try {
            await this.cache.storeRaw(candidate.format, candidate.url, result.buffer, {
              paper_key: paperKey,
              identifier_type: identifierType,
              identifier_value: identifier,
              source: candidate.source,
              mime_type: result.mimeType,
              open_access_status: candidate.isOpenAccess ? 'gold' : 'unknown',
              license: candidate.license || null,
              pinned: false
            });
          } catch (cacheErr) {
            console.warn(`[content-kernel] cache store failed: ${cacheErr.message}`);
          }
        }

        const extracted = await this._extract(result.buffer, result.variant, candidate.url);

        if (this.cache && this.cache.enabled) {
          try {
            this.cache.storeText(paperKey, extracted.fullText || extracted.text || '', {
              source: candidate.source,
              source_url: candidate.url,
              pinned: false
            });
          } catch (cacheErr) {
            console.warn(`[content-kernel] cache text failed: ${cacheErr.message}`);
          }
        }

        const chunked = sectionChunker(extracted);

        if (this.cache && this.cache.enabled) {
          try {
            this.cache.storeSections(paperKey, chunked.sections, { pinned: false });
            this.cache.storeChunks(paperKey, chunked.chunks, { pinned: false });
          } catch (cacheErr) {
            console.warn(`[content-kernel] cache sections/chunks failed: ${cacheErr.message}`);
          }
        }

        if (this.cleanup) {
          try {
            this.cleanup.cleanup(true);
          } catch {}
        }

        return {
          paper_key: paperKey,
          identifier,
          identifier_type: identifierType,
          cached: false,
          source: candidate.source,
          source_url: result.url,
          variant: result.variant,
          mime_type: result.mimeType,
          size_bytes: result.size,
          content_hash: result.hash,
          ...extracted,
          sections: chunked.sections,
          chunks: chunked.chunks
        };
      } catch (err) {
        lastError = err;
        console.warn(`[content-kernel] failed to fetch ${candidate.url}: ${err.message}`);
      }
    }

    return {
      paper_key: paperKey,
      identifier,
      identifier_type: identifierType,
      error: lastError ? lastError.message : 'All sources failed',
      candidates,
      lastError: lastError ? { code: lastError.code || 'FETCH_FAILED', message: lastError.message } : null
    };
  }

  async getSections(args = {}) {
    const paperKey = String(args.paper_key || '').trim();
    if (!paperKey) {
      const identifier = String(args.identifier || '').trim();
      if (!identifier) throw new Error('paper_key or identifier is required');
      return this.fetchContent({ ...args, identifier });
    }

    if (!this.cache || !this.cache.enabled) {
      throw new Error('Cache not available');
    }

    const cached = this.cache.findPaper(paperKey);
    if (!cached.sections || cached.sections.length === 0) {
      const text = cached.text && cached.text.length > 0 ? this.cache.readText(cached.text[0].id) : null;
      if (text) {
        const sections = splitTextIntoSections(text.data);
        const chunked = sectionChunker({ sections: sections.map(s => ({ heading: s.heading, text: s.text })) });
        this.cache.storeSections(paperKey, chunked.sections, { pinned: false });
        this.cache.storeChunks(paperKey, chunked.chunks, { pinned: false });
        return { paper_key: paperKey, cached: true, sections: chunked.sections, chunks: chunked.chunks };
      }
      throw new Error('No content found for this paper key');
    }

    const entry = cached.sections[0];
    const data = this.cache.readJson(entry.id);
    if (!data) throw new Error('Failed to read cached sections');

    const chunks = cached.chunks && cached.chunks.length > 0 ? this.cache.readJson(cached.chunks[0].id) : { data: [] };

    return { paper_key: paperKey, cached: true, sections: data.data, chunks: chunks.data || [] };
  }

  async _extract(buffer, variant, sourceUrl) {
    if (canExtractPdf(variant)) {
      return extractPdfText(buffer);
    }
    if (canExtractHtml(variant)) {
      return extractHtmlPaper(buffer.toString('utf8'), sourceUrl);
    }
    if (canExtractXml(variant)) {
      return extractXmlPaper(buffer.toString('utf8'), sourceUrl);
    }
    if (canExtractTei(variant)) {
      return extractTei(buffer.toString('utf8'), sourceUrl);
    }

    const text = buffer.toString('utf8');
    return {
      text,
      fullText: text,
      sections: [{ heading: 'Full Text', text: text.slice(0, 50000) }],
      wordCount: text.split(/\s+/).filter(Boolean).length,
      sourceUrl,
      format: 'unknown'
    };
  }

  _detectType(identifier) {
    if (!identifier) return null;
    const s = identifier.trim();
    if (/^10\.\d{4,}\//.test(s)) return 'doi';
    if (/^(arxiv:)?\d{4}\.\d{4,5}(v\d+)?$/i.test(s)) return 'arxiv';
    if (/^W\d{9,}$/.test(s)) return 'openalex';
    return 'doi';
  }

  _deriveKey(identifier, identifierType) {
    if (identifierType === 'arxiv') {
      const m = identifier.match(/(\d{4}\.\d{4,5})/);
      return m ? m[1] : identifier;
    }
    return identifier;
  }
}
