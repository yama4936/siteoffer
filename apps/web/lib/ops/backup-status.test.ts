import { expect, it } from "vitest";
import { parseBackupRuntimeStatus } from "./backup-status";

const idle = { available: true, busy: false, operation: null, phase: null, startedAt: null, files: 0 };
it("accepts idle, waiting, copying and verifying states without forwarding extra fields", () => {
  expect(parseBackupRuntimeStatus({ ...idle, token: "must not forward" })).toEqual(idle);
  for (const phase of ["waiting", "snapshot", "files", "encrypt", "verify"]) {
    const state = { ...idle, busy: true, operation: "backup", phase, startedAt: new Date().toISOString(), files: 5 };
    expect(parseBackupRuntimeStatus(state)).toEqual(state);
  }
});
it("rejects malformed polling data rather than enabling the controls", () => {
  for (const value of [
    null,
    {},
    { ...idle, available: "true" },
    { ...idle, busy: 1 },
    { ...idle, files: -1 },
    { ...idle, files: 1.5 },
    { ...idle, phase: "delete" },
    { ...idle, operation: "stop" },
    { ...idle, startedAt: "invalid" },
    { ...idle, phase: "verify" },
  ])
    expect(parseBackupRuntimeStatus(value)).toBeNull();
});
