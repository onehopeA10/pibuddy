import { createApp } from "vue";
import { createPinia } from "pinia";
import App from "./App.vue";
import "./styles.css";
import { applyTheme, readCachedTheme } from "./theme";

// 挂载前先按缓存值上色，避免浅色用户每次启动先闪一帧深色；
// 真值随后由 App.vue 监听 settings.theme 覆盖。
applyTheme(readCachedTheme());

const app = createApp(App);
app.use(createPinia());
app.mount("#app");
