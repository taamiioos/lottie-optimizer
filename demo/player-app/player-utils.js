import {$, formatSize} from '../common/common.js';

// Устанавливает значение и подпись прогресс-бара
export const setProgress = (pct, text) => {
    $('progressFill').style.width = pct + '%';
    $('progressLabel').textContent = text;
};
// Помечает зону загрузки
export const markZoneLoaded = (filename, size) => {
    $('zoneJson').classList.add('loaded');
    const hint = $('jsonHint');
    hint.className = 'pl-zone-file';
    hint.textContent = filename;
    const sizeEl = $('jsonSize');
    sizeEl.textContent = formatSize(size);
    sizeEl.style.display = '';
};
// Сбрасывает зону загрузки в исходное состояние
export const resetZone = () => {
    $('zoneJson').classList.remove('loaded', 'drag');
    const hint = $('jsonHint');
    hint.className = 'pl-zone-hint';
    hint.textContent = 'animation.json / .lottie';
    $('jsonSize').style.display = 'none';
};
// Инициализирует drag-and-drop и клик для зоны загрузки файлов
export const setupZone = (zoneId, inputId, onFile) => {
    const zone = $(zoneId);
    const input = $(inputId);
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => {
        e.preventDefault();
        zone.classList.add('drag');
    });
    zone.addEventListener('dragleave', (e) => {
        if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag');
    });
    zone.addEventListener('drop', (e) => {
        e.preventDefault();
        zone.classList.remove('drag');
        if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]);
    });
    input.addEventListener('change', (e) => {
        if (e.target.files[0]) onFile(e.target.files[0]);
        e.target.value = '';
    });
};
// Показывает строку статуса совместимости файла
export const showCompatStatus = (type, message) => {
    const el = $('compatStatus');
    const icon = {ok: '✓', warn: '⚠', error: '✗'}[type] || '';
    el.className = `pl-compat-status pl-compat-${type}`;
    el.textContent = `${icon} ${message}`;
};
// Скрывает строку статуса совместимости
export const clearCompatStatus = () => {
    const el = $('compatStatus');
    el.className = 'pl-compat-status';
    el.textContent = '';
};

