import {Optimizer} from '../src/index.js';

const formatSize = (b) => { if (!b) return '0 B'; const k = 1024, s = ['B','KB','MB','GB']; const i = Math.floor(Math.log(b)/Math.log(k)); return parseFloat((b/Math.pow(k,i)).toFixed(2))+' '+s[i]; };

// короткая функция вместо document.getElementById
const $ = id => document.getElementById(id);
// отдаёт управление браузеру между тяжёлыми операциями — страница не замерзает при разборе большого json
const yieldToMain = () => new Promise(r => setTimeout(r, 0));
// три демки
const DEMOS = [
    {name: 'v5', file: '../samples-lottie/v5.lottie.json'},
    {name: 'v2', file: '../samples-lottie/v2.lottie.json'},
    {name: 'sample2', file: '../samples-lottie/sample1.json'},
];

// создаём анимацию lottie в контейнере
const createAnim = (container, data) => {
    container.innerHTML = '';
    return lottie.loadAnimation({
        container,
        renderer: 'canvas',
        loop: true,
        autoplay: true,
        animationData: data,
        assetsPath: ''
    });
}

// выводим время
const fmtTime = (ms) => (ms < 1000) ? ms.toFixed(0) + ' ms' : (ms / 1000).toFixed(2) + ' s';

