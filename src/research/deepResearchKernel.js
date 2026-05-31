import crypto from 'crypto';
import { deduplicatePapers } from '../papers/paperDeduplicator.js';
import { rankPapers } from '../papers/paperRanker.js';

export class DeepResearchKernel {
  constructor({ searchKernel, paperKernel, artifactStore, paperContentKernel } = {}) {
    this.searchKernel = searchKernel || null;
    this.paperKernel = paperKernel || null;
    this.artifactStore = artifactStore || null;
    this.paperContentKernel = paperContentKernel || null;
  }

  async researchDeep(args = {}) {
    const question = String(args.question || '').trim();
    if (!question) throw new Error('question is required');

    const domain = args.domain || 'ai_ml';
    const budget = args.budget || {};
    const maxWebQueries = Math.min(budget.web_queries || 4, 8);
    const maxPaperQueries = Math.min(budget.paper_queries || 4, 8);
    const maxWebPages = Math.min(budget.max_web_pages || 12, 30);
    const maxPapers = Math.min(budget.max_papers || 50, 200);
    const maxCitationExpansions = Math.min(budget.max_citation_expansions || 10, 30);

    const sourcePolicy = args.source_policy || args.sourcePolicy || {};
    const fetchFulltext = sourcePolicy.fetch_fulltext === true;
    const preserveRaw = sourcePolicy.preserve_raw === true;
    const maxFulltextPapers = Math.min(budget.max_fulltext_papers || 5, 20);

    const queries = this._generateQueries(question);
    const webQueries = queries.slice(0, maxWebQueries);
    const paperQueries = queries.slice(0, maxPaperQueries);

    const failures = [];
    const webBundles = [];
    const paperBundles = [];

    if (this.searchKernel && this.searchKernel.searchAndFetch) {
      for (const q of webQueries) {
        try {
          const maxChars = Math.max(10000, Math.floor(50000 / maxWebQueries));
          const bundle = await this.searchKernel.searchAndFetch({
            query: q,
            limit: Math.min(10, Math.ceil(maxWebPages / maxWebQueries)),
            fetch_top_k: Math.max(1, Math.ceil(maxWebPages / maxWebQueries)),
            max_chars_total: maxChars,
            proxy_profile: args.proxy_profile || args.proxyProfile
          });
          webBundles.push({
            query: q,
            bundle_id: bundle.bundle_id,
            items: bundle.items || [],
            search_artifact_ref: bundle.search_artifact_ref,
            pages_fetched: bundle.pages_fetched || 0
          });
        } catch (err) {
          failures.push({ query: q, type: 'web', code: err.code || 'WEB_SEARCH_FAILED', message: err.message });
        }
      }
    }

    if (this.paperKernel && this.paperKernel.searchPapers) {
      for (const q of paperQueries) {
        try {
          const result = await this.paperKernel.searchPapers({
            query: q,
            domain,
            limit: Math.ceil(maxPapers / maxPaperQueries),
            year_from: args.year_from || args.yearFrom,
            year_to: args.year_to || args.yearTo,
            include_preprints: sourcePolicy.include_preprints !== false,
            open_access_only: sourcePolicy.open_access_only || false
          });
          paperBundles.push({
            query: q,
            query_id: result.query_id,
            papers: result.papers || [],
            sources_tried: result.sources_tried || [],
            artifact_ref: result.artifact_ref
          });
          if (result.failures) {
            failures.push(...result.failures.map(f => ({ ...f, query: q, type: 'paper' })));
          }
        } catch (err) {
          failures.push({ query: q, type: 'paper', code: err.status || 'PAPER_SEARCH_FAILED', message: err.message });
        }
      }
    }

    const allWebItems = webBundles.flatMap(b => b.items || []);
    const allPapers = paperBundles.flatMap(b => b.papers || []);
    const deduplicatedPapers = deduplicatePapers(allPapers);
    const rankedPapers = rankPapers(deduplicatedPapers, question, { domain });

    const keyPapers = rankedPapers.slice(0, Math.min(10, maxPapers));
    const citationExpansions = [];

    if (this.paperKernel && this.paperKernel.expandPaperCitations) {
      const topForExpansion = keyPapers.slice(0, Math.min(3, maxCitationExpansions));
      for (const paper of topForExpansion) {
        try {
          const expansion = await this.paperKernel.expandPaperCitations({
            identifier: paper.doi || paper.arxiv_id || paper.semantic_scholar_id,
            direction: 'both',
            limit: Math.ceil(maxCitationExpansions / topForExpansion.length)
          });
          if (expansion.papers && expansion.papers.length > 0) {
            citationExpansions.push({
              root: expansion.root_paper?.doi || expansion.root_paper?.arxiv_id,
              root_title: expansion.root_paper?.title,
              papers: expansion.papers.slice(0, 5),
              edge_count: expansion.edges.length
            });
          }
          if (expansion.failures) {
            failures.push(...expansion.failures.map(f => ({ ...f, identifier: paper.doi || paper.arxiv_id, type: 'citation' })));
          }
        } catch (err) {
          failures.push({ identifier: paper.doi || paper.arxiv_id, type: 'citation', code: err.status || 'CITATION_EXPAND_FAILED', message: err.message });
        }
      }
    }

    const keyClaimCandidates = this._extractClaimCandidates(webBundles, allWebItems, rankedPapers);

    // ─── Fulltext fetching (P3) ────────────────────────────────
    const fulltextResults = [];
    if (fetchFulltext && this.paperContentKernel) {
      const candidatesWithId = rankedPapers
        .filter(p => p.doi || p.arxiv_id)
        .slice(0, maxFulltextPapers);

      for (const paper of candidatesWithId) {
        try {
          const identifier = paper.doi || paper.arxiv_id;
          const identifierType = paper.doi ? 'doi' : 'arxiv';
          const result = await this.paperContentKernel.fetchContent({
            identifier,
            identifier_type: identifierType
          });

          if (result.error) {
            fulltextResults.push({
              identifier,
              title: paper.title,
              status: 'failed',
              error: result.error
            });
            continue;
          }

          fulltextResults.push({
            identifier,
            title: paper.title,
            status: 'success',
            cached: result.cached,
            source: result.source,
            source_url: result.source_url,
            variant: result.variant,
            mime_type: result.mime_type,
            size_bytes: result.size_bytes,
            content_hash: result.content_hash,
            sections: result.sections,
            chunks: result.chunks,
            word_count: result.wordCount,
            fetched_at: new Date().toISOString()
          });

          for (const candidate of keyClaimCandidates) {
            if (candidate.source_type !== 'paper') continue;
            const src = candidate.supporting_sources[0];
            if (!src) continue;
            const candidateDoi = src.doi;
            const candidateArxiv = src.arxiv_id;
            if (candidateDoi === paper.doi || candidateArxiv === paper.arxiv_id) {
              candidate.fulltext_fetched = true;
              candidate.has_sections = !!(result.sections && result.sections.length > 0);
              candidate.has_chunks = !!(result.chunks && result.chunks.length > 0);
              candidate.word_count = result.wordCount || 0;
              candidate.cached = result.cached;
              candidate.source_url = result.source_url;
              if (result.sections && result.sections.length > 0) {
                const sectionText = result.sections
                  .map(s => `### ${s.heading}\n\n${s.text.slice(0, 500)}`)
                  .join('\n\n');
                candidate.claim = `[FULLTEXT] ${paper.title}\n\n${sectionText}`.slice(0, 4000);
                candidate.fulltext_section_count = result.sections.length;
              }
            }
          }
        } catch (err) {
          fulltextResults.push({
            identifier: paper.doi || paper.arxiv_id,
            title: paper.title,
            status: 'error',
            error: err.message
          });
        }
      }
    }
    const contradictionCandidates = this._identifyContradictions(keyClaimCandidates);
    const uncertaintyNotes = this._generateUncertaintyNotes(contradictionCandidates, failures);

    const supportingSources = this._buildSupportingSources(keyClaimCandidates, allWebItems, rankedPapers, fulltextResults);

    const researchId = 'dr_' + crypto.randomBytes(8).toString('hex');
    const payload = {
      research_id: researchId,
      question,
      web_evidence_bundles: webBundles,
      paper_evidence_bundles: paperBundles,
      key_claim_candidates: keyClaimCandidates,
      fulltext_results: fulltextResults,
      supporting_sources: supportingSources,
      contradiction_candidates: contradictionCandidates,
      uncertainty_notes: uncertaintyNotes,
      failures,
      created_at: new Date().toISOString()
    };

    const artifactRef = this.artifactStore
      ? this.artifactStore.writeText('bundles', JSON.stringify(payload, null, 2), { question, domain, kind: 'deep_research' })
      : null;

    return { ...payload, artifact_ref: artifactRef };
  }

