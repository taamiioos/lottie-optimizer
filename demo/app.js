import {Optimizer, formatSize} from '../src/optimizer.js';

// главный скрипт
// короткая функция вместо document.getElementById
const $ = id => document.getElementById(id);
// три демки, которые грузятся автоматически
const DEMOS = [
    {name: 'Lottie with Cat', file: '../samples/sample1.json'},
    {name: 'Slideshow', file: '../samples/sample2.json'},
    {name: 'Black Rainbow Cat', file: '../samples/sample3.json'},
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

// красиво выводим время
const fmtTime = (ms) => (ms < 1000) ? ms.toFixed(0) + ' мс' : (ms / 1000).toFixed(2) + ' с';

// рендерим всю статистику в блоке
const renderStats = (container, stats, originalFileSize) => {
    const jsonAfter = stats.optimizedJsonSize;
    const zipSize = stats.zipFileSize;
    const totalAfter = jsonAfter + zipSize;
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

    // три большие карточки
    html += `<div class="statsGrid">
            <div class="statBox">
                <div class="statLabel">Было</div>
                <div class="statValue">${formatSize(originalFileSize)}</div>
                <div class="statDetail">JSON + base64</div>
            </div>
            <div class="statBox">
                <div class="statLabel">Стало</div>
                <div class="statValue">${formatSize(totalAfter)}</div>
                <div class="statDetail">JSON ${formatSize(jsonAfter)} + ZIP ${formatSize(zipSize)}</div>
            </div>
            <div class="statBox ${cls}">
                <div class="statLabel">Сэкономлено</div>
                <div class="statValue">${savedPct} %</div>
                <div class="statDetail">${formatSize(Math.abs(saved))}</div>
            </div>
        </div>`;

    // тайминг
    const pt = stats.phaseTiming;
    const phaseSum = (pt.analysis || 0) + (pt.videoEncoding || 0) + (pt.imageProcessing || 0) + (pt.zip || 0) || 1;
    html += '<div class="statsTableTitle">Время работы</div>';
    html += '<div class="timingBar">';
    html += `<div class="timingSegment analysis" style="width:${(pt.analysis || 0) / phaseSum * 100}%"></div>`;
    html += `<div class="timingSegment video"   style="width:${(pt.videoEncoding || 0) / phaseSum * 100}%"></div>`;
    const showImgTiming = stats.totalImages > 0 && stats.framesInVideo < stats.totalImages;
    if (showImgTiming) html += `<div class="timingSegment images" style="width:${(pt.imageProcessing || 0) / phaseSum * 100}%"></div>`;
    html += `<div class="timingSegment zip"     style="width:${(pt.zip || 0) / phaseSum * 100}%"></div>`;
    html += '</div>';
    html += '<div class="timingLegend">';
    html += `<span class="tAnalysis">Анализ&nbsp;${fmtTime(pt.analysis || 0)}</span>`;
    html += `<span class="tVideo">Видео&nbsp;${fmtTime(pt.videoEncoding || 0)}</span>`;
    if (showImgTiming) html += `<span class="tImages">Картинки&nbsp;${fmtTime(pt.imageProcessing || 0)}</span>`;
    html += `<span class="tZip">ZIP&nbsp;${fmtTime(pt.zip || 0)}</span>`;
    html += '</div>';
    html += '<table class="statsTable">';
    html += `<tr><td>Итого</td><td>${fmtTime(stats.totalTime)}</td></tr>`;
    if (stats.totalImages > 0 && stats.totalTime > 0) {
        const ips = (stats.totalImages / (stats.totalTime / 1000)).toFixed(2);
        html += `<tr><td>Скорость</td><td>${ips} изобр./с</td></tr>`;
    }
    html += '</table>';

    html += '<div class="resultBlock">';

    // блок АССЕТЫ
    const imgCount = stats.totalImages - stats.framesInVideo;
    if (stats.totalImages > 0) {
        const fmtsAll = Object.entries(stats.formats).map(([k, v]) => `${k.toUpperCase()}: ${v}`).join(', ');
        const assetItems = [['Всего', `${stats.totalImages} шт.`], ['Форматы', fmtsAll || '—']];
        if (stats.framesInVideo > 0) assetItems.push(['В последовательности', `${stats.framesInVideo} кадров`]);
        if (imgCount > 0) assetItems.push(['Одиночных', `${imgCount} шт.`]);
        html += `<div class="resultCard" style="border-left-color:#475569">
                <div class="rcHead">
                    <span class="rcTitle">АССЕТЫ</span>
                    <span class="rcBadge">${stats.totalImages} изображений</span>
                </div>
                <div class="rtBody">${rows(assetItems)}</div>
            </div>`;
    }
    // блок ВИДЕО ИЗ ПОСЛЕДОВАТЕЛЬНОСТЕЙ
    const totalSeqFound = stats.sequences + stats.videoSkipped;
    if (totalSeqFound > 0) {
        const totalOrigVideo = stats.videoDetails.reduce((a, vd) => a + vd.originalSize, 0);
        const videoSavedPct = totalOrigVideo > 0
            ? ((1 - stats.videoSize / totalOrigVideo) * 100).toFixed(2) : '0.00';

        html += `<div class="resultCard" style="border-left-color:#6366f1">`;
        html += `<div class="rcHead">
                <span class="rcTitle">ВИДЕО ИЗ ПОСЛЕДОВАТЕЛЬНОСТЕЙ</span>
                <span class="rcBadge">${stats.sequences} видео · ${stats.framesInVideo} кадров</span>
            </div>`;

        // сводка по всем видео
        const seqSummary = [['Найдено последовательностей', `${totalSeqFound} шт.`]];
        if (stats.sequences > 0) seqSummary.push(['Закодировано', `${stats.sequences} шт.`]);
        if (stats.videoSize > 0) seqSummary.push(['Размер видео', formatSize(stats.videoSize)]);
        if (stats.videoSkipped > 0) seqSummary.push(['Пропущено (больше оригинала)', `${stats.videoSkipped} шт.`, 'rtVal--warn']);
        html += `<div class="rtBody">${rows(seqSummary)}</div>`;

        // подкарточка на каждое видео с полными деталями
        for (const vd of stats.videoDetails) {
            const es = vd.encodingStats || {};

            html += `<div class="vSubCard">`;
            html += `<div class="vSubHead">
                    <span>${vd.file}</span>
                </div>`;

            const vItems = [
                ['Разрешение', `${vd.width}×${vd.height} px`],
                ['Кадров', `${vd.frames} кадр`],
                ['FPS', `${vd.fps} fps`],
                ['Длительность', `${vd.duration.toFixed(2)} с`],
                ['Файл', formatSize(vd.fileSize)],
                ['Было', formatSize(vd.originalSize)],
                ['Сжатие', `${parseFloat(vd.compressionRatio).toFixed(2)} %`],
                ['Кодек', 'H.264'],
            ];
            if (es.keyFrames !== undefined) {
                vItems.push(['Ключевых кадров', `${es.keyFrames} кадр`]);
                vItems.push(['Дельта-кадров', `${es.deltaFrames} кадр`]);
            }
            if (es.hardwareAcceleration) vItems.push(['Ускорение', es.hardwareAcceleration]);
            if (es.encodeTime) {
                if (es.loadTime) {
                    vItems.push(['Загрузка кадров', fmtTime(es.loadTime)]);
                    vItems.push(['Загрузка, fps', `${(vd.frames / (es.loadTime / 1000)).toFixed(2)} fps`]);
                }
                vItems.push(['Кодирование', fmtTime(es.encodeTime)]);
                vItems.push(['Кодирование, fps', `${(vd.frames / (es.encodeTime / 1000)).toFixed(2)} fps`]);
                vItems.push(['Мультиплекс', fmtTime(es.muxTime)]);
            }
            html += `<div class="rtBody">${rows(vItems)}</div>`;
            html += `</div>`;
        }
        html += `</div>`;
    }

    // блок ОДИНОЧНЫЕ КАРТИНКИ
    if (imgCount > 0) {
        html += `<div class="resultCard" style="border-left-color:var(--accent)">`;
        html += `<div class="rcHead">
                <span class="rcTitle">ОДИНОЧНЫЕ КАРТИНКИ</span>
                <span class="rcBadge">${imgCount} изображений</span>
            </div>`;

        const imgSavedPct = stats.sizeBefore > 0
            ? ((1 - stats.sizeAfter / stats.sizeBefore) * 100).toFixed(2) : '0.00';
        const imgItems = [['Уникальных', `${stats.uniqueImages} шт.`]];
        if (stats.duplicates > 0) imgItems.push(['Дубликатов', `${stats.duplicates} шт.`, 'rtVal--warn']);
        imgItems.push(['Переведено в WebP', `${stats.webpConversions} шт.`, 'rtVal--accent']);
        if (stats.keptOriginal > 0) imgItems.push(['Оставлено оригинал', `${stats.keptOriginal} шт.`]);
        imgItems.push(['Размер до', formatSize(stats.sizeBefore)]);
        imgItems.push(['Размер после WebP', formatSize(stats.sizeAfter)]);
        if (stats.webpSavings > 0) imgItems.push(['Экономия WebP', formatSize(stats.webpSavings), 'rtVal--accent']);
        imgItems.push(['Степень сжатия', `${parseFloat(stats.compressionRatio).toFixed(2)} %`]);
        imgItems.push(['Сэкономлено', `${imgSavedPct} %`]);

        html += `<div class="rtBody">${rows(imgItems)}</div>`;
        html += `</div>`;
    }
    html += '</div>';
    html += '</div>';
    container.innerHTML = html;
}

// оптимизируем одну демку или пользовательский файл
const slotSettingsMap = {};

const runOptimizeSlot = async (data, index, fileName, fileSize, settings) => {
    const bar = $(`demo-bar-${index}`);
    const text = $(`demo-text-${index}`);
    const statsEl = $(`demo-stats-${index}`);
    const afterEl = $(`demo-after-${index}`);

    bar.style.width = '0%';
    bar.className = 'progressBarFill';
    text.textContent = 'Оптимизация...';
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
        text.textContent = `Готово за ${(result.stats.totalTime / 1000).toFixed(2)} с`;

        let animAfter = null;
        try { animAfter = createAnim(afterEl, result.preview); } catch (e) { }

        renderStats(statsEl, result.stats, fileSize);

        const animBefore = slotSettingsMap[index]?.animBefore;
        if (animBefore && animAfter) setupDemoControls(index.toString(), animBefore, animAfter);

        return result;
    } catch (err) {
        bar.classList.add('error');
        bar.style.width = '100%';
        text.textContent = 'Ошибка: ' + err.message;
        console.error(err);
        return null;
    }
};

