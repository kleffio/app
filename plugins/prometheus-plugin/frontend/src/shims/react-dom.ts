const ReactDOM = (globalThis as any).__kleff__?.ReactDOM ?? {};
export const { createPortal, render, unmountComponentAtNode, flushSync } = ReactDOM;
export default ReactDOM;
