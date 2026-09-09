import { describe, expect, it } from "vitest";

import {
  MCP_CAPABILITY_ID,
  MCP_PERMISSION,
  PI_RESOURCES_CAPABILITY_ID,
  PI_RESOURCES_PERMISSION,
  mcpConfigResource,
  mcpExecutionFingerprintMaterial,
  mcpRunResource,
  parseMcpGrantResource,
  parsePiPackageGrantResource,
  piPackagePermissionResource,
  piPackageSpecIssue,
  projectPermissionPrompt,
  reviewCapabilityGrant,
  type McpServerInput,
} from "../src/index.js";

const WORKSPACE_A = "a".repeat(32);
const WORKSPACE_B = "b".repeat(32);
const FINGERPRINT = "c".repeat(64);

const declared = (capabilityId: string): ReadonlySet<string> => {
  if (capabilityId === PI_RESOURCES_CAPABILITY_ID) return new Set([PI_RESOURCES_PERMISSION]);
  if (capabilityId === MCP_CAPABILITY_ID) return new Set([MCP_PERMISSION]);
  return new Set();
};

describe("Pi package permission resources", () => {
  const specs = [
    "npm:@scope/pkg@1.2.3",
    "git:github.com/acme/tool@v2",
    "https://example.com/tool.git",
    "./本地 包",
    "C:\\Work\\tool",
  ];

  it.each(specs)("round-trips %s", (spec) => {
    const resource = piPackagePermissionResource("install", "project", WORKSPACE_A, spec);
    expect(parsePiPackageGrantResource(resource)).toEqual({
      action: "install",
      scope: "project",
      workspaceId: WORKSPACE_A,
      spec,
    });
    expect(piPackageSpecIssue(spec)).toBeNull();
  });

  it.each(["npm:x;whoami", "git:x&&whoami", "./bad\nname", "./\u202Eevil", "plain-name"])(
    "rejects unsafe spec %s",
    (spec) => expect(piPackageSpecIssue(spec)).not.toBeNull()
  );

  it("separates action, scope, workspace and exact spec", () => {
    const install = piPackagePermissionResource("install", "user", WORKSPACE_A, "npm:a");
    expect(install).not.toBe(
      piPackagePermissionResource("remove", "user", WORKSPACE_A, "npm:a")
    );
    expect(install).not.toBe(
      piPackagePermissionResource("install", "project", WORKSPACE_A, "npm:a")
    );
    expect(install).not.toBe(
      piPackagePermissionResource("install", "user", WORKSPACE_B, "npm:a")
    );
    expect(install).not.toBe(
      piPackagePermissionResource("install", "user", WORKSPACE_A, "npm:b")
    );
  });
});

describe("MCP permission resources", () => {
  const config = (env: Record<string, string>): McpServerInput => ({
    name: "filesystem",
    transport: "stdio",
    command: "node",
    args: ["server.mjs"],
    env,
    headers: {},
    oauth: false,
  });

  it("uses stable material regardless of env key insertion order", () => {
    expect(mcpExecutionFingerprintMaterial(config({ B: "2", A: "1" }))).toBe(
      mcpExecutionFingerprintMaterial(config({ A: "1", B: "2" }))
    );
  });

  it("round-trips run and config resources with workspace and fingerprint", () => {
    expect(parseMcpGrantResource(mcpRunResource(WORKSPACE_A, "project", "fs:one", FINGERPRINT))).toEqual({
      kind: "run",
      workspaceId: WORKSPACE_A,
      scope: "project",
      executionFingerprint: FINGERPRINT,
      name: "fs:one",
    });
    expect(
      parseMcpGrantResource(mcpConfigResource(WORKSPACE_A, "user", "filesystem", FINGERPRINT))
    ).toMatchObject({ kind: "config", workspaceId: WORKSPACE_A, scope: "user" });
  });

  it("rejects malformed, wildcard and visually unsafe resources", () => {
    expect(parseMcpGrantResource("mcp-run:project:filesystem")).toBeNull();
    expect(parseMcpGrantResource(mcpRunResource(WORKSPACE_A, "user", "\u202Eevil", FINGERPRINT))).toBeNull();
  });
});

describe("prompt and persisted-read workspace binding", () => {
  const piResource = piPackagePermissionResource(
    "install",
    "project",
    WORKSPACE_A,
    "npm:@scope/pkg@1.0.0"
  );

  it("projects a matching request and rejects a cross-workspace request", () => {
    expect(
      projectPermissionPrompt({
        capabilityId: PI_RESOURCES_CAPABILITY_ID,
        permission: PI_RESOURCES_PERMISSION,
        resource: piResource,
        workspaceId: WORKSPACE_A,
        command: "pi install npm:@scope/pkg@1.0.0 -l",
      }).resource
    ).toBe(piResource);

    expect(() =>
      projectPermissionPrompt({
        capabilityId: PI_RESOURCES_CAPABILITY_ID,
        permission: PI_RESOURCES_PERMISSION,
        resource: piResource,
        workspaceId: WORKSPACE_B,
      })
    ).toThrow(/工作区.*不一致/);
  });

  it("rejects tampered wildcard and cross-workspace persisted grants", () => {
    const base = {
      capabilityId: PI_RESOURCES_CAPABILITY_ID,
      permission: PI_RESOURCES_PERMISSION,
      resource: piResource,
      grantedAt: 1,
    };
    expect(reviewCapabilityGrant(base, { declaredPermissions: declared, workspaceId: WORKSPACE_A }).ok).toBe(true);
    expect(
      reviewCapabilityGrant({ ...base, resource: null }, { declaredPermissions: declared, workspaceId: WORKSPACE_A }).ok
    ).toBe(false);
    expect(reviewCapabilityGrant(base, { declaredPermissions: declared, workspaceId: WORKSPACE_B }).ok).toBe(false);
  });
});