// рендерим всю статистику в блоке
const renderStats = (container, stats, originalFileSize, animData) => {
    const lottieSize = stats.zipFileSize;
    const totalAfter = lottieSize;
    const saved = originalFileSize - totalAfter;
    const savedPct = originalFileSize > 0 ? (saved / originalFileSize * 100).toFixed(2) : '0.00';
    const cls = saved > 0 ? 'positive' : saved < 0 ? 'negative' : '';

    // строка дерева
    const row = (pfx, key, val, valCls = '') =>
        `<div class="rtRow">
                <span class="rtPfx">${pfx}</span>
                <span class="rtKey">${key}</span>
                <span class="rtVal${valCls ? ' ' + valCls : ''}">${val}</span>
            </div>`;

    // список пар
    const rows = (items) => items.map((item, i) =>
        row(i === items.length - 1 ? '└' : '├', item[0], item[1], item[2] || '')
    ).join('');

    let html = '<div class="statsInner">';

    // три карточки
    html += `<div class="statsGrid">
            <div class="statBox">
                <div class="statLabel">Before</div>
                <div class="statValue">${formatSize(originalFileSize)}</div>
                <div class="statDetail">JSON + base64</div>
            </div>
            <div class="statBox">
                <div class="statLabel">After</div>
                <div class="statValue">${formatSize(totalAfter)}</div>
                <div class="statDetail">.lottie ${formatSize(lottieSize)}</div>
            </div>
            <div class="statBox ${cls}">
                <div class="statLabel">Saved</div>
                <div class="statValue">${savedPct} %</div>
                <div class="statDetail">${formatSize(Math.abs(saved))}</div>
            </div>
        </div>`;

    // тайминг
    const pt = stats.phaseTiming;
    const phaseSum = (pt.analysis || 0) + (pt.videoEncoding || 0) + (pt.imageProcessing || 0) + (pt.zip || 0) || 1;
    html += '<div class="statsTableTitle">Processing time</div>';
    html += '<div class="timingBar">';
    html += `<div class="timingSegment analysis" style="width:${(pt.analysis || 0) / phaseSum * 100}%"></div>`;
    html += `<div class="timingSegment video"   style="width:${(pt.videoEncoding || 0) / phaseSum * 100}%"></div>`;
    const showImgTiming = stats.totalImages > 0 && stats.framesInVideo < stats.totalImages;
    if (showImgTiming) html += `<div class="timingSegment images" style="width:${(pt.imageProcessing || 0) / phaseSum * 100}%"></div>`;
    html += `<div class="timingSegment zip"     style="width:${(pt.zip || 0) / phaseSum * 100}%"></div>`;
    html += '</div>';
    html += '<div class="timingLegend">';
    html += `<span class="tAnalysis">Analysis&nbsp;${fmtTime(pt.analysis || 0)}</span>`;
    html += `<span class="tVideo">Video&nbsp;${fmtTime(pt.videoEncoding || 0)}</span>`;
    if (showImgTiming) html += `<span class="tImages">Images&nbsp;${fmtTime(pt.imageProcessing || 0)}</span>`;
    html += `<span class="tZip">.lottie&nbsp;${fmtTime(pt.zip || 0)}</span>`;
    html += '</div>';
    html += '<table class="statsTable">';
    if (animData && animData.fr > 0) {
        const animDurSec = (animData.op - animData.ip) / animData.fr;
        html += `<tr><td>Animation duration</td><td>${animDurSec.toFixed(2)} s</td></tr>`;
    }
    html += `<tr><td>Total optimization time</td><td>${fmtTime(stats.totalTime)}</td></tr>`;

    if (stats.totalImages > 0 && stats.totalTime > 0) {
        const ips = (stats.totalImages / (stats.totalTime / 1000)).toFixed(2);
        html += `<tr><td>Image processing speed</td><td>${ips} img/sec</td></tr>`;
    }

    html += '</table>';
    html += '<div class="resultBlock">';

// блок АССЕТЫ
    const imgCount = stats.totalImages - stats.framesInVideo;

    if (stats.totalImages > 0) {
        html += `<div class="resultCard" style="border-left-color:#475569">`;
        html += `<div class="rcHead"> <span class="rcTitle">ANIMATION IMAGES</span> </div>`;

        const fmtsAll = Object.entries(stats.formats || {})
            .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
            .join(', ') || '—';

        const assetItems = [
            ['Total images', `${stats.totalImages}`],
            ['File formats', fmtsAll],
        ];

        if (stats.framesInVideo > 0) {
            assetItems.push(['Frames in video sequences', `${stats.framesInVideo}`]);
        }

        if (imgCount > 0) {
            assetItems.push(['Single images', `${imgCount}`]);
        }

        html += `<div class="rtBody">${rows(assetItems)}</div>`;
        html += `</div>`;
    }
// блок ВИДЕО ИЗ ПОСЛЕДОВАТЕЛЬНОСТЕЙ
    const totalSeqFound = (stats.sequences || 0) + (stats.videoSkipped || 0);

    if (totalSeqFound > 0) {
        html += `<div class="resultCard" style="border-left-color:#6366f1">`;
        html += `<div class="rcHead"> <span class="rcTitle">VIDEO FROM SEQUENCES</span> </div>`;

        const seqSummary = [
            ['Frame sequences found', `${totalSeqFound}`],
        ];

        if (stats.sequences > 0) {
            seqSummary.push(['Encoded to video', `${stats.sequences}`]);
        }

        if (stats.videoSize > 0) {
            seqSummary.push(['Encoded video size', formatSize(stats.videoSize)]);
        }

        if (stats.videoSkipped > 0) {
            seqSummary.push([
                'Skipped (no size reduction)',
                `${stats.videoSkipped}`,
                'rtVal--warn'
            ]);
        }

        html += `<div class="rtBody">${rows(seqSummary)}</div>`;

        // Детали по каждому видео
        for (const vd of stats.videoDetails || []) {
            const es = vd.encodingStats || {};

            html += `<div class="vSubCard">`;
            html += `<div class="vSubHead"> <span>${vd.file}</span> </div>`;

            const vItems = [
                ['Resolution', `${vd.width} × ${vd.height} px`],
                ['Frame count', `${vd.frames}`],
                ['Frame rate', `${vd.fps} fps`],
                ['Duration', `${vd.duration.toFixed(2)} s`],
                ['Original sequence size', formatSize(vd.originalSize || vd.fileSize || 0)],
                ['Compression', `${parseFloat(vd.compressionRatio || 0).toFixed(1)} %`],
                ['Codec', 'H.264'],
            ];

            if (es.keyFrames !== undefined) {
                vItems.push(['I-frames', `${es.keyFrames}`]);
                vItems.push(['Delta frames', `${es.deltaFrames}`]);
            }

            if (es.encodeTime) {
                vItems.push(['Encoding time', fmtTime(es.encodeTime)]);

                if (es.loadTime) {
                    vItems.push(['Frame load time', fmtTime(es.loadTime)]);
                    vItems.push([
                        'Load speed',
                        `${(vd.frames / (es.loadTime / 1000)).toFixed(1)} frames/sec`
                    ]);
                }

                vItems.push([
                    'Encoding speed',
                    `${(vd.frames / (es.encodeTime / 1000)).toFixed(1)} frames/sec`
                ]);

                if (es.muxTime) {
                    vItems.push(['Mux time', fmtTime(es.muxTime)]);
                }
            }

            html += `<div class="rtBody">${rows(vItems)}</div>`;
            html += `</div>`;
        }

        html += `</div>`;
    }

    // блок ОДИНОЧНЫЕ КАРТИНКИ
    if (imgCount > 0) {
        html += `<div class="resultCard" style="border-left-color:var(--accent)">`;
        html += `<div class="rcHead"> <span class="rcTitle">SINGLE IMAGES</span> </div>`;

        const singleBefore = stats.singleImagesSizeBefore || 0;
        const singleAfter  = stats.sizeAfter || 0;
        const singleSavedPct = singleBefore > 0
            ? ((singleBefore - singleAfter) / singleBefore * 100).toFixed(1)
            : '0.0';
        const singleRatio = singleBefore > 0
            ? (singleAfter / singleBefore * 100).toFixed(1)
            : '100.0';

        const imgItems = [
            ['Unique total', `${stats.uniqueImages || 0}`],
        ];

        if (stats.duplicates > 0) {
            imgItems.push(['Duplicates (merged)', `${stats.duplicates}`, 'rtVal--warn']);
        }

        imgItems.push(
            ['Converted to WebP', `${stats.webpConversions || 0}`, 'rtVal--accent']
        );

        if (stats.keptOriginal > 0) {
            imgItems.push(['Format unchanged (WebP worse)', `${stats.keptOriginal}`]);
        }

        imgItems.push(
            ['Size before', formatSize(singleBefore)],
            ['Size after', formatSize(singleAfter)],
            ['Compression', `${singleRatio} %`],
            ['Savings', `${singleSavedPct} %`, singleSavedPct > 0 ? 'rtVal--accent' : '']
        );

        html += `<div class="rtBody">${rows(imgItems)}</div>`;
        html += `</div>`;
    }

    html += '</div></div>';
    container.innerHTML = html;
}

