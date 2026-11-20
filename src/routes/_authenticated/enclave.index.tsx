import { createFileRoute, redirect } from "@tanstack/react-router";
import { enclavePathFor } from "@/lib/enclaves";

export const Route = createFileRoute("/_authenticated/enclave/")({
  beforeLoad: ({ context }) => {
    if (!context.role) {
      throw redirect({ to: "/unauthorized", search: { reason: "no_role" }, replace: true });
    }
    throw redirect({ to: enclavePathFor(context.role), replace: true });
  },
});