const optimizeSlotByIndex = async (data, index, fileName, fileSize) => {
    const beforeEl = $(`demo-before-${index}`);

    if (!fileSize) fileSize = new Blob([JSON.stringify(data)]).size;

    // рисуем оригинал
    let animBefore = null;
    try { animBefore = createAnim(beforeEl, data); } catch (e) {
        log.err(`[${fileName}] не удалось отрисовать оригинал — ${e.message}`);
    }

    // создаём панель настроек один раз для слота
    if (!slotSettingsMap[index]) {
        const slotEl = document.querySelector(`.demoSlot[data-index="${index}"]`);
        const statsEl = $(`demo-stats-${index}`);
        const { el, readSettings } = createSlotSettings(`slot-${index}`, async (s) => {
            await runOptimizeSlot(data, index, fileName, fileSize, s);
        });
        slotEl.insertBefore(el, statsEl);
        slotSettingsMap[index] = { readSettings, animBefore };
    } else {
        slotSettingsMap[index].animBefore = animBefore;
    }

    const settings = slotSettingsMap[index].readSettings();
    return runOptimizeSlot(data, index, fileName, fileSize, settings);
}

// кэш для ре-оптимизации
const demoCache = [];
let userCache = null;

// создаём панель настроек внутри слота
function createSlotSettings(slotId, onApply) {
    const container = document.createElement('div');
    container.className = 'slotSettings';
    container.innerHTML = `
        <div class="slotSettingsControls">
            <div class="slotSettingRow">
                <span class="slotSettingLabel">Качество WebP</span>
                <input type="range" class="slotRange" id="${slotId}-webp" min="0.1" max="1" step="0.05" value="0.8">
                <span class="slotRangeVal" id="${slotId}-webp-val">0.80</span>
            </div>
        </div>
        <button class="slotApplyBtn" id="${slotId}-apply">Применить</button>`;

    const webpEl   = container.querySelector(`#${slotId}-webp`);
    const webpVal  = container.querySelector(`#${slotId}-webp-val`);
    const applyBtn = container.querySelector(`#${slotId}-apply`);

    webpEl.oninput = () => { webpVal.textContent = parseFloat(webpEl.value).toFixed(2); };

    applyBtn.onclick = async () => {
        applyBtn.disabled = true;
        await onApply(readSettings());
        applyBtn.disabled = false;
    };

    const readSettings = () => ({
        quality: parseFloat(webpEl.value),
    });

    return { el: container, readSettings };
}

