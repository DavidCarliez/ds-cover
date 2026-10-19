import { createElement } from 'react';

// Test-only stand-in for the native modal primitive. It keeps the public
// open/onClose/title contract so plugin behavior is exercised unchanged.
export function Modal({ open, onClose, title, description, children, closeLabel = 'Close' }) {
  if (!open) return null;
  return createElement('div', { role: 'dialog', 'aria-label': title },
    createElement('button', { type: 'button', 'aria-label': closeLabel, onClick: onClose }, '×'),
    description ? createElement('p', null, description) : null,
    children,
  );
}
