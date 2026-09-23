import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
/* The agent workspace: status, activity, plan, skills, task history. Its own
   file rather than 250 more lines in styles.css — one feature, one sheet. */
import './experience.css';
/* The ROBOTIC theme (Preferences). Every rule is scoped to
   :root[data-theme="robotic"], so it is inert while Black is selected. */
import './theme-robotic.css';
import { installClientLogging } from './logging.js';
import { applyTheme, currentTheme } from './theme.js';

// Before render, so a failure during the first paint is still captured.
installClientLogging();

// Before render, so the first paint is already in the chosen theme.
applyTheme(currentTheme());

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
