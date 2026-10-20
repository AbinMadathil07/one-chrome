import { EventEmitter } from 'node:events';
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import type { HostConfig } from '../config.js';
import type { BridgeCommandName, BridgeRequest, TabSnapshot } from '../types.js';
import {
  bridgeInboundSchema,
  downloadPayloadSchema,
  tabCreatedPayloadSchema,
  type DownloadPayload,
  type TabCreatedPayload,
} from './protocol.js';

const REPLACED_CLOSE_CODE = 4001;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

export type ExtensionBridgeEvents = {
  ready: [];
  disconnected: [];
  tab_removed: [number];
  tabs_changed: [TabSnapshot[]];
  tab_created: [TabCreatedPayload];
  download: [DownloadPayload];
};

export class ExtensionBridge extends EventEmitter {
  private httpServer: HttpServer | null = null;
  private wss: WebSocketServer | null = null;
  private socket: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private ready = false;

  constructor(private readonly config: HostConfig) {
    super();
  }

  async start(): Promise<void> {
    if (this.httpServer) {
      return;
    }

    this.httpServer = createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            ok: true,
            bridgeConnected: this.isConnected(),
            ready: this.ready,
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end('Not found');
    });

    this.wss = new WebSocketServer({ server: this.httpServer, path: '/bridge' });
    this.wss.on('connection', (socket, req) => this.onConnection(socket, req));

    await new Promise<void>((resolve, reject) => {
      this.httpServer!.once('error', reject);
      this.httpServer!.listen(this.config.bridgePort, this.config.host, () => resolve());
    });
  }

  async stop(): Promise<void> {
    this.rejectPending('Bridge shutting down');

    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    await new Promise<void>((resolve) => {
      if (!this.wss) {
        resolve();
        return;
      }
      this.wss.close(() => resolve());
    });
    this.wss = null;

    await new Promise<void>((resolve, reject) => {
      if (!this.httpServer) {
        resolve();
        return;
      }
      this.httpServer.close((error) => (error ? reject(error) : resolve()));
    });
    this.httpServer = null;
    this.ready = false;
  }

  isConnected(): boolean {
    return this.socket != null && this.socket.readyState === this.socket.OPEN && this.ready;
  }

  async sendCommand(
    command: BridgeCommandName,
    args: Record<string, unknown> = {},
    tabId?: number,
  ): Promise<unknown> {
    if (!this.isConnected()) {
      throw new Error(
        'Chrome extension is not connected. Load the ./extension folder in chrome://extensions and click Connect in its popup.',
      );
    }

    const id = randomUUID();
    const request: BridgeRequest = {
      id,
      type: 'command',
      command,
      tabId,
      args,
    };

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Bridge command timed out: ${command}`));
      }, this.config.commandTimeoutMs);

      this.pending.set(id, { resolve, reject, timer });
      this.socket!.send(JSON.stringify(request));
    });
  }

  private onConnection(socket: WebSocket, req: IncomingMessage): void {
    if (this.config.authToken) {
      const url = new URL(req.url ?? '/', `http://${this.config.host}`);
      const token = url.searchParams.get('token') || req.headers['x-chrome-mcp-token'];
      if (token !== this.config.authToken) {
        socket.close(1008, 'Unauthorized');
        return;
      }
    }

    const previous = this.socket;
    this.socket = socket;
    if (previous && previous.readyState === previous.OPEN) {
      // Newest wins: an extension reload or browser restart must not be locked out by a stale socket.
      console.error('logName=bridgeConnectionReplaced');
      this.rejectPending('Extension connection was replaced by a newer one');
      previous.close(REPLACED_CLOSE_CODE, 'Replaced by a newer browser connection');
    }
    this.ready = false;

    socket.on('message', (data) => this.onMessage(String(data)));
    socket.on('close', () => {
      if (this.socket === socket) {
        this.socket = null;
        this.ready = false;
        this.rejectPending('Extension disconnected');
        this.emit('disconnected');
      }
    });
  }

  private rejectPending(reason: string): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
      this.pending.delete(id);
    }
  }

  private onMessage(raw: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const message = bridgeInboundSchema.safeParse(parsed);
    if (!message.success) {
      return;
    }

    if (message.data.type === 'event') {
      if (message.data.event === 'extension_ready') {
        this.ready = true;
        this.emit('ready');
      }
      if (message.data.event === 'tab_removed') {
        const tabId = Number((message.data.payload as { tabId?: number } | undefined)?.tabId);
        if (Number.isFinite(tabId)) {
          this.emit('tab_removed', tabId);
        }
      }
      if (message.data.event === 'tabs_changed') {
        this.emit('tabs_changed', (message.data.payload as TabSnapshot[]) ?? []);
      }
      if (message.data.event === 'tab_created') {
        const payload = tabCreatedPayloadSchema.safeParse(message.data.payload);
        if (payload.success) this.emit('tab_created', payload.data);
      }
      if (message.data.event === 'download') {
        const payload = downloadPayloadSchema.safeParse(message.data.payload);
        if (payload.success) this.emit('download', payload.data);
      }
      return;
    }

    const pending = this.pending.get(message.data.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timer);
    this.pending.delete(message.data.id);
    if (message.data.type === 'result') {
      pending.resolve(message.data.result);
    } else {
      pending.reject(new Error(message.data.error));
    }
  }
}
