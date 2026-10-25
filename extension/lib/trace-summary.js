const LONG_TASK_MS = 50;
const TOP_SCRIPTS = 8;

function msBetween(event, originUs) {
  return Math.round((event.ts - originUs) / 1000);
}

function durationMs(event) {
  return event.dur ? Math.round(event.dur / 1000) : 0;
}

function dataOf(event) {
  return event.args?.data || {};
}

function rate(value, good, poor, unit) {
  if (value == null || Number.isNaN(value)) return 'not recorded';
  const shown = unit === 'ms' ? `${Math.round(value)} ms` : Number(value).toFixed(3);
  const band = value <= good ? 'good' : value <= poor ? 'needs improvement' : 'poor';
  return `${shown} (${band})`;
}

/**
 * Turns a Chrome trace (Trace Event Format) into the load and responsiveness numbers
 * a model needs: LCP, CLS, interaction delay, long tasks, and the scripts that cost the most.
 */
export function summarizeTrace(events) {
  const list = Array.isArray(events) ? events : [];
  if (list.length === 0) {
    return {
      eventCount: 0,
      report: 'No trace events were recorded. Reload the page while tracing, or interact with it before stopping.',
      insights: ['No trace events were recorded.'],
    };
  }

  const origin = list.find((event) => event.name === 'navigationStart')?.ts ?? Math.min(...list.map((event) => event.ts || 0));
  const last = Math.max(...list.map((event) => (event.ts || 0) + (event.dur || 0)));

  let fcpMs;
  let lcp;
  let dclMs;
  let loadMs;
  let cls = 0;
  let shifts = 0;
  let inp;
  const longTasks = [];
  const scripts = new Map();
  let parseHtmlMs = 0;

  for (const event of list) {
    const data = dataOf(event);
    switch (event.name) {
      case 'firstContentfulPaint':
        fcpMs = msBetween(event, origin);
        break;
      case 'largestContentfulPaint::Candidate':
        lcp = {
          timeMs: msBetween(event, origin),
          size: data.size,
          nodeName: data.nodeName,
          type: data.type,
        };
        break;
      case 'MarkDOMContent':
        dclMs = msBetween(event, origin);
        break;
      case 'MarkLoad':
        loadMs = msBetween(event, origin);
        break;
      case 'LayoutShift':
        if (!data.had_recent_input && data.is_main_frame !== false) {
          cls += Number(data.score) || 0;
          shifts += 1;
        }
        break;
      case 'EventTiming':
        if (data.interactionId && data.duration > (inp?.durationMs ?? -1)) {
          inp = { durationMs: Math.round(data.duration), type: data.type || 'event' };
        }
        break;
      case 'RunTask': {
        const duration = durationMs(event);
        if (duration >= LONG_TASK_MS) longTasks.push(duration);
        break;
      }
      case 'EvaluateScript': {
        const duration = durationMs(event);
        const url = data.url || '(inline)';
        scripts.set(url, (scripts.get(url) || 0) + duration);
        break;
      }
      case 'ParseHTML':
        parseHtmlMs += durationMs(event);
        break;
      default:
        break;
    }
  }

  cls = Number(cls.toFixed(4));
  longTasks.sort((a, b) => b - a);
  const topScripts = [...scripts.entries()]
    .map(([url, duration]) => ({ url, durationMs: duration }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, TOP_SCRIPTS);

  const insights = [];
  if (lcp) insights.push(`Largest Contentful Paint is ${rate(lcp.timeMs, 2500, 4000, 'ms')}.`);
  else insights.push('No Largest Contentful Paint candidate was recorded. The page may be empty, or the trace stopped before paint.');
  insights.push(`Cumulative Layout Shift is ${rate(cls, 0.1, 0.25, 'score')} across ${shifts} shift${shifts === 1 ? '' : 's'}.`);
  if (inp) insights.push(`Worst interaction (${inp.type}) was ${rate(inp.durationMs, 200, 500, 'ms')}.`);
  else insights.push('No interactions were recorded, so interaction delay is not available. Click or type during the trace to measure it.');
  if (longTasks.length) {
    insights.push(`${longTasks.length} long task${longTasks.length === 1 ? '' : 's'} blocked the main thread. The worst lasted ${longTasks[0]} ms.`);
  } else {
    insights.push('No main-thread task longer than 50 ms was recorded.');
  }

  const lines = [
    `Performance trace: ${list.length} events over ${Math.max(0, Math.round((last - origin) / 1000))} ms.`,
    `LCP: ${lcp ? `${lcp.timeMs} ms${lcp.nodeName ? ` (${lcp.nodeName}${lcp.type ? `, ${lcp.type}` : ''})` : ''}` : 'not recorded'}`,
    `FCP: ${fcpMs != null ? `${fcpMs} ms` : 'not recorded'}`,
    `DOMContentLoaded: ${dclMs != null ? `${dclMs} ms` : 'not recorded'}`,
    `Load: ${loadMs != null ? `${loadMs} ms` : 'not recorded'}`,
    `CLS: ${cls} (${shifts} shifts)`,
    `Worst interaction: ${inp ? `${inp.durationMs} ms ${inp.type}` : 'none recorded'}`,
    `Long tasks: ${longTasks.length}${longTasks.length ? `, worst ${longTasks[0]} ms, total ${longTasks.reduce((sum, value) => sum + value, 0)} ms` : ''}`,
    `HTML parse: ${parseHtmlMs} ms`,
    ...(topScripts.length ? ['Scripts:', ...topScripts.map((script) => `  ${script.durationMs} ms  ${script.url}`)] : []),
    'Findings:',
    ...insights.map((line) => `- ${line}`),
  ];

  return {
    eventCount: list.length,
    durationMs: Math.max(0, Math.round((last - origin) / 1000)),
    fcpMs: fcpMs ?? null,
    lcp: lcp ?? null,
    domContentLoadedMs: dclMs ?? null,
    loadMs: loadMs ?? null,
    cls: { score: cls, shifts },
    worstInteraction: inp ?? null,
    longTasks: {
      count: longTasks.length,
      worstMs: longTasks[0] ?? null,
      totalMs: longTasks.reduce((sum, value) => sum + value, 0),
    },
    parseHtmlMs,
    scripts: topScripts,
    insights,
    report: lines.join('\n'),
  };
}
