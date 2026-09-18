/**
 * Vite 的 `?inline` 资源导入：把样式表当字符串拿进来，由 theme.ts 按配色
 * 塞进 <style>。tsconfig.web.json 的 types 是空数组（不引 vite/client，避免
 * 把整套 import.meta.env 类型带进渲染进程），所以只在这里声明用到的这一种。
 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}

declare module "*.png" {
  const src: string;
  export default src;
}
