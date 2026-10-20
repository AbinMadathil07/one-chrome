import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkUrlPolicy,
  formatTabId,
  parseNavigateUrl,
  parseTabId,
  redactSecrets,
  renderStateChange,
  renderTabContext,
  renderTabList,
  sanitizeTitle,
  sanitizeUrl,
  toClaudeTree,
} from '../src/claude/format.js';

describe('Claude toolset formatting', () => {
  it('round-trips tab ids', () => {
    assert.equal(formatTabId(42), 'tab-42');
    assert.equal(parseTabId('tab-42'), 42);
    assert.equal(parseTabId('42'), 42);
    assert.throws(() => parseTabId('tab-x'), /Invalid tab_id/);
  });

  it('converts snapshot refs to ref_N tags', () => {
    const tree = toClaudeTree('- link "Docs" [ref=e1]\n  - button "Go" [ref=e12]\n… truncated at 10 chars.');
    assert.equal(tree, 'link "Docs" [ref_1]\n  button "Go" [ref_12]');
  });

  it('renders tab lists and context like the Claude API', () => {
    const tabs = [
      { tab_id: 'tab-1', title: 'Documentation', url: 'https://example.com/docs', active: true as const },
      { tab_id: 'tab-2', title: 'Pricing', url: 'https://example.com/pricing' },
    ];
    assert.equal(
      renderTabList(tabs),
      'Available tabs:\n  • tab_id tab-1: "Documentation" (https://example.com/docs) (current)\n  • tab_id tab-2: "Pricing" (https://example.com/pricing)',
    );
    assert.equal(renderTabList([]), 'No tabs available');
    assert.match(renderTabContext('tab-1', tabs), /^Tab Context:\n- Executed on tab_id: tab-1\n- Available tabs:\n  • tab_id tab-1: "Documentation" \(https:\/\/example.com\/docs\)\n/);
  });

  it('renders download state changes', () => {
    assert.equal(
      renderStateChange({ type: 'download_completed', download_id: 'dl-1', url: 'https://e.com/a.csv', path: '/tmp/a.csv', size_bytes: 10 }),
      'Download completed with download_id: dl-1, URL: "https://e.com/a.csv". Saved to "/tmp/a.csv". Size: 10 bytes.',
    );
    assert.equal(renderStateChange({ type: 'tab_opened', tab_id: 'tab-1' }), null);
  });

  it('applies navigate URL rules', () => {
    assert.deepEqual(parseNavigateUrl('back'), { kind: 'history', action: 'back' });
    assert.deepEqual(parseNavigateUrl('example.com/docs'), { kind: 'url', url: 'https://example.com/docs' });
    assert.deepEqual(parseNavigateUrl('localhost:3000/x'), { kind: 'url', url: 'https://localhost:3000/x' });
    assert.deepEqual(parseNavigateUrl('http://a.test/'), { kind: 'url', url: 'http://a.test/' });
    for (const bad of ['javascript:alert(1)', 'file:///etc/passwd', 'data:text/html,hi', 'chrome://settings', 'JaVaScRiPt:1']) {
      assert.throws(() => parseNavigateUrl(bad), /Only http and https URLs are allowed/, bad);
    }
  });

  it('enforces host allowlists and private network blocking', () => {
    const open = { allowedHosts: [], blockPrivateNetworks: false };
    assert.equal(checkUrlPolicy('http://127.0.0.1/', open), null);
    const strict = { allowedHosts: ['*.example.com', 'docs.test'], blockPrivateNetworks: true };
    assert.equal(checkUrlPolicy('https://a.example.com/', strict), null);
    assert.equal(checkUrlPolicy('https://example.com/', strict), null);
    assert.equal(checkUrlPolicy('https://docs.test/', strict), null);
    assert.match(checkUrlPolicy('https://evil.test/', strict) ?? '', /not in the allowed host list/);
    assert.match(checkUrlPolicy('http://192.168.1.4/', strict) ?? '', /private or loopback/);
    assert.match(checkUrlPolicy('http://[::1]:8080/', strict) ?? '', /private or loopback/);
  });

  it('sanitizes page-supplied values', () => {
    assert.equal(sanitizeTitle('Hi\nthere\u2028x'), 'Hi there x');
    assert.equal(sanitizeUrl('https://user:pw@e.com/p?token=abc&q=1'), 'https://e.com/p?token=REDACTED&q=1');
    assert.equal(sanitizeUrl('https://e.com/p?x=1#h', { stripQuery: true }), 'https://e.com/p');
  });

  it('redacts credential-like values', () => {
    const out = redactSecrets('auth Bearer abcdefghijklmnop api_key=sk-12345678 jwt eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.SflKxwRJSMeKKF2QT4');
    assert.doesNotMatch(out, /abcdefghijklmnop|sk-12345678|SflKxwRJ/);
    assert.match(out, /Bearer \[REDACTED\]/);
  });
});
