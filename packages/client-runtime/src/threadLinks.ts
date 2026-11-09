// exowatt: app-owned routes that also happen to have two path segments. The desktop window must
// leave them to the router rather than treat them as `<environment>/<thread>` thread routes.
// (P3's own `resolveThreadLink` is gone: upstream's thread-link parser reads `p3://thread/<id>`.)
const NON_THREAD_APPLICATION_ROUTE_ROOTS = new Set([
  "agents",
  "changelog",
  "connect",
  "customize",
  "draft",
  "pair",
  "projects",
  "pull-requests",
  "settings",
  "usage",
  "welcome",
]);

export function isNonThreadApplicationRouteRoot(root: string): boolean {
  return NON_THREAD_APPLICATION_ROUTE_ROOTS.has(root.toLowerCase());
}