// нужен чтобы не создавать панель настроек заново при ре-оптимизации
const slotSettingsMap = {};

const runOptimizeSlot = async (data, index, fileName, fileSize, settings) => {
    const bar = $(`demo-bar-${index}`);
    const text = $(`demo-text-${index}`);
    const statsEl = $(`demo-stats-${index}`);
    const afterEl = $(`demo-after-${index}`);

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
            }
        });

        bar.style.width = '100%';
        bar.classList.add('done');
        text.textContent = `Done in ${(result.stats.totalTime / 1000).toFixed(2)} s`;

        let animAfter = null;
        try {
            animAfter = createAnim(afterEl, result.preview);
        } catch (e) {
        }

        renderStats(statsEl, result.stats, fileSize, data);

        const animBefore = slotSettingsMap[index]?.animBefore;
        if (animBefore && animAfter) setupDemoControls(index.toString(), animBefore, animAfter);

        return result;
    } catch (err) {
        bar.classList.add('error');
        bar.style.width = '100%';
        text.textContent = 'Error: ' + err.message;
        console.error(err);
        return null;
    }
};

const optimizeSlotByIndex = async (data, index, fileName, fileSize) => {
    const beforeEl = $(`demo-before-${index}`);

    if (!fileSize) fileSize = new Blob([JSON.stringify(data)]).size;

    // рисуем оригинал
    let animBefore = null;
    try {
        animBefore = createAnim(beforeEl, data);
    } catch (e) {
        log.err(`[${fileName}] failed to render original — ${e.message}`);
    }

    // создаём панель настроек один раз для слота
    if (!slotSettingsMap[index]) {
        const slotEl = document.querySelector(`.demoSlot[data-index="${index}"]`);
        const statsEl = $(`demo-stats-${index}`);
        const {el, readSettings} = createSlotSettings(`slot-${index}`, async (s) => {
            await runOptimizeSlot(data, index, fileName, fileSize, s);
        });
        slotEl.insertBefore(el, statsEl);
        slotSettingsMap
            [index] = {readSettings, animBefore};
    } else {
        slotSettingsMap[index].animBefore = animBefore;
    }

    const settings = slotSettingsMap[index].readSettings();
    return runOptimizeSlot(data, index, fileName, fileSize, settings);
}

// кэш оригинальных данных — чтобы можно было перезапустить оптимизацию с другими настройками без повторного fetch
const demoCache = [];
let userCache = null;

