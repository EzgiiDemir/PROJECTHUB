'use client';

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useToast } from '@/components/toast';
import { useMe } from '@/lib/hooks';

/** Which cached queries become stale when a realtime event arrives. */
const INVALIDATES: Record<string, string[]> = {
  'build.updated': ['builds', 'build', 'overview', 'home', 'pullRequest', 'assistant'],
  'pull_request.updated': ['pullRequests', 'pullRequest'],
  'preview.updated': ['previews', 'build', 'overview', 'home', 'assistant'],
  timeline: ['timeline', 'overview', 'team-activity'],
  'project.updated': ['project', 'projects', 'overview', 'manifest', 'home', 'assistant'],
  'repository.updated': ['repo', 'project', 'overview', 'timeline', 'pullRequests', 'team-activity'],
  'feedback.updated': ['feedback', 'feedbackItem', 'overview', 'home', 'reviews'],
  'review.updated': ['reviews', 'review'],
  'review.message': ['reviewMessages'],
  'ai.task.updated': ['aiTasks', 'aiTask', 'home', 'autofix', 'assistant'],
  'deployment.updated': ['deployments', 'deployment', 'environments', 'versions', 'overview', 'home'],
  'security.scan': ['security', 'overview', 'securityCenter', 'project', 'autofixPlan', 'assistant'],
  'responsive.updated': ['responsiveTests', 'responsiveTest'],
  'environment.updated': ['environments'],
  'incident.updated': ['incidents', 'incident'],
  'backup.updated': ['backups'],
  'task.updated': ['tasks', 'home', 'team-board', 'task'],
  'terminal.updated': ['terminal'],
};

/** One EventSource per tab; reconnects automatically (SSE retry). */
export function RealtimeBridge() {
  const qc = useQueryClient();
  const toast = useToast();
  const me = useMe();
  const meId = useRef<string | null>(null);
  meId.current = me.data?.user.id ?? null;
  useEffect(() => {
    const es = new EventSource('/api/v1/stream');
    const pending = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      for (const key of pending) void qc.invalidateQueries({ queryKey: [key] });
      pending.clear();
      timer = null;
    };
    es.addEventListener('event', (msg) => {
      const e = JSON.parse((msg as MessageEvent).data) as { type: string; data?: { branch?: string; message?: string; actor?: string; actorId?: string | null } };
      // Changes made elsewhere (another person, a PC via git or the sync agent, a terminal) are announced once.
      if (e.type === 'repository.updated' && e.data?.message && e.data.actorId !== meId.current) toast(`${e.data.actor ?? 'Biri'} → ${e.data.branch}: ${e.data.message}`);
      for (const k of INVALIDATES[e.type] ?? []) pending.add(k);
      // Coalesce bursts (a build emits many step updates per second).
      if (!timer) timer = setTimeout(flush, 250);
    });
    es.addEventListener('notification', (msg) => {
      const d = JSON.parse((msg as MessageEvent).data) as { title?: string };
      if (d.title) toast(d.title);
      void qc.invalidateQueries({ queryKey: ['notifications'] });
    });
    return () => {
      es.close();
      if (timer) clearTimeout(timer);
    };
  }, [qc, toast]);
  return null;
}
