import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { findResourceDirs } from "../scripts/verify-packaged-app.mjs";

const require = createRequire(import.meta.url);
const { resolveResourcesDir } = require("../scripts/after-pack.cjs") as {
  resolveResourcesDir: (context: {
    appOutDir: string;
    electronPlatformName: string;
    packager?: { appInfo?: { productFilename?: string } };
  }) => string;
};

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pibuddy-pack-"));
}

describe("afterPack 资源目录", () => {
  it("win/linux 写到 appOutDir/resources", () => {
    const dir = makeTmp();
    expect(
      resolveResourcesDir({ appOutDir: dir, electronPlatformName: "win32" }),
    ).toBe(path.join(dir, "resources"));
    expect(
      resolveResourcesDir({ appOutDir: dir, electronPlatformName: "linux" }),
    ).toBe(path.join(dir, "resources"));
  });

  it("darwin 写到 .app/Contents/Resources，不写到旁边的空壳 resources/", () => {
    const dir = makeTmp();
    const appRes = path.join(dir, "PiBuddy.app", "Contents", "Resources");
    fs.mkdirSync(appRes, { recursive: true });
    fs.mkdirSync(path.join(dir, "resources"), { recursive: true });
    expect(
      resolveResourcesDir({
        appOutDir: dir,
        electronPlatformName: "darwin",
        packager: { appInfo: { productFilename: "PiBuddy" } },
      }),
    ).toBe(appRes);
  });
});

describe("verify-packaged-app 找 resources", () => {
  it("mac 优先认 .app，即使旁边有误写的 resources/", () => {
    const out = makeTmp();
    const mac = path.join(out, "mac-arm64");
    const appRes = path.join(mac, "PiBuddy.app", "Contents", "Resources");
    fs.mkdirSync(appRes, { recursive: true });
    fs.mkdirSync(path.join(mac, "resources"), { recursive: true });
    const found = findResourceDirs(out);
    expect(found).toEqual([{ label: "mac-arm64/PiBuddy.app", dir: appRes }]);
  });

  it("win/linux unpacked 仍认扁平 resources", () => {
    const out = makeTmp();
    const winRes = path.join(out, "win-unpacked", "resources");
    fs.mkdirSync(winRes, { recursive: true });
    const found = findResourceDirs(out);
    expect(found).toEqual([{ label: "win-unpacked", dir: winRes }]);
  });
});
