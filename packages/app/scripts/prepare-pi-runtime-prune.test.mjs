import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { measureRuntimeBytes, pruneRuntime, shouldPrune } from "./prepare-pi-runtime-prune.mjs";

test("shouldPrune keeps entry and manifest", () => {
  assert.equal(shouldPrune("dist/cli.js", "win32"), false);
  assert.equal(shouldPrune("runtime-manifest.json", "win32"), false);
  assert.equal(shouldPrune("package.json", "win32"), false);
});

test("shouldPrune drops docs, tests, maps, wrong-platform natives", () => {
  assert.equal(shouldPrune("docs/readme.md", "win32"), true);
  assert.equal(shouldPrune("node_modules/foo/test/a.js", "win32"), true);
  assert.equal(shouldPrune("dist/cli.js.map", "win32"), true);
  assert.equal(shouldPrune("node_modules/x/prebuilds/darwin-x64/n.node", "win32"), true);
  assert.equal(shouldPrune("node_modules/x/prebuilds/win32-x64/n.node", "win32"), false);
});

test("pruneRuntime deletes junk and keeps cli.js; realpath size is finite", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-runtime-prune-"));
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.mkdirSync(path.join(root, "node_modules", "x", "prebuilds", "darwin-x64"), { recursive: true });
  fs.writeFileSync(path.join(root, "dist", "cli.js"), "#!/usr/bin/env node\n");
  fs.writeFileSync(path.join(root, "dist", "cli.js.map"), '{"version":3}');
  fs.writeFileSync(path.join(root, "docs", "guide.md"), "# docs");
  fs.writeFileSync(path.join(root, "runtime-manifest.json"), "{}");
  fs.writeFileSync(path.join(root, "node_modules", "x", "prebuilds", "darwin-x64", "n.node"), "bin");

  const removed = pruneRuntime(root, "win32");
  assert.ok(removed.some((r) => r.endsWith("cli.js.map")));
  assert.ok(removed.some((r) => r.includes("docs/")));
  assert.ok(removed.some((r) => r.includes("darwin-x64")));
  assert.ok(fs.existsSync(path.join(root, "dist", "cli.js")));
  assert.ok(fs.existsSync(path.join(root, "runtime-manifest.json")));
  assert.ok(!fs.existsSync(path.join(root, "dist", "cli.js.map")));

  const bytes = measureRuntimeBytes(root);
  assert.ok(bytes > 0);
  fs.rmSync(root, { recursive: true, force: true });
});