  _generateQueries(question) {
    const clean = question.replace(/[?]/g, '').trim();
    const queries = [clean];

    const aspects = [
      `${clean} method`,
      `${clean} approach`,
      `${clean} survey`,
      `${clean} benchmark`,
      `${clean} implementation`,
      `${clean} comparison`,
      `${clean} limitation`,
      `${clean} tutorial`
    ];

    for (const a of aspects) {
      if (!queries.includes(a)) queries.push(a);
    }

    const techTerms = clean.toLowerCase().split(/\s+/).filter(t => t.length > 3);
    if (techTerms.length <= 2) {
      queries.push(`${clean} architecture`);
      queries.push(`${clean} performance`);
    }

    return queries.filter((q, i, arr) => arr.indexOf(q) === i).slice(0, 10);
  }

  _extractClaimCandidates(webBundles, webItems, rankedPapers) {
    const candidates = [];

    for (const bundle of webBundles) {
      for (const item of (bundle.items || []).slice(0, 3)) {
        const text = `${item.title || ''} — ${item.snippet || ''} ${item.text_preview || ''}`.slice(0, 400);
        if (text.length < 20) continue;
        candidates.push({
          claim: text,
          source_type: 'web',
          supporting_sources: [{
            title: item.title,
            url: item.url,
            host: item.host,
            artifact_ref: item.artifact_ref,
            confidence_hint: this._classifySource(item.url)
          }],
          confidence_hint: this._classifySource(item.url)
        });
      }
    }

    for (const paper of rankedPapers.slice(0, 15)) {
      const abstract = (paper.abstract || '').slice(0, 500);
      const claim = `${paper.title}${abstract ? ' — ' + abstract : ''}`.slice(0, 600);
      if (claim.length < 30) continue;
      candidates.push({
        claim,
        source_type: 'paper',
        supporting_sources: [{
          title: paper.title,
          doi: paper.doi,
          arxiv_id: paper.arxiv_id,
          url: paper.landing_page_url,
          pdf_url: paper.pdf_url,
          open_access_status: paper.open_access_status,
          confidence_hint: paper.scores?.final ? paper.scores.final * 0.8 + 0.2 : 0.5
        }],
        confidence_hint: paper.scores?.final ? paper.scores.final * 0.8 + 0.2 : 0.5
      });
    }

    return candidates;
  }

