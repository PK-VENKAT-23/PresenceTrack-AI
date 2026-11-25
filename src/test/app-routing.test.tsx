import { QueryClient } from "@tanstack/react-query";
import { createRouter, rootRouteId } from "@tanstack/react-router";
import { describe, expect, it } from "vitest";

import { routeTree } from "@/routeTree.gen";

// Match routes without running loaders or rendering: loaders may need a server or
// network the test run lacks, and jsdom never loads the stylesheets React waits on.
describe("App routing", () => {
  it("matches a page for / instead of falling back to not found", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const matches = router.matchRoutes("/");

    expect(matches.at(-1)?.routeId).not.toBe(rootRouteId);
  });

  it("matches dedicated auth and public utility routes", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    expect(router.matchRoutes("/login").at(-1)?.routeId).toBe("/login");
    expect(router.matchRoutes("/recovery").at(-1)?.routeId).toBe("/recovery");
    expect(router.matchRoutes("/reset-password").at(-1)?.routeId).toBe("/reset-password");
    expect(router.matchRoutes("/unauthorized").at(-1)?.routeId).toBe("/unauthorized");
  });

  it("matches each of the four role-based enclave console routes", () => {
    const router = createRouter({ routeTree, context: { queryClient: new QueryClient() } });

    const employeeMatches = router.matchRoutes("/enclave/employee");
    expect(employeeMatches.some((m) => m.routeId.includes("employee"))).toBe(true);

    const hrMatches = router.matchRoutes("/enclave/hr");
    expect(hrMatches.some((m) => m.routeId.includes("hr"))).toBe(true);

    const securityMatches = router.matchRoutes("/enclave/security");
    expect(securityMatches.some((m) => m.routeId.includes("security"))).toBe(true);

    const adminMatches = router.matchRoutes("/enclave/admin");
    expect(adminMatches.some((m) => m.routeId.includes("admin"))).toBe(true);
  });
});
