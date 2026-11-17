import en from "./locales/en.json";
import zhCN from "./locales/zh-CN.json";

const SCENE_I18N_ID = "LayaAirStandaloneMcpScene";

export type McpSceneTranslationKey = keyof typeof en;
export let t: gui.Translations["t"];

export function initializeSceneI18n(): void {
    const translations = gui.Translations.create(SCENE_I18N_ID, "en");
    translations
        .setContent("en", en)
        .setContent("zh-CN", zhCN);
    t = translations.t.bind(translations);
}
