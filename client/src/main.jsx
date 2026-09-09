import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './styles.css';
/* The agent workspace: status, activity, plan, skills, task history. Its own
   file rather than 250 more lines in styles.css — one feature, one sheet. */
import './experience.css';
import { installClientLogging } from './logging.js';

// Before render, so a failure during the first paint is still captured.
installClientLogging();

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
