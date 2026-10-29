import '@xyflow/react/dist/style.css';
import './styles.css';
import './canvas.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';

// The shared workflow package uses Buffer in base64 helpers; provide a tiny browser version.
if (!(globalThis as { Buffer?: unknown }).Buffer) {
  (globalThis as { Buffer?: unknown }).Buffer = {
    from: (s: string, enc?: string) => ({
      toString: (out?: string) => {
        if (enc === 'base64') return decodeURIComponent(escape(atob(s)));
        if (out === 'base64') return btoa(unescape(encodeURIComponent(s)));
        return s;
      },
    }),
  };
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
