import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { SessionEvents, toDownloadChange } from '../src/browser/session-events.js';

describe('SessionEvents', () => {
  it('keeps one entry per download id, latest state wins', () => {
    const events = new SessionEvents();
    events.recordDownload('s1', toDownloadChange({ id: 7, state: 'in_progress', url: 'https://e.com/f.csv?sig=secret', referrer: '', filename: '' }));
    events.recordDownload('s1', toDownloadChange({ id: 7, state: 'complete', url: 'https://e.com/f.csv?sig=secret', referrer: '', filename: '/tmp/f.csv', fileSize: 12 }));
    const drained = events.drain('s1');
    assert.deepEqual(drained.downloads, [
      { type: 'download_completed', download_id: 'dl-7', url: 'https://e.com/f.csv', path: '/tmp/f.csv', size_bytes: 12 },
    ]);
    assert.deepEqual(events.drain('s1'), { tabsOpened: [], downloads: [] });
  });

  it('restores events when the call they belonged to failed', () => {
    const events = new SessionEvents();
    events.recordTabOpened('s1', 5);
    const drained = events.drain('s1');
    events.restore('s1', drained);
    assert.deepEqual(events.drain('s1').tabsOpened, [5]);
  });

  it('reports failures with the browser error', () => {
    assert.deepEqual(toDownloadChange({ id: 1, state: 'interrupted', url: 'https://e.com/x', referrer: '', filename: '', error: 'NETWORK_FAILED' }), {
      type: 'download_failed',
      download_id: 'dl-1',
      url: 'https://e.com/x',
      error: 'NETWORK_FAILED',
    });
  });
});