  _identifyContradictions(claimCandidates) {
    const contradictions = [];
    const byMethod = new Map();

    const methodPatterns = [
      /(kv cache|paged attention|flash attention)/i,
      /(speculative decoding|draft model|guess decoding)/i,
      /(quantization|int8|int4|fp16)/i,
      /(distillation|knowledge distillation|model compression)/i,
      /(pruning|sparsity|sparse attention)/i,
      /(mixture of experts|moe|sparse moe)/i,
      /(fine.?tuning|sft|rlhf|dpo)/i,
      /(prompt|in.?context learning|few.?shot)/i
    ];

    for (const candidate of claimCandidates) {
      const text = candidate.claim.toLowerCase();
      for (const pattern of methodPatterns) {
        const match = text.match(pattern);
        if (match) {
          const key = match[0].toLowerCase();
          if (!byMethod.has(key)) byMethod.set(key, []);
          byMethod.get(key).push(candidate);
        }
      }
    }

    for (const [method, candidates] of byMethod) {
      if (candidates.length >= 2) {
        const hasHighConf = candidates.some(c => c.confidence_hint >= 0.7);
        const hasLowConf = candidates.some(c => c.confidence_hint <= 0.4);
        if (hasHighConf && hasLowConf) {
          contradictions.push({
            topic: method,
            description: `Differing confidence levels for '${method}' across sources`,
            candidates_involved: candidates.length,
            confidence_range: [
              Math.min(...candidates.map(c => c.confidence_hint)).toFixed(2),
              Math.max(...candidates.map(c => c.confidence_hint)).toFixed(2)
            ]
          });
        }
      }
    }

    return contradictions;
  }