// создаём панель настроек внутри слота
function createSlotSettings(slotId, onApply) {
    const container = document.createElement('div');
    container.className = 'slotSettings';
    container.innerHTML = `
        <div class="slotSettingsControls">
            <div class="slotSettingRow">
                <span class="slotSettingLabel">WebP quality</span>
                <input type="range" class="slotRange" id="${slotId}-webp" min="0.1" max="0.95" step="0.05" value="0.8">
                <span class="slotRangeVal" id="${slotId}-webp-val">0.80</span>
            </div>
        </div>
        <button class="slotApplyBtn" id="${slotId}-apply">Apply</button>`;

    const webpEl = container.querySelector(`#${slotId}-webp`);
    const webpVal = container.querySelector(`#${slotId}-webp-val`);
    const applyBtn = container.querySelector(`#${slotId}-apply`);

    webpEl.oninput = () => {
        webpVal.textContent = parseFloat(webpEl.value).toFixed(2);
    };

    applyBtn.onclick = async () => {
        applyBtn.disabled = true;
        await onApply(readSettings());
        applyBtn.disabled = false;
    };

    const readSettings = () => ({
        quality: parseFloat(webpEl.value),
    });

    return {el: container, readSettings};
}

// грузим все демки по очереди
async function loadAllDemos() {
    for (let i = 0; i < DEMOS.length; i++) {
        const demo = DEMOS[i];
        const text = $(`demo-text-${i}`);
        text.textContent = 'Loading...';

        try {
            const resp = await fetch(demo.file);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const fileSize = new Blob([JSON.stringify(data)]).size;
            demoCache[i] = {data, fileSize, name: demo.name};
            await optimizeSlotByIndex(data, i, demo.name, fileSize);
        } catch (err) {
            const bar = $(`demo-bar-${i}`);
            const text2 = $(`demo-text-${i}`);
            bar.classList.add('error');
            bar.style.width = '100%';
            text2.textContent = 'Error: ' + err.message;
        }
    }
}

// загрузка своего файла
const uploadArea = $('uploadArea');
const fileInput = $('fileInput');
let userResult = null;
// guard — блокирует повторный запуск пока идёт обработка файла
let _fileHandling = false;
uploadArea.onclick = () => fileInput.click();
uploadArea.ondragover = (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
};
uploadArea.ondragleave = () => uploadArea.classList.remove('dragover');
uploadArea.ondrop = (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.json') || file.name.endsWith('.lottie'))) handleUserFile(file);
};
fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) handleUserFile(file);
    e.target.value = '';
};

const runOptimizeUserSlot = async (data, fileSize, name, settings) => {
    const bar = $('user-bar');
    const text = $('user-text');
    const statsEl = $('user-stats');
    const afterEl = $('user-after');
    const userDl = $('userDownloads');

    bar.style.width = '0%';
    bar.className = 'progressBarFill';
    text.textContent = 'Optimizing...';
    statsEl.innerHTML = '';

    const animBefore = slotSettingsMap['user']?.animBefore;

    try {
        const result = await Optimizer.run(data, {
            ...settings,
            onProgress: (info) => {
                bar.style.width = info.percent + '%';
                text.textContent = info.message;
            }
        });

        userResult = result;
        bar.style.width = '100%';
        bar.classList.add('done');
        text.textContent = `Done in ${(result.stats.totalTime / 1000).toFixed(2)} s`;

        let animAfter = null;
        try {
            animAfter = createAnim(afterEl, result.preview);
        } catch (e) {
        }

        renderStats(statsEl, result.stats, fileSize, data);
        if (animBefore && animAfter) setupDemoControls('user', animBefore, animAfter);
        userDl.style.display = 'flex';

    } catch (err) {
        bar.classList.add('error');
        bar.style.width = '100%';
        text.textContent = 'Error: ' + err.message;
        console.error(err);
    }
};

const handleUserFile = async (file) => {
    if (_fileHandling) return;
    _fileHandling = true;
    $('userSlot').style.display = '';
    $('userSection').classList.add('has-result');
    $('userDownloads').style.display = 'none';
    $('user-name').textContent = file.name;

    try {
        let data;
        if (file.name.endsWith('.lottie')) {
            const parsed = await Optimizer.parseLottieInput(file);
            data = parsed.data;
        } else {
            const text = await file.text();
            await yieldToMain();
            data = JSON.parse(text);
        }
        userCache = {data, fileSize: file.size, name: file.name};
        await yieldToMain();

        let animBefore = null;
        try {
            animBefore = createAnim($('user-before'), data);
        } catch (e) {
        }

        // создаём панель настроек один раз для пользовательского слота
        if (!slotSettingsMap['user']) {
            const slotEl = $('userSlot');
            const statsEl = $('user-stats');
            const {el, readSettings} = createSlotSettings('slot-user', async (s) => {
                await runOptimizeUserSlot(data, file.size, file.name, s);
            });
            slotEl.insertBefore(el, statsEl);
            slotSettingsMap['user'] = {readSettings, animBefore};
        } else {
            slotSettingsMap['user'].animBefore = animBefore;
        }

        const settings = slotSettingsMap['user'].readSettings();
        await runOptimizeUserSlot(data, file.size, file.name, settings);

    } catch (err) {
        console.error(err);
    } finally {
        _fileHandling = false;
    }
}

