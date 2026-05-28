import {Optimizer} from '../../src/optimizer.js';
import {$, download, initTheme, toggleTheme} from '../common/common.js';
import {renderStats} from './ui.js';
import {createAnim, createSlotSettings, setupDemoControls} from './optimizer-utils.js';

initTheme();
window.__toggleTheme = toggleTheme;

/** Built-in demo animations shown on page load */
const DEMOS = [
    {name: 'v5', file: '../../samples-lottie/v3.lottie.json'},
    {name: 'v2', file: '../../samples-lottie/v2.lottie.json'},
    {name: 'sample2', file: '../../samples-lottie/sample1.json'},
];

/** Per-slot state: animBefore, animAfter, readSettings */
const slotSettingsMap = {};
const demoCache = [];
let userCache = null;
let userResult = null;
let _fileHandling = false;

/** Returns a named sub-element for the given slot */
const slotEl = (slotId, name) => slotId === 'user'
    ? $(`user-${name}`)
    : $(`demo-${name}-${slotId}`);

const slotPrefix = (slotId) => slotId === 'user' ? 'user' : `demo-${slotId}`;

/** Returns the root DOM element for the slot */
const slotRootEl = (slotId) => slotId === 'user'
    ? $('userSlot')
    : document.querySelector(`.demoSlot[data-index="${slotId}"]`);

/**
 * Runs Optimizer.run() for the given slot, updates the progress bar,
 * renders the optimized preview and stats, and sets up playback controls
 * For the user slot, also shows the download button
 */
const runOptimize = async (slotId, data, fileSize, name, settings) => {
    const p = slotPrefix(slotId);
    const bar = slotEl(slotId, 'bar');
    const text = slotEl(slotId, 'text');
    const statsEl = slotEl(slotId, 'stats');
    const afterEl = slotEl(slotId, 'after');
    if (slotSettingsMap[slotId]?.animAfter) {
        slotSettingsMap[slotId].animAfter.destroy();
        slotSettingsMap[slotId].animAfter = null;
    }
    bar.style.width = '0%';
    bar.className = 'progressBarFill';
    text.textContent = 'Optimizing...';
    statsEl.innerHTML = '';
    try {
        const result = await Optimizer.run(data, {
            ...settings,
            onProgress: (info) => {
                bar.style.width = info.percent + '%';
                text.textContent = info.message;
            },
        });
        bar.style.width = '100%';
        bar.classList.add('done');
        text.textContent = `Done in ${(result.stats.totalTime / 1000).toFixed(2)} s`;
        let animAfter = null;
        try {
            animAfter = createAnim(afterEl, result.preview);
        } catch (e) {
            console.error(`[${p}] Failed to render result:`, e);
        }
        if (slotSettingsMap[slotId]) slotSettingsMap[slotId].animAfter = animAfter;
        renderStats(statsEl, result.stats, fileSize, data);
        const animBefore = slotSettingsMap[slotId]?.animBefore;
        if (animBefore && animAfter) setupDemoControls(slotId.toString(), animBefore, animAfter);
        if (slotId === 'user') {
            userResult = result;
            $('userDownloads').style.display = 'flex';
        }
        return result;
    } catch (err) {
        bar.classList.add('error');
        bar.style.width = '100%';
        text.textContent = 'Error: ' + err.message;
        console.error(`[${p}] Optimization error:`, err);
        return null;
    }
};

/**
 * Initializes a slot: renders the original animation, injects the settings
 * panel, then immediately kicks off optimization
 */
const initSlot = async (slotId, data, fileSize, name) => {
    const p = slotPrefix(slotId);
    const beforeEl = slotEl(slotId, 'before');
    if (!fileSize) fileSize = JSON.stringify(data).length;
    if (slotSettingsMap[slotId]?.animBefore) {
        slotSettingsMap[slotId].animBefore.destroy();
        slotSettingsMap[slotId].animBefore = null;
    }
    let animBefore = null;
    try {
        animBefore = createAnim(beforeEl, structuredClone(data));
    } catch (e) {
        console.error(`[${p}] Failed to render original:`, e);
    }
    if (!slotSettingsMap[slotId]) {
        const statsEl = slotEl(slotId, 'stats');
        const {el, readSettings} = createSlotSettings(`slot-${p}`, async (s) => {
            await runOptimize(slotId, data, fileSize, name, s);
        });
        slotRootEl(slotId).insertBefore(el, statsEl);
        slotSettingsMap[slotId] = {readSettings, animBefore, animAfter: null};
    } else {
        slotSettingsMap[slotId].animBefore = animBefore;
    }
    const settings = slotSettingsMap[slotId].readSettings();
    return runOptimize(slotId, data, fileSize, name, settings);
};

