/** Where the console talks to. The dev server proxies both to the API (proxy.conf.json). */
export const environment = {
  apiBase: "/api",
  websocketPath: "/ws",
  /** The Demo Movie is the only production the free demo ships with (TESTING.md §3). */
  defaultProductionId: "PROD-DEMO",
} as const;
