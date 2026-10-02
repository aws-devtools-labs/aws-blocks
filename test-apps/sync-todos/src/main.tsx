// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createRoot } from 'react-dom/client';
import { App } from './App.js';

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
