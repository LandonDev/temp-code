import './assets/main.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { applyTheme, storedTheme, useApp } from './state/store'

// Appearance: the stored preference wins; 'system' follows the OS live.
applyTheme(storedTheme())
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  applyTheme(useApp.getState().theme)
})

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
