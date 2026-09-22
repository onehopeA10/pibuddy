#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function validateReleaseTarget({ channel, tag, version }) {
  if (channel !== "stable") return;
  if (!/^v\d+\.\d+\.\d+$/.test(tag ?? "")) {
    throw new Error("stable 发布必须指定已有的 vX.Y.Z 版本 tag，不能使用分支名");
  }
  if (tag !== `v${version}`) {
    throw new Error(`发布 tag ${tag} 与 package.json 版本 ${version} 不一致`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const { version } = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  validateReleaseTarget({ channel: process.env.RELEASE_CHANNEL, tag: process.env.RELEASE_TAG, version });
  console.log("release target: OK");
}
