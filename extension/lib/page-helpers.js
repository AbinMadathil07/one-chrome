// Injected into the page's ISOLATED world. Shares the DOM with the page but not its JS globals,
// so page scripts cannot tamper with these helpers and native value setters stay untouched.
(() => {
  if (globalThis.__chromeMcp?.version === 3) {
    return;
  }

  const REF_ATTR = 'data-mcp-ref';
  const refs = new Map();
  let refSeq = 0;

  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'LINK', 'META', 'HEAD']);
  const INTERACTIVE_ROLES = new Set([
    'link', 'button', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox',
    'option', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
    'menuitemradio', 'treeitem', 'clickable',
  ]);
  const NAME_FROM_CONTENT = new Set([
    'button', 'link', 'heading', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio',
    'option', 'cell', 'columnheader', 'rowheader', 'treeitem', 'checkbox', 'radio', 'switch',
    'clickable', 'tooltip',
  ]);
  const MAX_NAME = 100;

  function collapse(text, max = MAX_NAME) {
    const value = String(text ?? '').replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function inputRole(el) {
    const type = (el.getAttribute('type') || 'text').toLowerCase();
    switch (type) {
      case 'hidden': return null;
      case 'checkbox': return el.getAttribute('role') === 'switch' ? 'switch' : 'checkbox';
      case 'radio': return 'radio';
      case 'button': case 'submit': case 'reset': case 'image': return 'button';
      case 'range': return 'slider';
      case 'number': return 'spinbutton';
      case 'search': return 'searchbox';
      default: return el.list ? 'combobox' : 'textbox';
    }
  }

  function implicitRole(el) {
    const tag = el.tagName;
    switch (tag) {
      case 'A': case 'AREA': return el.hasAttribute('href') ? 'link' : null;
      case 'BUTTON': case 'SUMMARY': return 'button';
      case 'INPUT': return inputRole(el);
      case 'TEXTAREA': return 'textbox';
      case 'SELECT': return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
      case 'OPTION': return 'option';
      case 'IMG': return el.getAttribute('alt') === '' ? null : 'img';
      case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6': return 'heading';
      case 'NAV': return 'navigation';
      case 'MAIN': return 'main';
      case 'HEADER': return 'banner';
      case 'FOOTER': return 'contentinfo';
      case 'ASIDE': return 'complementary';
      case 'FORM': return 'form';
      case 'DIALOG': return 'dialog';
      case 'TABLE': return 'table';
      case 'TR': return 'row';
      case 'TH': return 'columnheader';
      case 'TD': return 'cell';
      case 'UL': case 'OL': return 'list';
      case 'LI': return 'listitem';
      case 'PROGRESS': return 'progressbar';
      case 'IFRAME': return 'iframe';
      case 'SECTION': return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
      default: break;
    }
    if (el.isContentEditable && el.getAttribute('contenteditable') !== null) {
      return 'textbox';
    }
    if (el.hasAttribute('onclick') || (el.tabIndex >= 0 && el.hasAttribute('tabindex'))) {
      return 'clickable';
    }
    return null;
  }

  function roleOf(el) {
    const explicit = el.getAttribute('role')?.split(/\s+/)[0];
    if (explicit === 'presentation' || explicit === 'none') {
      return null;
    }
    return explicit || implicitRole(el);
  }

  function nameOf(el, role) {
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy
        .split(/\s+/)
        .map((id) => el.ownerDocument.getElementById(id)?.textContent || '')
        .join(' ');
      if (text.trim()) {
        return collapse(text);
      }
    }
    const aria = el.getAttribute('aria-label');
    if (aria?.trim()) {
      return collapse(aria);
    }
    if (el.labels?.length) {
      const text = [...el.labels].map((label) => label.innerText).join(' ');
      if (text.trim()) {
        return collapse(text);
      }
    }
    if (el.tagName === 'IMG' || el.tagName === 'AREA') {
      return collapse(el.getAttribute('alt') || el.getAttribute('title') || '');
    }
    if (el.tagName === 'INPUT' && ['button', 'submit', 'reset'].includes(el.type)) {
      return collapse(el.value || el.type);
    }
    if (NAME_FROM_CONTENT.has(role)) {
      const text = collapse(el.innerText || el.textContent || '');
      if (text) {
        return text;
      }
    }
    return collapse(el.getAttribute('placeholder') || el.getAttribute('title') || '');
  }

  function refFor(el) {
    let ref = el.getAttribute(REF_ATTR);
    if (!ref || refs.get(ref)?.deref() !== el) {
      refSeq += 1;
      ref = `e${refSeq}`;
      el.setAttribute(REF_ATTR, ref);
    }
    refs.set(ref, new WeakRef(el));
    return ref;
  }

  function isSkippedSubtree(el, includeHidden) {
    if (SKIP_TAGS.has(el.tagName)) {
      return true;
    }
    if (includeHidden) {
      return false;
    }
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') {
      return true;
    }
    return getComputedStyle(el).display === 'none';
  }

  function isInvisibleSelf(el) {
    const style = getComputedStyle(el);
    return style.visibility === 'hidden' || style.visibility === 'collapse';
  }

  function stateAttrs(el, role, boxes) {
    const attrs = [];
    if (role === 'heading') {
      const level = el.getAttribute('aria-level') || el.tagName.match(/^H(\d)$/)?.[1];
      if (level) attrs.push(`[level=${level}]`);
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch') {
      const checked = 'checked' in el ? el.checked : el.getAttribute('aria-checked') === 'true';
      if (checked) attrs.push('[checked]');
    }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') attrs.push('[disabled]');
    const expanded = el.getAttribute('aria-expanded');
    if (expanded) attrs.push(`[expanded=${expanded}]`);
    if (el.getAttribute('aria-selected') === 'true' || (el.tagName === 'OPTION' && el.selected)) {
      attrs.push('[selected]');
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox' || role === 'spinbutton' || role === 'slider') {
      if (el.type === 'password') {
        if (el.value) attrs.push('[value=••••]');
      } else if ('value' in el && el.value) {
        attrs.push(`[value=${JSON.stringify(collapse(el.value, 80))}]`);
      } else if (el.isContentEditable && el.textContent) {
        attrs.push(`[value=${JSON.stringify(collapse(el.textContent, 80))}]`);
      }
    }
    if (role === 'link') {
      const href = el.getAttribute('href');
      if (href && !href.startsWith('javascript:')) attrs.push(`[url=${collapse(href, 120)}]`);
    }
    if (boxes) {
      const r = el.getBoundingClientRect();
      attrs.push(`[box=${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.width)},${Math.round(r.height)}]`);
    }
    return attrs.join(' ');
  }

  function childNodesOf(node) {
    if (node.shadowRoot) {
      return [...node.shadowRoot.childNodes];
    }
    if (node.tagName === 'SLOT') {
      const assigned = node.assignedNodes({ flatten: true });
      return assigned.length ? assigned : [...node.childNodes];
    }
    return [...node.childNodes];
  }

  function snapshot(options = {}) {
    const filter = options.filter === 'interactive' ? 'interactive' : 'all';
    const maxDepth = Number(options.depth) > 0 ? Number(options.depth) : 40;
    const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 40_000;
    const boxes = Boolean(options.boxes);
    const includeHidden = Boolean(options.includeHidden);
    const viewportOnly = Boolean(options.viewportOnly);
    const inViewport = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    };
    const root = options.target ? resolve(options.target) : document.body || document.documentElement;

    const lines = [];
    let chars = 0;
    let truncated = false;
    let refCount = 0;

    const push = (line) => {
      if (truncated) return false;
      if (chars + line.length + 1 > maxChars) {
        truncated = true;
        return false;
      }
      lines.push(line);
      chars += line.length + 1;
      return true;
    };

    const visit = (node, depth, suppressText) => {
      if (truncated) return;
      if (node.nodeType === Node.TEXT_NODE) {
        if (filter === 'interactive' || suppressText) return;
        if (viewportOnly && node.parentElement && !inViewport(node.parentElement)) return;
        const text = collapse(node.textContent, 200);
        if (text) push(`${'  '.repeat(depth)}- text: ${JSON.stringify(text)}`);
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) {
        return;
      }
      if (node.nodeType === Node.ELEMENT_NODE && isSkippedSubtree(node, includeHidden)) {
        return;
      }

      let childDepth = depth;
      let childSuppress = suppressText;
      if (node.nodeType === Node.ELEMENT_NODE) {
        const role = roleOf(node);
        const emit = role
          && !isInvisibleSelf(node)
          && (filter === 'all' || INTERACTIVE_ROLES.has(role))
          && (!viewportOnly || inViewport(node));
        if (emit) {
          if (depth >= maxDepth) return;
          const name = nameOf(node, role);
          const ref = refFor(node);
          refCount += 1;
          const attrs = stateAttrs(node, role, boxes);
          const indent = filter === 'interactive' ? '' : '  '.repeat(depth);
          push(`${indent}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}${attrs ? ` ${attrs}` : ''} [ref=${ref}]`);
          if (filter === 'all') childDepth = depth + 1;
          if (NAME_FROM_CONTENT.has(role)) childSuppress = true;
        }
      }

      for (const child of childNodesOf(node)) {
        visit(child, childDepth, childSuppress);
        if (truncated) return;
      }
    };

    visit(root, 0, false);

    return {
      url: location.href,
      title: document.title,
      filter,
      refCount,
      truncated,
      snapshot: truncated
        ? `${lines.join('\n')}\n… truncated at ${maxChars} chars. Pass target=<ref>, a smaller depth, or filter="interactive".`
        : lines.join('\n'),
    };
  }

  function findByText(text) {
    const needle = text.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
    let best = null;
    while (walker.nextNode()) {
      const el = walker.currentNode;
      if (isSkippedSubtree(el, false)) continue;
      const content = collapse(el.innerText || '', 500).toLowerCase();
      if (content.includes(needle)) {
        best = el;
      }
    }
    return best;
  }

  function resolve(target) {
    if (target == null || target === '') {
      throw new Error('A target (snapshot ref like "e12" or a CSS selector) is required');
    }
    const value = String(target).trim();
    const claudeRef = value.match(/^ref_(\d+)$/);
    if (claudeRef || /^e\d+$/.test(value)) {
      const ref = claudeRef ? `e${claudeRef[1]}` : value;
      const el = refs.get(ref)?.deref() || document.querySelector(`[${REF_ATTR}="${ref}"]`);
      if (!el || !el.isConnected) {
        throw new Error(
          claudeRef
            ? `${value} is stale or not found on the current page. Re-read the page to get fresh references.`
            : `Ref ${value} is not on the current page. Take a fresh chrome_snapshot and use its refs.`,
        );
      }
      return el;
    }
    if (value.startsWith('text=')) {
      const el = findByText(value.slice(5));
      if (!el) throw new Error(`No element contains text: ${value.slice(5)}`);
      return el;
    }
    let el;
    try {
      el = document.querySelector(value);
    } catch {
      throw new Error(`Invalid selector: ${value}`);
    }
    if (!el) {
      throw new Error(`No element matches selector: ${value}`);
    }
    return el;
  }

  function describe(el) {
    if (!el) return null;
    const ref = el.getAttribute(REF_ATTR);
    const role = roleOf(el) || el.tagName.toLowerCase();
    return `${role}${ref ? ` [ref=${ref}]` : ''} ${JSON.stringify(nameOf(el, role) || '')}`.trim();
  }

  function point(target) {
    const el = resolve(target);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      throw new Error(`Element ${target} has no visible size and cannot be clicked`);
    }
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const hit = document.elementFromPoint(x, y);
    const obscured = hit != null && hit !== el && !el.contains(hit) && !hit.contains(el);
    return {
      x,
      y,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      pageRect: { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height },
      obscuredBy: obscured ? describe(hit) : null,
      element: describe(el),
    };
  }

  function domClick(target, doubleClick) {
    const el = resolve(target);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const init = { bubbles: true, cancelable: true, composed: true, view: window };
    el.dispatchEvent(new PointerEvent('pointerdown', init));
    el.dispatchEvent(new MouseEvent('mousedown', init));
    el.focus?.();
    el.dispatchEvent(new PointerEvent('pointerup', init));
    el.dispatchEvent(new MouseEvent('mouseup', init));
    el.click();
    if (doubleClick) {
      el.click();
      el.dispatchEvent(new MouseEvent('dblclick', init));
    }
    return { clicked: describe(el), method: 'dom' };
  }

  function domHover(target) {
    const el = resolve(target);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const init = { bubbles: true, cancelable: true, composed: true, view: window };
    for (const type of ['pointerover', 'pointerenter', 'mouseover', 'mouseenter', 'pointermove', 'mousemove']) {
      el.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, init) : new MouseEvent(type, init));
    }
    return { hovered: describe(el), method: 'dom' };
  }

  function setNativeValue(el, value) {
    const proto = Object.getPrototypeOf(el);
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    if (setter) {
      setter.call(el, value);
    } else {
      el.value = value;
    }
  }

  function fire(el, ...types) {
    for (const type of types) {
      el.dispatchEvent(new Event(type, { bubbles: true, composed: true }));
    }
  }

  function selectOption(target, values) {
    const el = resolve(target);
    if (el.tagName !== 'SELECT') {
      throw new Error(`${describe(el)} is not a <select>. Click it and pick an option ref instead.`);
    }
    const wanted = (Array.isArray(values) ? values : [values]).map(String);
    const selected = [];
    for (const option of el.options) {
      const match = wanted.includes(option.value) || wanted.includes(collapse(option.label || option.text));
      if (el.multiple) {
        option.selected = match;
      } else if (match && selected.length === 0) {
        option.selected = true;
      }
      if (match) selected.push(option.value);
    }
    if (selected.length === 0) {
      const available = [...el.options].map((o) => collapse(o.label || o.text, 40)).slice(0, 30);
      throw new Error(`No option matched ${JSON.stringify(wanted)}. Available: ${JSON.stringify(available)}`);
    }
    fire(el, 'input', 'change');
    return { selected, element: describe(el) };
  }

  function fill(target, value, clear = true) {
    const el = resolve(target);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    if (el.tagName === 'SELECT') {
      return selectOption(target, [String(value)]);
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      const desired = value === true || value === 'true' || value === 'on' || value === 1;
      if (el.checked !== desired) el.click();
      return { filled: describe(el), checked: el.checked };
    }
    el.focus();
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      setNativeValue(el, clear ? String(value) : `${el.value}${value}`);
      fire(el, 'input', 'change');
      return { filled: describe(el) };
    }
    if (el.isContentEditable) {
      if (clear) {
        const range = document.createRange();
        range.selectNodeContents(el);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
      }
      if (!document.execCommand('insertText', false, String(value))) {
        el.textContent = clear ? String(value) : `${el.textContent}${value}`;
        fire(el, 'input');
      }
      return { filled: describe(el) };
    }
    throw new Error(`${describe(el)} is not fillable`);
  }

  function fillForm(fields) {
    return fields.map((field) => fill(field.target, field.value, field.clear !== false));
  }

  function focus(target, clear) {
    const el = target ? resolve(target) : document.activeElement;
    if (!el || el === document.body) {
      throw new Error('Nothing is focused. Pass a target to type into.');
    }
    el.scrollIntoView?.({ block: 'center', behavior: 'instant' });
    el.focus();
    if (clear) {
      if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        setNativeValue(el, '');
        fire(el, 'input');
      } else if (el.isContentEditable) {
        el.textContent = '';
        fire(el, 'input');
      }
    } else if (typeof el.setSelectionRange === 'function' && typeof el.value === 'string') {
      try {
        el.setSelectionRange(el.value.length, el.value.length);
      } catch {
        // Some input types (email, number) do not support selection ranges.
      }
    }
    return { focused: describe(el) };
  }

  function domType(target, text) {
    const el = target ? resolve(target) : document.activeElement;
    if (!el) throw new Error('No element to type into');
    el.focus();
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
      setNativeValue(el, `${el.value || ''}${text}`);
      fire(el, 'input');
    } else if (el.isContentEditable) {
      document.execCommand('insertText', false, text);
    } else {
      throw new Error(`${describe(el)} is not typeable`);
    }
    return { typed: text.length, element: describe(el), method: 'dom' };
  }

  function domKey(key) {
    const el = document.activeElement || document.body;
    const init = { key, bubbles: true, cancelable: true, composed: true };
    el.dispatchEvent(new KeyboardEvent('keydown', init));
    el.dispatchEvent(new KeyboardEvent('keyup', init));
    if (key === 'Enter' && el.form && el.tagName === 'INPUT') {
      el.form.requestSubmit?.();
    }
    return { pressed: key, method: 'dom' };
  }

  function scroll({ target, deltaX = 0, deltaY = 0, to } = {}) {
    const el = target ? resolve(target) : null;
    const scroller = el || document.scrollingElement || document.documentElement;
    if (to === 'top') {
      scroller.scrollTo({ top: 0, behavior: 'instant' });
    } else if (to === 'bottom') {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior: 'instant' });
    } else if (el && !deltaX && !deltaY) {
      el.scrollIntoView({ block: 'center', behavior: 'instant' });
    } else {
      scroller.scrollBy({ left: Number(deltaX), top: Number(deltaY), behavior: 'instant' });
    }
    return {
      scrollX: Math.round(el ? el.scrollLeft : scrollX),
      scrollY: Math.round(el ? el.scrollTop : scrollY),
      scrollHeight: scroller.scrollHeight,
      viewportHeight: innerHeight,
    };
  }

  function text(target) {
    const el = target ? resolve(target) : document.body;
    return { text: el?.innerText || '', url: location.href, title: document.title };
  }

  const MAIN_CANDIDATES = 'main, [role="main"], article, #content, #main, .content, .post, .article';
  const MIN_MAIN_CHARS = 200;

  /** Visible text with the main article content preferred over navigation and chrome. */
  function mainText(maxChars = 100_000) {
    const candidates = [...document.querySelectorAll(MAIN_CANDIDATES)]
      .map((el) => ({ el, text: (el.innerText || '').trim() }))
      .filter((c) => c.text.length >= MIN_MAIN_CHARS);
    candidates.sort((a, b) => b.text.length - a.text.length);
    const chosen = candidates[0];
    const body = chosen ? chosen.text : (document.body?.innerText || '').trim();
    const cleaned = body.replace(/\n{3,}/g, '\n\n');
    return {
      url: location.href,
      title: document.title,
      source: chosen ? chosen.el.tagName.toLowerCase() : 'body',
      truncated: cleaned.length > maxChars,
      text: cleaned.length > maxChars ? cleaned.slice(0, maxChars) : cleaned,
    };
  }

  function html(target, maxChars = 200_000) {
    const el = target ? resolve(target) : document.documentElement;
    const value = el.outerHTML;
    return {
      html: value.length > maxChars ? value.slice(0, maxChars) : value,
      truncated: value.length > maxChars,
      length: value.length,
    };
  }

  function bodyText() {
    return (document.body?.innerText || '').toLowerCase();
  }

  function isVisible(el) {
    if (!el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none';
  }

  async function waitFor({ target, state = 'visible', text: wanted, textGone, time, timeoutMs = 15_000 } = {}) {
    const started = Date.now();
    if (time) {
      await new Promise((r) => setTimeout(r, Math.min(Number(time), 30) * 1000));
    }
    const check = () => {
      if (textGone && bodyText().includes(String(textGone).toLowerCase())) return false;
      if (wanted && !bodyText().includes(String(wanted).toLowerCase())) return false;
      if (target) {
        let el = null;
        try {
          el = resolve(target);
        } catch {
          el = null;
        }
        if (state === 'attached') return Boolean(el);
        if (state === 'detached') return !el;
        if (state === 'hidden') return !el || !isVisible(el);
        return Boolean(el) && isVisible(el);
      }
      return true;
    };
    while (Date.now() - started < timeoutMs) {
      if (check()) {
        return { ok: true, elapsedMs: Date.now() - started };
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    throw new Error(
      `Timed out after ${timeoutMs}ms waiting for ${JSON.stringify({ target, state, text: wanted, textGone })}`,
    );
  }

  function interactive(limit = 100) {
    const result = snapshot({ filter: 'interactive', maxChars: 1_000_000 });
    return result.snapshot.split('\n').filter(Boolean).slice(0, limit);
  }

  function pageInfo() {
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      scrollX: Math.round(scrollX),
      scrollY: Math.round(scrollY),
      viewport: { width: innerWidth, height: innerHeight },
    };
  }

  function refSelector(target) {
    const el = resolve(target);
    return `[${REF_ATTR}="${refFor(el)}"]`;
  }

  const api = {
    snapshot, point, domClick, domHover, fill, fillForm, focus, domType, domKey, selectOption,
    scroll, text, html, waitFor, interactive, pageInfo, refSelector, mainText,
  };

  globalThis.__chromeMcp = {
    version: 3,
    async call(method, args) {
      const fn = api[method];
      if (!fn) {
        return { ok: false, error: `Unknown page helper: ${method}` };
      }
      try {
        return { ok: true, value: await fn(...(args || [])) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
})();
