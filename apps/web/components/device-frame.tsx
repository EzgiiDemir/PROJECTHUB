'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

export interface FrameDevice {
  key: string;
  name: string;
  category: 'phone' | 'tablet' | 'desktop';
  width: number;
  height: number;
}

/** Messages posted by the bridge script the preview gateway injects into every preview page. */
export type BridgeMessage =
  | { type: 'nav'; path: string; title: string; scrollY: number; width: number; height: number }
  | { type: 'scroll'; scrollY: number }
  | { type: 'picked'; requestId: string; selector: string; x: number; y: number; scrollY: number; path: string; text: string }
  | { type: 'console'; level: 'error' | 'warn' | 'log' | 'info'; message: string; at: number }
  | { type: 'network'; method: string; url: string; status: number; ms: number; error?: string; size?: number; kind?: 'fetch' | 'xhr' }
  | { type: 'perf'; ttfb: number; fcp: number | null; domReady: number; load: number; requests: number; transferKb: number; domNodes: number }
  | { type: 'throttle'; profile: string | null };

/** Listens to bridge messages from one iframe (checked by source window and origin) and lets callers post commands. */
export function useBridge(frame: RefObject<HTMLIFrameElement | null>, origin: string | null, onMessage: (m: BridgeMessage) => void) {
  const handler = useRef(onMessage);
  useLayoutEffect(() => {
    handler.current = onMessage;
  });
  useEffect(() => {
    if (!origin) return;
    const h = (e: MessageEvent) => {
      if (e.origin !== origin || e.source !== frame.current?.contentWindow) return;
      const d = e.data as ({ ph?: boolean } & BridgeMessage) | null;
      if (d && d.ph) handler.current(d);
    };
    window.addEventListener('message', h);
    return () => window.removeEventListener('message', h);
  }, [frame, origin]);
  return useCallback(
    (msg: Record<string, unknown>) => {
      if (origin) frame.current?.contentWindow?.postMessage({ ph: true, ...msg }, origin);
    },
    [frame, origin],
  );
}

/**
 * Renders a page inside a device frame at the device's CSS viewport size, scaled down to fit the stage.
 * The iframe keeps the real viewport width so the previewed site's media queries behave as on the device.
 */
export function DeviceFrame({
  device,
  landscape,
  src,
  frameRef,
  overlay,
  maxWidth,
  maxHeight = 720,
  title,
  zoom = 'fit',
  touch,
}: {
  device: FrameDevice;
  landscape?: boolean;
  src: string | null;
  frameRef: RefObject<HTMLIFrameElement | null>;
  overlay?: ReactNode;
  maxWidth?: number;
  maxHeight?: number;
  title: string;
  /** 'fit' scales the device into the stage; a number is a fixed zoom (1 = real CSS pixels). */
  zoom?: 'fit' | number;
  /** Touch devices: a finger-sized cursor instead of the mouse pointer. */
  touch?: boolean;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const [avail, setAvail] = useState(maxWidth ?? 900);
  useEffect(() => {
    const el = stage.current?.parentElement;
    if (!el) return;
    const ro = new ResizeObserver(() => setAvail(Math.max(240, el.clientWidth - 48)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const rotate = landscape && device.category !== 'desktop';
  const w = rotate ? device.height : device.width;
  const h = rotate ? device.width : device.height;
  const pad = device.category === 'phone' ? 24 : device.category === 'tablet' ? 32 : 20;
  const viewH = device.category === 'desktop' ? Math.min(h, 900) : h;
  const fit = Math.min(1, (Math.min(avail, maxWidth ?? Infinity) - pad) / w, (maxHeight - pad) / viewH);
  const scale = zoom === 'fit' ? fit : zoom;
  const cls = device.category === 'phone' ? 'device' : device.category === 'tablet' ? 'device tablet' : 'device desk';
  return (
    <div ref={stage}>
      <div className={cls} style={{ width: w * scale + pad }}>
      {device.category === 'phone' && !rotate && <div className="notch" />}
      <div className={`scr frame-wrap${touch ? ' touch' : ''}`} style={{ width: w * scale, height: viewH * scale }}>
        {src ? (
          <iframe ref={frameRef} src={src} title={title} style={{ width: w, height: viewH, transform: `scale(${scale})` }} sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals allow-downloads" />
        ) : (
          <div style={{ display: 'grid', placeItems: 'center', height: '100%', color: '#69737d', fontSize: 11 }}>
            <span className="spinner" />
          </div>
        )}
        {overlay}
        {device.category === 'phone' && <div className="home-bar" />}
      </div>
      </div>
      <div className="small muted" style={{ textAlign: 'center', marginTop: 8 }}>
        {device.name} · {w}×{h}
        {scale < 1 ? ` · %${Math.round(scale * 100)}` : ''}
      </div>
    </div>
  );
}
