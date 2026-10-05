// Regression tests for the "Error: Could not parse CSS stylesheet" log flood.
// jsdom chokes on modern CSS (@layer blocks and CSS nesting -- exactly what
// Chakra/AstroWind inline into every page) and by default dumps a jsdomError
// stack plus the whole stylesheet to stderr once per <style> block. Extraction
// must stay silent, still return the article text, and keep showing every
// non-CSS jsdom error (and optionally a one-line CSS summary for debugging).
import { test } from 'node:test';
import assert from 'node:assert';
import { extractTextFromHtml, buildExtractionVirtualConsole } from '../src/fetch/extract.js';

const LAYER_CSS = "@layer recipes{.css-1baunoy{position:relative;max-width:var(--chakra-sizes-8xl);}}";
const NESTED_CSS = '.css-1h7efca{align-items:center;&:hover{color:red;}}';
const SENTENCE = 'Chakra pages still give up their article text. ';
const PAGE = [
  '<!doctype html><html><head><title>AstroWind page</title>',
  '<style>' + LAYER_CSS + '</style><style>' + NESTED_CSS + '</style></head>',
  '<body><main><article><h1>AstroWind page</h1><p>' + SENTENCE.repeat(20) + '</p></article></main></body></html>'
].join('');

function captureStderr(run) {
  const lines = [];
  const original = console.error;
  console.error = (...args) => lines.push(args.map((arg) => String(arg?.stack || arg)).join(' '));
  try {
    run();
  } finally {
    console.error = original;
  }
  return lines;
}

function withEnv(name, value, run) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const previous = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return run();
  } finally {
    if (had) process.env[name] = previous;
    else delete process.env[name];
  }
}

test('unparseable inline CSS stays out of stderr and text extraction still works', () => {
  const stderr = withEnv('EXTRACT_DEBUG_CSS_ERRORS', undefined, () =>
    captureStderr(() => {
      const result = extractTextFromHtml(PAGE, 'https://example.com/astro');
      assert.match(result.text, /Chakra pages still give up their article text/);
      assert.match(result.title, /AstroWind page/);
      assert.ok(result.extracted_chars > 300);
    })
  );
  assert.deepStrictEqual(stderr, [], 'CSS parse noise leaked to stderr');
});

test('EXTRACT_DEBUG_CSS_ERRORS=true reports a one-line summary per stylesheet', () => {
  const stderr = withEnv('EXTRACT_DEBUG_CSS_ERRORS', 'true', () =>
    captureStderr(() => extractTextFromHtml(PAGE, 'https://example.com/astro'))
  );
  assert.ok(stderr.length >= 1, 'expected at least one CSS summary line');
  for (const line of stderr) {
    assert.match(line, /^\[extract\] ignored CSS parse error \(\d+ chars\)$/);
    assert.doesNotMatch(line, /@layer|css-/);
  }
});

test('non-CSS jsdom errors are still printed', () => {
  const virtualConsole = buildExtractionVirtualConsole();
  const failure = new Error('script execution exploded');
  const stderr = captureStderr(() => virtualConsole.emit('jsdomError', failure));
  assert.strictEqual(stderr.length, 1);
  assert.match(stderr[0], /script execution exploded/);

  const bare = captureStderr(() => virtualConsole.emit('jsdomError', { type: 'not css' }));
  assert.strictEqual(bare.length, 1);
});

test('CSS summaries are suppressed again once the debug flag is cleared', () => {
  const virtualConsole = buildExtractionVirtualConsole();
  const emitted = withEnv('EXTRACT_DEBUG_CSS_ERRORS', 'false', () =>
    captureStderr(() => virtualConsole.emit('jsdomError', { type: 'css parsing', detail: '@layer x{}' }))
  );
  assert.deepStrictEqual(emitted, []);
});
