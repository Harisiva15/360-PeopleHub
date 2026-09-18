import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import type { ReactNode } from 'react';

type Render = ReactNode | ((close: () => void) => ReactNode);

export interface LayerOpts {
  title: ReactNode;
  sub?: ReactNode;
  body: Render;
  /** `null` removes the footer entirely; omitting it gives a plain Close button. */
  footer?: Render | null;
  headExtra?: ReactNode;
  size?: 'narrow' | 'wide' | 'xl';
  /**
   * Called once when the layer goes away, however it goes — a button inside
   * it, the ✕, Escape, or a click on the scrim.
   *
   * Added for a caller that awaits an answer from the layer: without a hook on
   * dismissal, closing the dialog any other way leaves that promise pending
   * forever and the action behind it never finishes. A layer that can be
   * dismissed has to be able to say so.
   */
  onClose?: () => void;
}

interface LayerApi {
  modal: (o: LayerOpts) => void;
  drawer: (o: LayerOpts) => void;
  close: () => void;
}

const Ctx = createContext<LayerApi | null>(null);

interface LayerState extends LayerOpts {
  kind: 'modal' | 'drawer';
}

const resolve = (r: Render, close: () => void): ReactNode => (typeof r === 'function' ? r(close) : r);

export function LayerProvider({ children }: { children: ReactNode }) {
  const [layer, setLayer] = useState<LayerState | null>(null);

  /*
   * The open layer's onClose, held in a ref rather than read off state: close
   * runs during the same tick that clears the state, and reading it from there
   * would sometimes find it already gone. Cleared as it fires, so a second
   * close — Escape landing just after a button, say — cannot call it twice.
   */
  const onClose = useRef<(() => void) | undefined>(undefined);

  const close = useCallback(() => {
    const fn = onClose.current;
    onClose.current = undefined;
    setLayer(null);
    fn?.();
  }, []);

  const api = useMemo<LayerApi>(
    () => ({
      modal: (o) => { onClose.current = o.onClose; setLayer({ ...o, kind: 'modal' }); },
      drawer: (o) => { onClose.current = o.onClose; setLayer({ ...o, kind: 'drawer' }); },
      close,
    }),
    [close],
  );

  useEffect(() => {
    if (!layer) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [layer, close]);

  return (
    <Ctx.Provider value={api}>
      {children}
      {layer && (layer.kind === 'modal' ? renderModal(layer, close) : renderDrawer(layer, close))}
    </Ctx.Provider>
  );
}

function Head({ layer, close }: { layer: LayerState; close: () => void }) {
  return (
    <div className="modal-h">
      <div style={{ flex: 1, minWidth: 0 }}>
        <h3>{layer.title}</h3>
        {layer.sub && <div className="sub">{layer.sub}</div>}
      </div>
      {layer.headExtra}
      <button className="btn ghost icon no-print" onClick={close} aria-label="Close">
        ✕
      </button>
    </div>
  );
}

function renderModal(layer: LayerState, close: () => void) {
  return (
    <div
      className="scrim"
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className={'modal' + (layer.size ? ' ' + layer.size : '')} role="dialog">
        <Head layer={layer} close={close} />
        <div className="modal-b">{resolve(layer.body, close)}</div>
        {layer.footer !== null && (
          <div className="modal-f no-print">
            {layer.footer ? (
              resolve(layer.footer, close)
            ) : (
              <button className="btn" onClick={close}>
                Close
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function renderDrawer(layer: LayerState, close: () => void) {
  return (
    <>
      <div className="scrim" style={{ justifyContent: 'flex-end', padding: 0, alignItems: 'stretch' }} onClick={close} />
      <div className="drawer">
        <Head layer={layer} close={close} />
        <div className="modal-b" style={{ flex: 1 }}>
          {resolve(layer.body, close)}
        </div>
        {layer.footer && <div className="modal-f">{resolve(layer.footer, close)}</div>}
      </div>
    </>
  );
}

export function useLayer(): LayerApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useLayer must be used inside <LayerProvider>');
  return v;
}
