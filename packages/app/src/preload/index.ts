/**
 * preload 入口。**只做一件事**：把 api 挂到 window.piBuddy 上。
 *
 * 接口面的定义全部在 `./api/`，每个命名空间一个文件；类型由 index.d.ts
 * 从 `typeof api` 推导，因此实现与类型不可能漂移。
 */
import { contextBridge } from "electron";
import { api } from "./api/index.js";

contextBridge.exposeInMainWorld("piBuddy", api);
