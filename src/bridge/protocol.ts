import { z } from 'zod';

export const bridgeResultSchema = z.object({
  id: z.string(),
  type: z.literal('result'),
  ok: z.literal(true),
  result: z.unknown().optional(),
});

export const bridgeErrorSchema = z.object({
  id: z.string(),
  type: z.literal('error'),
  ok: z.literal(false),
  error: z.string(),
});

export const bridgeEventSchema = z.object({
  type: z.literal('event'),
  event: z.enum([
    'extension_ready',
    'tab_created',
    'tab_updated',
    'tab_removed',
    'tabs_changed',
    'heartbeat',
    'download',
  ]),
  payload: z.unknown().optional(),
});

export const tabCreatedPayloadSchema = z.object({
  tabId: z.number().int(),
  openerTabId: z.number().int(),
  url: z.string().default(''),
});
export type TabCreatedPayload = z.infer<typeof tabCreatedPayloadSchema>;

export const downloadPayloadSchema = z.object({
  id: z.number().int(),
  state: z.enum(['in_progress', 'interrupted', 'complete']),
  url: z.string(),
  referrer: z.string().default(''),
  filename: z.string().default(''),
  fileSize: z.number().int().nonnegative().optional(),
  error: z.string().optional(),
});
export type DownloadPayload = z.infer<typeof downloadPayloadSchema>;

export const bridgeInboundSchema = z.union([
  bridgeResultSchema,
  bridgeErrorSchema,
  bridgeEventSchema,
]);