/**
 * Fetches a demo animation by index, caches it, and runs initSlot
 * */
const loadDemo = async (i) => {
    const demo = DEMOS[i];
    $(`demo-load-wrap-${i}`).style.display = 'none';
    $(`demo-pair-${i}`).style.display = '';
    $(`demo-progress-${i}`).style.display = '';
    $(`demo-text-${i}`).textContent = 'Loading...';

    try {
        const resp = await fetch(demo.file);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        const fileSize = JSON.stringify(data).length;
        demoCache[i] = {data, fileSize, name: demo.name};
        await initSlot(i, data, fileSize, demo.name);
    } catch (err) {
        $(`demo-bar-${i}`).classList.add('error');
        $(`demo-bar-${i}`).style.width = '100%';
        $(`demo-text-${i}`).textContent = 'Error: ' + err.message;
        console.error(`[demo-${i}]`, err);
    }
};
for (let i = 0; i < DEMOS.length; i++) {
    $(`demo-load-btn-${i}`).addEventListener('click', () => loadDemo(i));
}

/**
 * Parses a user-supplied .json or .lottie file and runs it through initSlot
 * Guarded by fileHandling to prevent concurrent loads
 */
const handleUserFile = async (file) => {
    if (_fileHandling) return;
    _fileHandling = true;
    $('userSlot').style.display = '';
    $('userSection').classList.add('has-result');
    $('userDownloads').style.display = 'none';
    $('user-name').textContent = file.name;
    $('user-text').textContent = 'Loading...';
    $('user-bar').style.width = '0%';
    $('user-bar').className = 'progressBarFill';
    const yieldToMain = () => {
        if (window.scheduler?.yield) return scheduler.yield();
        if (typeof requestIdleCallback === 'function') {
            return new Promise(resolve => requestIdleCallback(resolve, {timeout: 50}));
        }
        return Promise.resolve();
    };
    try {
        let data;
        if (file.name.endsWith('.lottie')) {
            const parsed = await Optimizer.parseLottieInput(file);
            data = parsed.data;
        } else {
            const text = await file.text();
            await yieldToMain();
            try {
                data = JSON.parse(text);
            } catch (parseErr) {
                throw new Error('Invalid JSON file');
            }
        }
        userCache = {data, fileSize: file.size, name: file.name};
        if (slotSettingsMap['user']) {
            slotSettingsMap['user'].animBefore?.destroy();
            slotSettingsMap['user'].animAfter?.destroy();
            slotRootEl('user').querySelector('.slotSettings')?.remove();
            delete slotSettingsMap['user'];
        }
        await initSlot('user', data, file.size, file.name);
    } catch (err) {
        console.error('[user] File handling error:', err);
        $('user-text').textContent = `Error: ${err.message}`;
        $('user-bar').classList.add('error');
        $('user-bar').style.width = '100%';
    } finally {
        _fileHandling = false;
    }
};

/**
 * Tears down the user slot completely — destroys animations, removes the
 * settings panel, resets all UI state back to the initial empty state
 */
const resetUserSlot = () => {
    if (_fileHandling) return;
    slotSettingsMap['user']?.animBefore?.destroy();
    slotSettingsMap['user']?.animAfter?.destroy();
    slotRootEl('user').querySelector('.slotSettings')?.remove();
    delete slotSettingsMap['user'];
    userResult = null;
    userCache = null;
    _fileHandling = false;
    const userSlot = $('userSlot');
    const userDownloads = $('userDownloads');
    const dctrlUser = $('dctrlUser');
    const userBar = $('user-bar');
    const userName = $('user-name');
    userSlot.style.display = 'none';
    $('userSection').classList.remove('has-result');
    userDownloads.style.display = 'none';
    dctrlUser.style.display = 'none';
    ['user-before', 'user-after', 'user-stats'].forEach(id => $(id).innerHTML = '');
    userBar.style.width = '0%';
    userBar.className = 'progressBarFill';
    $('user-text').textContent = '';
    userName.textContent = 'Your file';
};

const uploadArea = $('uploadArea');
const fileInput = $('fileInput');

/** Forwards a File to handleUserFile if it's a supported type */
const processFile = (file) => {
    if (file && (file.name.endsWith('.json') || file.name.endsWith('.lottie'))) {
        handleUserFile(file);
    }
};
uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('dragover');
    processFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', (e) => {
    processFile(e.target.files[0]);
    e.target.value = '';
});

$('resetUserBtn').addEventListener('click', resetUserSlot);
$('dlLottie').addEventListener('click', () => {
    if (userResult?.lottie) {
        download(userResult.lottie, (userResult.animId || 'optimized') + '.lottie');
    }
});
