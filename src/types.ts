import type { Report } from './core/types';

export type JobStatus = 'analyzing' | 'ready' | 'error';

export interface OptimizeOutput {
  bytes: Uint8Array;
  name: string;
  notes: string[];
  before: number;
  after: number;
  kind: 'compress' | 'raster';
  dpi?: number;
  savedPath?: string;
}

export interface Job {
  id: string;
  name: string;
  size: number;
  path?: string;
  bytes: Uint8Array;
  status: JobStatus;
  progress?: { done: number; total: number; label: string };
  report?: Report;
  error?: string;
  output?: OptimizeOutput;
  action?: string | null;
}

export const VERDICT_LABEL: Record<'ok' | 'check' | 'ko', string> = {
  ok: 'Conforme',
  check: 'À vérifier',
  ko: 'Non conforme',
};