// грузим все демки по очереди
async function loadAllDemos() {
    for (let i = 0; i < DEMOS.length; i++) {
        const demo = DEMOS[i];
        const text = $(`demo-text-${i}`);
        text.textContent = 'Качаем...';

        try {
            const resp = await fetch(demo.file);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const data = await resp.json();
            const fileSize = new Blob([JSON.stringify(data)]).size;
            demoCache[i] = { data, fileSize, name: demo.name };
            await optimizeSlotByIndex(data, i, demo.name, fileSize);
        } catch (err) {
            const bar = $(`demo-bar-${i}`);
            const text2 = $(`demo-text-${i}`);
            bar.classList.add('error');
            bar.style.width = '100%';
            text2.textContent = 'Ошибка: ' + err.message;
        }
    }
}

// загрузка своего файла
const uploadArea = $('uploadArea');
const fileInput = $('fileInput');
let userResult = null;
uploadArea.onclick = () => fileInput.click();
uploadArea.ondragover = (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
};
uploadArea.ondragleave = () => uploadArea.classList.remove('dragover');
uploadArea.ondrop = (e) => {
    e.preventDefault();
    uploadArea.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.json')) handleUserFile(file);
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
    text.textContent = 'Оптимизируем...';
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
        text.textContent = `Готово за ${(result.stats.totalTime / 1000).toFixed(2)} с`;

        let animAfter = null;
        try { animAfter = createAnim(afterEl, result.preview); } catch (e) { }

        renderStats(statsEl, result.stats, fileSize);
        if (animBefore && animAfter) setupDemoControls('user', animBefore, animAfter);
        userDl.style.display = 'flex';

    } catch (err) {
        bar.classList.add('error');
        bar.style.width = '100%';
        text.textContent = 'Ошибка: ' + err.message;
        console.error(err);
    }
};

