// Сокращение для document.getElementById
export const $ = id => document.getElementById(id);
// Тема
const THEME_KEY = 'lo-theme';
const ICON_SUN = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="4"/>
  <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>
</svg>`;
const ICON_MOON = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/>
</svg>`;
// Применяет тему и обновляет иконку кнопки
export const applyTheme = (theme) => {
    document.body.classList.toggle('light', theme === 'light');
    const btn = document.getElementById('themeToggle');
    if (btn) btn.innerHTML = theme === 'light' ? ICON_MOON : ICON_SUN;
};
// Инициализирует тему из localStorage или системных предпочтений
export const initTheme = () => applyTheme(localStorage.getItem(THEME_KEY) || window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
// Переключает тему и сохраняет в localStorage
export const toggleTheme = () => {
    const isLight = document.body.classList.contains('light');
    const next = isLight ? 'dark' : 'light';
    localStorage.setItem(THEME_KEY, next);
    applyTheme(next);
};
// Форматирует количество байт в читаемую строку
export const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    return parseFloat((bytes / Math.pow(1024, i)).toFixed(2)) + ' ' + sizes[i];
};
// Форматирует миллисекунды в читаемую строку
export const fmtTime = (ms) => {
    if (ms < 1000) return ms.toFixed(0) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
};
// Строит HTML-строку одной записи статистики в стиле дерева
export const statRow = (pfx, key, val, cls = '') =>
    `<div class="rtRow">
        <span class="rtPfx">${pfx}</span>
        <span class="rtKey">${key}</span>
        <span class="rtVal${cls ? ' ' + cls : ''}">${val}</span>
    </div>`;
// Инициирует скачивание Blob-файла в браузере
export const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
};
