import {$, formatSize} from '../common/common.js';

/** Sets the progress bar width and label text */
export const setProgress = (pct, text) => {
    $('progressFill').style.width = pct + '%';
    $('progressLabel').textContent = text;
};

/**
 * Marks the drop zone as loaded
 */
export const markZoneLoaded = (filename, size) => {
    $('zoneJson').classList.add('loaded');
    const hint = $('jsonHint');
    hint.className = 'pl-zone-file';
    hint.textContent = filename;
    const sizeEl = $('jsonSize');
    sizeEl.textContent = formatSize(size);
    sizeEl.style.display = '';
};

/** Resets the drop zone back to its empty/initial state */
export const resetZone = () => {
    $('zoneJson').classList.remove('loaded', 'drag');
    const hint = $('jsonHint');
    hint.className = 'pl-zone-hint';
    hint.textContent = 'animation.json / .lottie';
    $('jsonSize').style.display = 'none';
};

/**
 * Wires up click and drag-and-drop events for a file drop zone
 */
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

/**
 * Shows the file compatibility status badge with an icon
 */
export const showCompatStatus = (type, message) => {
    const el = $('compatStatus');
    const icon = {ok: '✓', warn: '⚠', error: '✗'}[type] || '';
    el.className = `pl-compat-status pl-compat-${type}`;
    el.textContent = `${icon} ${message}`;
};

/** Hides the compatibility status badge */
export const clearCompatStatus = () => {
    const el = $('compatStatus');
    el.className = 'pl-compat-status';
    el.textContent = '';
};
