import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { injectTheme } from '@aws-blocks/blocks/ui';
import { App } from './App';

injectTheme();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