  _generateUncertaintyNotes(contradictionCandidates, failures) {
    const notes = [];

    if (contradictionCandidates.length > 0) {
      notes.push(`Found ${contradictionCandidates.length} contradictory evidence areas that require further investigation`);
    }

    if (failures.length > 0) {
      const webFailures = failures.filter(f => f.type === 'web').length;
      const paperFailures = failures.filter(f => f.type === 'paper').length;
      const citationFailures = failures.filter(f => f.type === 'citation').length;
      if (webFailures > 0) notes.push(`${webFailures} web search queries failed`);
      if (paperFailures > 0) notes.push(`${paperFailures} paper search queries failed`);
      if (citationFailures > 0) notes.push(`${citationFailures} citation expansions failed`);
    }

    const sourceGap = this._checkSourceGaps();
    if (sourceGap) notes.push(sourceGap);

    return notes;
  }

  _checkSourceGaps() {
    return null;
  }

  _buildSupportingSources(claimCandidates, webItems, rankedPapers, fulltextResults) {
    const sources = [];

    for (const item of webItems.slice(0, 10)) {
      sources.push({
        type: 'web',
        title: item.title,
        url: item.url,
        host: item.host,
        engine: item.engine,
        source_type: item.source_type || 'web',
        confidence_hint: this._classifySource(item.url)
      });
    }

    for (const paper of rankedPapers.slice(0, 10)) {
      const ft = fulltextResults ? fulltextResults.find(r => r.identifier === (paper.doi || paper.arxiv_id)) : null;
      sources.push({
        type: 'paper',
        title: paper.title,
        doi: paper.doi,
        arxiv_id: paper.arxiv_id,
        year: paper.year,
        venue: paper.venue,
        citation_count: paper.citation_count,
        is_open_access: paper.is_open_access,
        pdf_url: paper.pdf_url,
        landing_page_url: paper.landing_page_url,
        scores: paper.scores,
        source_records: paper.source_records,
        confidence_hint: paper.scores?.final ? paper.scores.final * 0.8 + 0.2 : 0.5,
        ...(ft ? {
          fulltext_fetched: ft.status === 'success',
          fulltext_source: ft.source,
          fulltext_cached: ft.cached,
          fulltext_variant: ft.variant,
          fulltext_size: ft.size_bytes,
          fulltext_word_count: ft.word_count,
          fulltext_section_count: ft.sections ? ft.sections.length : 0,
          fulltext_fetched_at: ft.fetched_at
        } : { fulltext_fetched: false })
      });
    }

    return sources;
  }

  _classifySource(url) {
    if (!url) return 0.5;
    const h = url.toLowerCase();
    if (h.includes('github.com')) return 0.76;
    if (h.includes('arxiv.org')) return 0.70;
    if (h.includes('doi.org')) return 0.78;
    if (h.includes('semanticscholar.org')) return 0.72;
    if (h.includes('stackoverflow.com') || h.includes('stackexchange.com')) return 0.62;
    if (h.includes('wikipedia.org')) return 0.65;
    if (h.includes('docs.') || h.includes('developer.') || h.includes('learn.microsoft.com')) return 0.82;
    if (h.endsWith('.edu') || h.endsWith('.gov')) return 0.75;
    if (h.includes('medium.com') || h.includes('towardsdatascience.com')) return 0.45;
    if (h.includes('reddit.com')) return 0.35;
    return 0.55;
  }
}
