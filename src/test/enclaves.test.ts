import { describe, expect, it } from "vitest";
import { canAccessEnclave, enclavePathFor } from "@/lib/enclaves";
import { merkleProof, merkleRoot, verifyMerkleProof } from "@/lib/merkle";
import { constantTimeEqual, rejectUnlessDevice } from "@/lib/device-key";

describe("strict enclave isolation", () => {
  it("sends each role to its own console", () => {
    expect(enclavePathFor("employee")).toBe("/enclave/employee");
    expect(enclavePathFor("hr_ops")).toBe("/enclave/hr");
    expect(enclavePathFor("security")).toBe("/enclave/security");
    expect(enclavePathFor("super_admin")).toBe("/enclave/admin");
  });

  it("blocks cross-role navigation", () => {
    expect(canAccessEnclave("employee", "hr")).toBe(false);
    expect(canAccessEnclave("hr_ops", "security")).toBe(false);
    expect(canAccessEnclave("security", "admin")).toBe(false);
    expect(canAccessEnclave("super_admin", "employee")).toBe(false);
    expect(canAccessEnclave("super_admin", "admin")).toBe(true);
  });

  it("strictly denies access to any enclave for null or undefined roles", () => {
    expect(enclavePathFor(null)).toBe("/unauthorized");
    expect(enclavePathFor(undefined)).toBe("/unauthorized");
    expect(canAccessEnclave(null, "employee")).toBe(false);
    expect(canAccessEnclave(null, "hr")).toBe(false);
    expect(canAccessEnclave(null, "security")).toBe(false);
    expect(canAccessEnclave(null, "admin")).toBe(false);
    expect(canAccessEnclave(undefined, "employee")).toBe(false);
    expect(canAccessEnclave(undefined, "hr")).toBe(false);
    expect(canAccessEnclave(undefined, "security")).toBe(false);
    expect(canAccessEnclave(undefined, "admin")).toBe(false);
  });
});

describe("merkle ledger", () => {
  it("verifies inclusion proofs for every leaf and rejects tampering", async () => {
    const txs = ["a", "b", "c", "d", "e"];
    const root = await merkleRoot(txs);
    for (let i = 0; i < txs.length; i++) {
      expect(await verifyMerkleProof(txs[i]!, await merkleProof(txs, i), root)).toBe(true);
    }
    expect(await verifyMerkleProof("x", await merkleProof(txs, 0), root)).toBe(false);
  });
});

describe("ESP32 device key", () => {
  it("rejects missing or wrong keys and accepts the configured key", () => {
    const req = (key?: string) =>
      new Request("http://x", { method: "POST", headers: key ? { "x-device-key": key } : {} });
    expect(rejectUnlessDevice(req(), "secret")?.status).toBe(401);
    expect(rejectUnlessDevice(req("wrong"), "secret")?.status).toBe(401);
    expect(rejectUnlessDevice(req("secret"), undefined)?.status).toBe(503);
    expect(rejectUnlessDevice(req("secret"), "secret")).toBeNull();
    expect(constantTimeEqual("abc", "abcd")).toBe(false);
  });
});
