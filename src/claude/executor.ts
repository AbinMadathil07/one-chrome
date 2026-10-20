import { z } from 'zod';
import type { BrowserRuntime } from '../browser/browser-runtime.js';
import { resolveUploadFiles } from '../browser/upload-policy.js';
import type { HostConfig } from '../config.js';
import type { SessionId, TabId, TabSnapshot } from '../types.js';
import { rankElements } from './find.js';
import {
  checkUrlPolicy,
  formatTabId,
  parseNavigateUrl,
  parseTabId,
  redactSecrets,
  sanitizeTitle,
  sanitizeUrl,
  toClaudeTree,
  truncate,
  type BrowserState,
  type BrowserTab,
  type StateChange,
} from './format.js';
import {
  MEMBERS,
  TAB_MANAGEMENT_MEMBERS,
  isMemberName,
  type CoordinateTarget,
  type MemberName,
  type RefTarget,
  type Target,
} from './members.js';

export type MemberContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export type MemberResult = {
  content: MemberContent[];
  isError: boolean;
  browserState?: BrowserState;
  /** Tab the call ran on, used for the Tab Context footer. */
  executedOn?: string;
};

type Outcome = { text?: string; image?: { data: string; mimeType: string }; tabId?: TabId | null; forceState?: boolean };
type Modal = { type: string; message: string };

const READ_PAGE_MAX_CHARS = 50_000;
const PAGE_TEXT_MAX_CHARS = 100_000;
const CONSOLE_LINE_MAX = 500;
const NETWORK_URL_MAX = 300;
const JS_RESULT_MAX = 50_000;
const SCROLL_NOTCH_PX = 100;
const ZOOM_UPSCALE = 4;
const SETTLE_INITIAL_MS = 150;
const SETTLE_POLL_MS = 250;
const SETTLE_MAX_MS = 5_000;
const NAVIGATION_TIMEOUT_TEXT = /Timed out waiting for tab \d+ to finish loading/;
const HALT_TEXT = 'Not executed: an earlier action in this turn failed.';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith('Error:') ? message : `Error: ${message}`;
}

class MemberError extends Error {}

/**
 * Executes Claude `browser_toolset_20260801` member calls against a session's tabs, producing
 * the result content and `browser_state` block the Claude API expects.
 */
export class ClaudeBrowserExecutor {
  private readonly screenshotScale = new Map<TabId, number>();
  private readonly consoleCursor = new Map<string, number>();
  private readonly networkCursor = new Map<string, { cursor: number; reported: Set<number> }>();
  private readonly lastState = new Map<SessionId, string>();

  constructor(
    private readonly runtime: BrowserRuntime,
    private readonly config: HostConfig,
  ) {}

  isEnabled(name: string): boolean {
    return isMemberName(name) && !this.config.disabledTools.has(name);
  }

  enabledMembers(): MemberName[] {
    return (Object.keys(MEMBERS) as MemberName[]).filter((name) => this.isEnabled(name));
  }

  haltResult(): MemberResult {
    return { content: [{ type: 'text', text: HALT_TEXT }], isError: true };
  }