const handleUserFile = async (file) => {
    $('userSlot').style.display = '';
    $('userSection').classList.add('has-result');
    $('userDownloads').style.display = 'none';
    $('user-name').textContent = file.name;

    try {
        const data = JSON.parse(await file.text());
        userCache = { data, fileSize: file.size, name: file.name };

        let animBefore = null;
        try { animBefore = createAnim($('user-before'), data); } catch (e) { }

        // создаём панель настроек один раз для пользовательского слота
        if (!slotSettingsMap['user']) {
            const slotEl = $('userSlot');
            const statsEl = $('user-stats');
            const { el, readSettings } = createSlotSettings('slot-user', async (s) => {
                await runOptimizeUserSlot(data, file.size, file.name, s);
            });
            slotEl.insertBefore(el, statsEl);
            slotSettingsMap['user'] = { readSettings, animBefore };
        } else {
            slotSettingsMap['user'].animBefore = animBefore;
        }

        const settings = slotSettingsMap['user'].readSettings();
        await runOptimizeUserSlot(data, file.size, file.name, settings);

    } catch (err) {
        console.error(err);
    }
}

// кнопки скачивания
$('dlJson').onclick = () => {
    if (!userResult) return;
    download(new Blob([JSON.stringify(userResult.json, null, 2)]), 'optimized.json');
};
$('dlZip').onclick = () => {
    if (userResult?.zip) download(userResult.zip, 'assets.zip');
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
    scrubber.max = totalFrames;
    let playing = true;
    let scrubbing = false;
    let looping = true;

    const updateLabel = (f) => {
        frameEl.textContent = `${Math.floor(f)} / ${totalFrames}`;
    }

    updateLabel(0);

    animAfter.addEventListener('enterFrame', (e) => {
        if (scrubbing) return;
        scrubber.value = Math.floor(e.currentTime);
        updateLabel(e.currentTime);
    });

    animAfter.addEventListener('complete', () => {
        playing = false;
        btnPlay.innerHTML = '▶&ensp;Играть';
    });

    scrubber.addEventListener('pointerdown', () => {
        scrubbing = true;
        if (playing) {
            animBefore.pause();
            animAfter.pause();
        }
    });

    scrubber.addEventListener('input', () => {
        const f = parseInt(scrubber.value);
        animBefore.goToAndStop(f, true);
        animAfter.goToAndStop(f, true);
        updateLabel(f);
    });

    scrubber.addEventListener('pointerup', () => {
        scrubbing = false;
        if (playing) {
            animBefore.play();
            animAfter.play();
        }
    });

    btnPlay.onclick = () => {
        if (playing) {
            animBefore.pause();
            animAfter.pause();
            playing = false;
            btnPlay.innerHTML = '▶';
        } else {
            animBefore.play();
            animAfter.play();
            playing = true;
            btnPlay.innerHTML = '⏸';
        }
    };

    btnStop.onclick = () => {
        animBefore.stop();
        animAfter.stop();
        playing = false;
        scrubber.value = 0;
        updateLabel(0);
        btnPlay.innerHTML = '▶';
    };

    speedSel.onchange = () => {
        const stats = parseFloat(speedSel.value);
        animBefore.setSpeed(stats);
        animAfter.setSpeed(stats);
    };

    btnLoop.onclick = () => {
        looping = !looping;
        animBefore.setLoop(looping);
        animAfter.setLoop(looping);
        btnLoop.classList.toggle('active', looping);
    };
}


// запуск демки сразу при загрузке страницы
loadAllDemos();
