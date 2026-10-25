import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { summarizeTrace } from '../extension/lib/trace-summary.js';

const us = (ms: number) => ms * 1000;

describe('summarizeTrace', () => {
  it('reports LCP, CLS, long tasks, and script cost from trace events', () => {
    const summary = summarizeTrace([
      { name: 'navigationStart', ts: us(0) },
      { name: 'firstContentfulPaint', ts: us(420) },
      { name: 'MarkDOMContent', ts: us(600) },
      { name: 'largestContentfulPaint::Candidate', ts: us(700), args: { data: { size: 12000, nodeName: 'IMG', type: 'image' } } },
      { name: 'largestContentfulPaint::Candidate', ts: us(980), args: { data: { size: 40000, nodeName: 'H1', type: 'text' } } },
      { name: 'MarkLoad', ts: us(1100) },
      { name: 'LayoutShift', ts: us(800), args: { data: { score: 0.04, had_recent_input: false, is_main_frame: true } } },
      { name: 'LayoutShift', ts: us(900), args: { data: { score: 0.2, had_recent_input: true, is_main_frame: true } } },
      { name: 'RunTask', ts: us(500), dur: us(80) },
      { name: 'RunTask', ts: us(200), dur: us(10) },
      { name: 'EvaluateScript', ts: us(300), dur: us(140), args: { data: { url: 'https://example.com/app.js' } } },
      { name: 'EvaluateScript', ts: us(450), dur: us(20), args: { data: { url: 'https://example.com/app.js' } } },
      { name: 'EventTiming', ts: us(1500), args: { data: { interactionId: 1, duration: 260, type: 'click' } } },
      { name: 'ParseHTML', ts: us(100), dur: us(30) },
    ]);

    assert.equal(summary.lcp?.timeMs, 980);
    assert.equal(summary.lcp?.nodeName, 'H1');
    assert.equal(summary.fcpMs, 420);
    assert.equal(summary.loadMs, 1100);
    assert.equal(summary.cls?.score, 0.04);
    assert.equal(summary.cls?.shifts, 1);
    assert.equal(summary.longTasks?.count, 1);
    assert.equal(summary.longTasks?.worstMs, 80);
    assert.equal(summary.scripts?.[0]?.durationMs, 160);
    assert.equal(summary.worstInteraction?.durationMs, 260);
    assert.match(summary.report ?? '', /LCP: 980 ms/);
    assert.match(summary.insights?.join(' ') ?? '', /needs improvement/);
  });

  it('says when the trace is empty', () => {
    const summary = summarizeTrace([]);
    assert.equal(summary.eventCount, 0);
    assert.match(summary.report ?? '', /No trace events/);
  });
});