  async execute(sessionId: SessionId, name: string, rawInput: unknown): Promise<MemberResult> {
    if (!isMemberName(name)) {
      return this.fail(`Error: ${name} is not a browser member tool.`);
    }
    if (!this.isEnabled(name)) {
      return this.fail(`Error: ${name} is not enabled in this environment.`);
    }
    const parsed = z.object(MEMBERS[name].shape).strict().safeParse(rawInput ?? {});
    if (!parsed.success) {
      return this.fail(`Error: Invalid input for ${name}: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'} ${i.message}`).join('; ')}`);
    }
    const drained = this.runtime.events.drain(sessionId);
    try {
      const outcome = await this.dispatch(sessionId, name, parsed.data as Record<string, unknown>);
      return await this.succeed(sessionId, name, outcome, drained);
    } catch (error) {
      this.runtime.events.restore(sessionId, drained);
      return this.fail(errorText(error));
    }
  }

  private fail(text: string): MemberResult {
    return { content: [{ type: 'text', text }], isError: true };
  }

  private async succeed(
    sessionId: SessionId,
    name: MemberName,
    outcome: Outcome,
    drained: ReturnType<BrowserRuntime['events']['drain']>,
  ): Promise<MemberResult> {
    const later = this.runtime.events.drain(sessionId);
    const tabsOpened = [...new Set([...drained.tabsOpened, ...later.tabsOpened])];
    const downloads = new Map([...drained.downloads, ...later.downloads].map((d) => [d.download_id, d]));

    const tabs = await this.inventory(sessionId);
    const openIds = new Set(tabs.map((t) => t.tab_id));
    const stateChanges: StateChange[] = [
      ...tabsOpened.map((id) => ({ type: 'tab_opened' as const, tab_id: formatTabId(id) })).filter((c) => openIds.has(c.tab_id)),
      ...downloads.values(),
    ];

    const signature = JSON.stringify(tabs);
    const changed = this.lastState.get(sessionId) !== signature;
    const includeState = TAB_MANAGEMENT_MEMBERS.has(name) || outcome.forceState || changed || stateChanges.length > 0;

    const content: MemberContent[] = [];
    if (outcome.image) content.push({ type: 'image', ...outcome.image });
    if (outcome.text != null) content.push({ type: 'text', text: outcome.text });

    const result: MemberResult = {
      content,
      isError: false,
      executedOn: outcome.tabId != null ? formatTabId(outcome.tabId) : undefined,
    };
    if (includeState) {
      this.lastState.set(sessionId, signature);
      result.browserState = {
        type: 'browser_state',
        tabs,
        ...(stateChanges.length ? { state_changes: stateChanges } : {}),
      };
    }
    return result;
  }

  private async inventory(sessionId: SessionId): Promise<BrowserTab[]> {
    const session = this.runtime.getSession(sessionId);
    if (session.ownedTabIds.length === 0) return [];
    const chromeTabs = await this.runtime.listChromeTabs();
    const byId = new Map(chromeTabs.map((tab) => [tab.tabId, tab]));
    return session.ownedTabIds
      .map((id) => byId.get(id))
      .filter((tab): tab is TabSnapshot => Boolean(tab))
      .map((tab) => ({
        tab_id: formatTabId(tab.tabId),
        title: sanitizeTitle(tab.title),
        url: sanitizeUrl(tab.url),
        ...(tab.tabId === session.activeTabId ? { active: true as const } : {}),
      }));
  }

  private resolveTab(sessionId: SessionId, tabIdInput: unknown): TabId {
    const session = this.runtime.getSession(sessionId);
    if (typeof tabIdInput === 'string') {
      const id = parseTabId(tabIdInput);
      if (!session.ownedTabIds.includes(id)) {
        throw new MemberError(`Error: tab_id ${tabIdInput} is not an open tab. Call list_tabs to see available tabs.`);
      }
      return id;
    }
    if (session.activeTabId == null) {
      throw new MemberError('Error: No tab is open. Call navigate with a URL or new_tab first.');
    }
    return session.activeTabId;
  }

  private run<T>(sessionId: SessionId, tabId: TabId, command: Parameters<BrowserRuntime['runOnTab']>[0]['command'], args: Record<string, unknown>, exclusive = true): Promise<T> {
    return this.runtime.runOnTab<T>({ sessionId, tabId, exclusive, command, args });
  }

  private toViewport(tabId: TabId, point: CoordinateTarget): { x: number; y: number } {
    const scale = this.screenshotScale.get(tabId) ?? 1;
    return { x: point.x / scale, y: point.y / scale };
  }

  /** Clears a JS dialog the action opened; Claude's toolset has no dialog member. */
  private async settleDialog(tabId: TabId, result: unknown): Promise<string> {
    const modal = (result as { modal?: Modal } | null)?.modal;
    if (!modal) return '';
    const accept = modal.type === 'alert' || modal.type === 'beforeunload';
    await this.runtime.sendUnleased('handle_dialog', { accept }, tabId);
    const message = truncate(sanitizeTitle(modal.message), 300);
    return ` A ${modal.type} dialog appeared ("${message}") and was ${accept ? 'accepted' : 'dismissed'}.`;
  }

  /** Gives a navigation triggered by input a moment to commit so tab context reflects it. */
  private async settleNavigation(tabId: TabId): Promise<void> {
    await sleep(SETTLE_INITIAL_MS);
    const started = Date.now();
    while (Date.now() - started < SETTLE_MAX_MS) {
      const tab = (await this.runtime.listChromeTabs()).find((t) => t.tabId === tabId);
      if (!tab || tab.status !== 'loading') return;
      await sleep(SETTLE_POLL_MS);
    }
  }

  private describeTarget(target: Target): string {
    return target.type === 'ref' ? `element ${target.ref}` : `(${Math.round(target.x)}, ${Math.round(target.y)})`;
  }

  private async pointer(
    sessionId: SessionId,
    input: Record<string, unknown>,
    options: { button: 'left' | 'right' | 'middle'; clickCount: number; verb: string },
  ): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const target = input.target as Target;
    const base = { button: options.button, clickCount: options.clickCount, modifiers: input.modifiers };
    const args = target.type === 'ref'
      ? { ...base, target: target.ref, method: 'mouse' }
      : { ...base, ...this.toViewport(tabId, target) };
    const result = await this.run<{ warning?: string }>(sessionId, tabId, 'click', args);
    const dialog = await this.settleDialog(tabId, result);
    if (!dialog) await this.settleNavigation(tabId);
    const warning = result?.warning ? ` Note: ${result.warning}.` : '';
    return { text: `${options.verb} ${this.describeTarget(target)}.${warning}${dialog}`, tabId };
  }

  private async dispatch(sessionId: SessionId, name: MemberName, input: Record<string, unknown>): Promise<Outcome> {
    switch (name) {
      case 'navigate':
        return this.navigate(sessionId, input);
      case 'screenshot':
        return this.screenshot(sessionId, input);
      case 'zoom':
        return this.zoom(sessionId, input);
      case 'left_click':
        return this.pointer(sessionId, input, { button: 'left', clickCount: 1, verb: 'Clicked' });
      case 'right_click':
        return this.pointer(sessionId, input, { button: 'right', clickCount: 1, verb: 'Right-clicked' });
      case 'middle_click':
        return this.pointer(sessionId, input, { button: 'middle', clickCount: 1, verb: 'Middle-clicked' });
      case 'double_click':
        return this.pointer(sessionId, input, { button: 'left', clickCount: 2, verb: 'Double-clicked' });
      case 'triple_click':
        return this.pointer(sessionId, input, { button: 'left', clickCount: 3, verb: 'Triple-clicked' });
      case 'hover':
        return this.hover(sessionId, input);
      case 'left_click_drag':
        return this.drag(sessionId, input);
      case 'left_mouse_down':
      case 'left_mouse_up':
      case 'mouse_move':
        return this.mouse(sessionId, name, input);
      case 'scroll':
        return this.scroll(sessionId, input);
      case 'scroll_to':
        return this.scrollTo(sessionId, input);
      case 'type':
        return this.type(sessionId, input);
      case 'key':
        return this.key(sessionId, input);
      case 'hold_key':
        return this.holdKey(sessionId, input);
      case 'wait':
        return this.wait(sessionId, input);
      case 'read_page':
        return this.readPage(sessionId, input);
      case 'find':
        return this.find(sessionId, input);
      case 'get_page_text':
        return this.pageText(sessionId, input);
      case 'form_input':
        return this.formInput(sessionId, input);
      case 'file_upload':
        return this.fileUpload(sessionId, input);
      case 'read_console':
        return this.readConsole(sessionId, input);
      case 'read_network':
        return this.readNetwork(sessionId, input);
      case 'javascript_exec':
        return this.javascript(sessionId, input);
      case 'new_tab':
        return this.newTab(sessionId);
      case 'list_tabs':
        return { tabId: null };
      case 'switch_tab':
        return this.switchTab(sessionId, input);
      case 'close_tab':
        return this.closeTab(sessionId, input);
      default: {
        const exhaustive: never = name;
        throw new MemberError(`Error: ${String(exhaustive)} is not implemented.`);
      }
    }
  }

  private assertAllowed(url: string): void {
    const refusal = checkUrlPolicy(url, this.config);
    if (refusal) throw new MemberError(`Error: ${refusal}`);
  }

  private async navigate(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const target = parseNavigateUrl(String(input.url));
    const session = this.runtime.getSession(sessionId);
    if (target.kind === 'url') this.assertAllowed(target.url);

    if (target.kind === 'url' && input.tab_id == null && session.activeTabId == null) {
      const tab = await this.runtime.openTab(sessionId, { url: 'about:blank', active: false });
      this.runtime.events.recordTabOpened(sessionId, tab.tabId);
    }
    const tabId = this.resolveTab(sessionId, input.tab_id);

    if (target.kind === 'history') {
      const command = target.action === 'back' ? 'go_back' : target.action === 'forward' ? 'go_forward' : 'reload';
      const result = await this.run<{ url?: string; modal?: Modal }>(sessionId, tabId, command, {});
      const dialog = await this.settleDialog(tabId, result);
      const verb = { back: 'Went back', forward: 'Went forward', reload: 'Reloaded' }[target.action];
      return { text: `${verb}. Now at ${sanitizeUrl(result?.url ?? '')}.${dialog}`, tabId, forceState: true };
    }

    let result: { url?: string; httpStatus?: number | string; modal?: Modal };
    try {
      result = await this.run(sessionId, tabId, 'navigate', { url: target.url });
    } catch (error) {
      if (error instanceof Error && NAVIGATION_TIMEOUT_TEXT.test(error.message)) {
        throw new MemberError(`Error: Navigation to ${sanitizeUrl(target.url)} timed out after 30 seconds. The page may be unavailable.`);
      }
      throw error;
    }
    const finalUrl = result?.url || target.url;
    const redirectRefusal = checkUrlPolicy(finalUrl, this.config);
    if (redirectRefusal) {
      await this.run(sessionId, tabId, 'navigate', { url: 'about:blank' }).catch(() => undefined);
      throw new MemberError(`Error: ${redirectRefusal} (reached by redirect from ${sanitizeUrl(target.url)})`);
    }
    const dialog = await this.settleDialog(tabId, result);
    const status = Number(result?.httpStatus);
    const statusNote = Number.isFinite(status) && status >= 400 ? ` The server responded with HTTP ${status}.` : '';
    const failed = typeof result?.httpStatus === 'string' && result.httpStatus.startsWith('failed') ? ` The request ${result.httpStatus}.` : '';
    return { text: `Navigated to ${sanitizeUrl(finalUrl)}.${statusNote}${failed}${dialog}`, tabId, forceState: true };
  }

  private async capture(sessionId: SessionId, tabId: TabId, viewportCss: Record<string, unknown>) {
    return this.run<{ data: string; mimeType: string; viewport: { width: number; height: number }; image: { width: number; height: number }; scale: number }>(
      sessionId,
      tabId,
      'screenshot',
      { viewportCss: { maxEdge: this.config.screenshotMaxEdge, ...viewportCss } },
      false,
    );
  }

  private async screenshot(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const shot = await this.capture(sessionId, tabId, {});
    this.screenshotScale.set(tabId, shot.scale);
    return {
      image: { data: shot.data, mimeType: shot.mimeType },
      text: `Screenshot captured (${shot.image.width}x${shot.image.height}).`,
      tabId,
    };
  }

  private async zoom(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const scale = this.screenshotScale.get(tabId) ?? 1;
    const region = (input.region as number[]).map((value) => value / scale);
    const shot = await this.capture(sessionId, tabId, { region, upscale: ZOOM_UPSCALE });
    return {
      image: { data: shot.data, mimeType: shot.mimeType },
      text: `Zoomed into region [${(input.region as number[]).join(', ')}].`,
      tabId,
    };
  }

  private async hover(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const target = input.target as Target;
    const args = target.type === 'ref' ? { target: target.ref, method: 'mouse' } : this.toViewport(tabId, target);
    const result = await this.run(sessionId, tabId, 'hover', args);
    const dialog = await this.settleDialog(tabId, result);
    return { text: `Hovered over ${this.describeTarget(target)}.${dialog}`, tabId };
  }

  private async drag(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const from = input.from as CoordinateTarget;
    const to = input.target as CoordinateTarget;
    const result = await this.run(sessionId, tabId, 'drag', { from: this.toViewport(tabId, from), to: this.toViewport(tabId, to) });
    const dialog = await this.settleDialog(tabId, result);
    return { text: `Dragged from ${this.describeTarget(from)} to ${this.describeTarget(to)}.${dialog}`, tabId };
  }

  private async mouse(sessionId: SessionId, name: 'left_mouse_down' | 'left_mouse_up' | 'mouse_move', input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const target = input.target as CoordinateTarget;
    const action = name === 'left_mouse_down' ? 'down' : name === 'left_mouse_up' ? 'up' : 'move';
    const result = await this.run(sessionId, tabId, 'mouse', { action, ...this.toViewport(tabId, target) });
    const dialog = await this.settleDialog(tabId, result);
    const verb = { down: 'Pressed the left button at', up: 'Released the left button at', move: 'Moved the pointer to' }[action];
    return { text: `${verb} ${this.describeTarget(target)}.${dialog}`, tabId };
  }

  private async scroll(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const target = input.target as CoordinateTarget;
    const amount = Number(input.scroll_amount ?? 3);
    const direction = input.scroll_direction as 'up' | 'down' | 'left' | 'right';
    const delta = amount * SCROLL_NOTCH_PX;
    const deltaX = direction === 'left' ? -delta : direction === 'right' ? delta : 0;
    const deltaY = direction === 'up' ? -delta : direction === 'down' ? delta : 0;
    await this.runtime.sendUnleased('devtools_attach', {}, tabId).catch(() => undefined);
    await this.run(sessionId, tabId, 'scroll', { ...this.toViewport(tabId, target), deltaX, deltaY });
    return { text: `Scrolled ${direction} by ${amount} at ${this.describeTarget(target)}.`, tabId };
  }

  private async scrollTo(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const target = input.target as RefTarget;
    await this.run(sessionId, tabId, 'scroll', { target: target.ref });
    return { text: `Scrolled ${target.ref} into view.`, tabId };
  }

  private async type(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const text = String(input.text);
    const result = await this.run(sessionId, tabId, 'type', { text, atFocus: true });
    const dialog = await this.settleDialog(tabId, result);
    return { text: `Typed ${text.length} character${text.length === 1 ? '' : 's'}.${dialog}`, tabId };
  }

  private async key(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const repeat = Number(input.repeat ?? 1);
    const result = await this.run(sessionId, tabId, 'press_key', { key: String(input.text), sequence: true, repeat });
    const dialog = await this.settleDialog(tabId, result);
    if (!dialog) await this.settleNavigation(tabId);
    const times = repeat > 1 ? ` ${repeat} times` : '';
    return { text: `Pressed ${String(input.text)}${times}.${dialog}`, tabId };
  }

  private async holdKey(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const duration = Number(input.duration);
    const result = await this.run(sessionId, tabId, 'hold_key', { key: String(input.text), durationMs: Math.round(duration * 1000) });
    const dialog = await this.settleDialog(tabId, result);
    return { text: `Held ${String(input.text)} for ${duration} second${duration === 1 ? '' : 's'}.${dialog}`, tabId };
  }

  private async wait(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const session = this.runtime.getSession(sessionId);
    const tabId = input.tab_id != null ? this.resolveTab(sessionId, input.tab_id) : session.activeTabId;
    const duration = Number(input.duration);
    await sleep(duration * 1000);
    return { text: `Waited ${duration} second${duration === 1 ? '' : 's'}.`, tabId };
  }

  private async readPage(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const filter = input.filter as 'interactive' | 'all' | undefined;
    const snap = await this.run<{ snapshot: string; truncated: boolean }>(
      sessionId,
      tabId,
      'snapshot',
      {
        filter: filter === 'interactive' ? 'interactive' : 'all',
        viewportOnly: filter !== 'all',
        depth: Number(input.depth ?? 15),
        target: input.ref ?? undefined,
        maxChars: READ_PAGE_MAX_CHARS,
      },
      false,
    );
    const tree = toClaudeTree(snap.snapshot);
    const note = snap.truncated
      ? `\n\n[Output truncated at ${READ_PAGE_MAX_CHARS.toLocaleString('en-US')} characters. Narrow the read with a smaller depth or a ref.]`
      : '';
    return { text: tree ? `${tree}${note}` : 'No visible elements found. Try filter "all" or scroll.', tabId };
  }

  private async find(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const snap = await this.run<{ snapshot: string }>(sessionId, tabId, 'snapshot', { filter: 'all', maxChars: 2_000_000 }, false);
    const matches = rankElements(toClaudeTree(snap.snapshot), String(input.query));
    return {
      text: matches.length ? matches.map((m) => m.line).join('\n') : `No elements found matching "${truncate(String(input.query), 200)}".`,
      tabId,
    };
  }

  private async pageText(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const page = await this.run<{ title: string; url: string; text: string; truncated: boolean }>(
      sessionId,
      tabId,
      'get_main_text',
      { maxChars: PAGE_TEXT_MAX_CHARS },
      false,
    );
    const note = page.truncated ? `\n\n[Text truncated at ${PAGE_TEXT_MAX_CHARS.toLocaleString('en-US')} characters.]` : '';
    return {
      text: `Title: ${sanitizeTitle(page.title)}\nURL: ${sanitizeUrl(page.url)}\n\n${page.text || '(no visible text)'}${note}`,
      tabId,
    };
  }

  private async formInput(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const target = input.target as RefTarget;
    const value = input.value as string | number | boolean;
    const result = await this.run(sessionId, tabId, 'fill', { target: target.ref, value: typeof value === 'number' ? String(value) : value });
    const dialog = await this.settleDialog(tabId, result);
    return { text: `Set ${target.ref} to ${JSON.stringify(value)}.${dialog}`, tabId };
  }

  private async fileUpload(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const paths = (input.paths as string[] | undefined) ?? [];
    const documentIds = (input.document_ids as string[] | undefined) ?? [];
    if (paths.length + documentIds.length === 0) {
      throw new MemberError('Error: file_upload needs at least one entry in paths or document_ids.');
    }
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const target = input.target as RefTarget;
    const files = await resolveUploadFiles(paths, documentIds, this.config.uploadDir);
    await this.run(sessionId, tabId, 'upload_file', { target: target.ref, paths: files });
    return { text: `Uploaded ${files.length} file${files.length === 1 ? '' : 's'} to ${target.ref}.`, tabId };
  }

  private async readConsole(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const key = `${sessionId}:${tabId}`;
    const afterId = this.consoleCursor.get(key) ?? 0;
    const page = await this.run<{ items: Array<{ type: string; text: string; url?: string }>; lastId: number }>(
      sessionId,
      tabId,
      'console_messages',
      { afterId },
      false,
    );
    this.consoleCursor.set(key, page.lastId ?? afterId);
    if (!page.items.length) {
      return { text: 'No new console messages since the last read.', tabId };
    }
    const lines = page.items.map((m) => {
      const source = m.url ? ` (${sanitizeUrl(m.url)})` : '';
      return truncate(`[${m.type}] ${redactSecrets(m.text)}${source}`, CONSOLE_LINE_MAX);
    });
    return { text: lines.join('\n'), tabId };
  }

  private async readNetwork(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const key = `${sessionId}:${tabId}`;
    const state = this.networkCursor.get(key) ?? { cursor: 0, reported: new Set<number>() };
    const page = await this.run<{
      items: Array<{ reqid: number; method: string; url: string; status: number | string; mimeType?: string; durationMs?: number; done: boolean }>;
    }>(sessionId, tabId, 'network_requests', { afterId: state.cursor }, false);

    const fresh = page.items.filter((r) => !state.reported.has(r.reqid));
    let cursor = state.cursor;
    for (const request of page.items) {
      if (!request.done) break;
      cursor = request.reqid;
    }
    const reported = new Set([...state.reported, ...fresh.filter((r) => r.done).map((r) => r.reqid)].filter((id) => id > cursor));
    this.networkCursor.set(key, { cursor, reported });

    if (!fresh.length) {
      return { text: 'No new network requests since the last read.', tabId };
    }
    const lines = fresh.map((r) => {
      const meta = [r.mimeType, r.durationMs != null ? `${r.durationMs} ms` : null].filter(Boolean).join(', ');
      const url = truncate(sanitizeUrl(r.url), NETWORK_URL_MAX);
      return `${r.method} ${r.done ? r.status : 'pending'} ${url}${meta ? ` (${meta})` : ''}`;
    });
    return { text: lines.join('\n'), tabId };
  }

  private async javascript(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    const code = String(input.text);
    console.error(`logName=claudeJavascriptExec, tabId=${tabId}, codeChars=${code.length}`);
    const result = await this.run<{ result?: unknown; modal?: Modal }>(sessionId, tabId, 'evaluate', { script: code });
    const dialog = await this.settleDialog(tabId, result);
    const value = result?.result;
    const rendered = value === undefined ? 'undefined' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return { text: `${truncate(rendered ?? 'null', JS_RESULT_MAX)}${dialog}`, tabId };
  }

  private async newTab(sessionId: SessionId): Promise<Outcome> {
    const tab = await this.runtime.openTab(sessionId, { url: 'about:blank', active: false });
    this.runtime.events.recordTabOpened(sessionId, tab.tabId);
    return { tabId: tab.tabId };
  }

  private async switchTab(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    this.runtime.sessions.setActiveTab(sessionId, tabId);
    return { tabId };
  }

  private async closeTab(sessionId: SessionId, input: Record<string, unknown>): Promise<Outcome> {
    const tabId = this.resolveTab(sessionId, input.tab_id);
    await this.runtime.closeTab(sessionId, tabId);
    this.screenshotScale.delete(tabId);
    this.consoleCursor.delete(`${sessionId}:${tabId}`);
    this.networkCursor.delete(`${sessionId}:${tabId}`);
    return { tabId: null };
  }
}
