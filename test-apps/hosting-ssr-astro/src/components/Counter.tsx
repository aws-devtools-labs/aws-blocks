// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
//
// An INTERACTIVE island (Preact). Ships JavaScript and hydrates in the
// browser ONLY when rendered with a `client:*` directive. Without a
// directive it renders to static HTML and ships zero JS.
import { useState } from 'preact/hooks';

interface Props {
  label: string;
  testid: string;
}

export default function Counter({ label, testid }: Props) {
  const [count, setCount] = useState(0);
  return (
    <div
      data-testid={testid}
      style={{
        border: '1px solid #888',
        borderRadius: '6px',
        padding: '0.75rem 1rem',
        marginBottom: '0.75rem',
      }}
    >
      <p style={{ margin: '0 0 0.5rem' }}>
        <strong>{label}</strong>
      </p>
      <button data-testid={`${testid}-btn`} onClick={() => setCount((c) => c + 1)}>
        clicked <span data-testid={`${testid}-value`}>{count}</span> times
      </button>
    </div>
  );
}
