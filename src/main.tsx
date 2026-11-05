import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App';
import './index.css';
import { log } from './lib/log';

registerSW({
  immediate: true,
  onRegisteredSW: () => log.info('sw', 'service worker registered'),
  onRegisterError: (e) => log.error('sw', 'registration failed', String(e)),
});

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
