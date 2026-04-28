const sdk = (globalThis as any).__kleff__ ?? {};
export const { definePlugin, PluginCtx, usePluginContext } = sdk;