const resetUserSlot = () => {
    slotSettingsMap['user']?.animBefore?.destroy();
    userResult = null;
    userCache = null;
    delete slotSettingsMap['user'];
    _fileHandling = false;
    $('userSlot').style.display = 'none';
    $('userSection').classList.remove('has-result');
    $('userDownloads').style.display = 'none';
    $('user-before').innerHTML = '';
    $('user-after').innerHTML = '';
    $('user-stats').innerHTML = '';
    $('dctrl-user').style.display = 'none';
    $('user-bar').style.width = '0%';
    $('user-bar').className = 'progressBarFill';
    $('user-text').textContent = '';
    $('user-name').textContent = 'Your file';
};
$('resetUserBtn').onclick = resetUserSlot;

// кнопка скачивания .lottie
$('dlLottie').onclick = () => {
    if (userResult?.lottie) download(userResult.lottie, (userResult.animId || 'optimized') + '.lottie');
};

const download = (blob, name) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

// управление воспроизведением в демо
const setupDemoControls = (slot, animBefore, animAfter) => {
    const p = `dctrl-${slot}`;
    const controls = $(p);
    const scrubber = $(`${p}-scrub`);
    const frameEl = $(`${p}-frame`);
    const btnPlay = $(`${p}-play`);
    const btnStop = $(`${p}-stop`);
    const speedSel = $(`${p}-speed`);
    const btnLoop = $(`${p}-loop`);

    if (!controls || !animBefore || !animAfter) return;
    controls.style.display = '';

    const totalFrames = Math.max(0, Math.floor(animAfter.totalFrames) - 1);
    const beforeFrames = Math.max(0, Math.floor(animBefore.totalFrames) - 1);
    scrubber.max = totalFrames;
    let playing = true;
    let scrubbing = false;
    let looping = true;

    animBefore.pause();
    animBefore.goToAndStop(0, true);
    animAfter.goToAndStop(0, true);
    animAfter.play();

    const updateLabel = (f) => {
        frameEl.textContent = `${Math.floor(f)} / ${totalFrames}`;
    };
    updateLabel(0);
    animAfter.addEventListener('enterFrame', (e) => {
        if (scrubbing) return;
        const f = Math.floor(e.currentTime);
        animBefore.goToAndStop(Math.min(f, beforeFrames), true);
        scrubber.value = f;
        updateLabel(e.currentTime);
    });

    animAfter.addEventListener('complete', () => {
        if (!looping) {
            playing = false;
            btnPlay.innerHTML = '▶';
        }
    });

    scrubber.addEventListener('pointerdown', () => {
        scrubbing = true;
        animAfter.pause();
    });

    scrubber.addEventListener('input', () => {
        const f = parseInt(scrubber.value);
        animBefore.goToAndStop(Math.min(f, beforeFrames), true);
        animAfter.goToAndStop(f, true);
        updateLabel(f);
    });

    scrubber.addEventListener('pointerup', () => {
        scrubbing = false;
        if (playing) animAfter.play();
    });

    btnPlay.onclick = () => {
        if (playing) {
            animAfter.pause();
            playing = false;
            btnPlay.innerHTML = '▶';
        } else {
            animAfter.play();
            playing = true;
            btnPlay.innerHTML = '⏸';
        }
    };

    btnStop.onclick = () => {
        animAfter.stop();
        animBefore.goToAndStop(0, true);
        playing = false;
        scrubber.value = 0;
        updateLabel(0);
        btnPlay.innerHTML = '▶';
    };

    speedSel.onchange = () => {
        animAfter.setSpeed(parseFloat(speedSel.value));
    };

    btnLoop.onclick = () => {
        looping = !looping;
        animAfter.setLoop(looping);
        btnLoop.classList.toggle('active', looping);
    };
}


// запуск демки сразу при загрузке страницы
loadAllDemos();
