// главный скрипт страницы
document.addEventListener('DOMContentLoaded', () => {
    // короткая функция вместо document.getElementById
    const $ = id => document.getElementById(id);
    // три демки, которые грузятся автоматически
    const DEMOS = [
        { name: 'Slideshow', file: 'notOptimizedLottie/Slideshow.json' },
        { name: 'Black Rainbow Cat', file: 'notOptimizedLottie/black%20rainbow%20cat.json' },
        { name: 'Lottie with Cat', file: 'notOptimizedLottie/lottie%20with%20cat.json' }
    ];
    // логирование
    const logEl = $('logContent');
    const log = {
        clear() { logEl.innerHTML = ''; },
        add(text, cls = '') {
            const d = document.createElement('div');
            d.className = 'logLine ' + cls;
            d.textContent = text;
            logEl.appendChild(d);
            logEl.scrollTop = logEl.scrollHeight;
        },
        info(t) { this.add(t); },
        ok(t) { this.add(t, 'success'); },
        err(t) { this.add(t, 'error'); },
        phase(t) { this.add(t, 'phase'); }
    };

    $('clearLog').onclick = () => log.clear();
    // создаём анимацию lottie в контейнере
    function createAnim(container, data) {
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
    function fmtTime(ms) {
        if (ms < 1000) return ms.toFixed(0) + ' мс';
        return (ms / 1000).toFixed(2) + ' с';
    }
    // рендерим всю статистику в блоке
    function renderStats(container, s, originalFileSize) {
        const jsonAfter = s.optimizedJsonSize;
        const zipSize = s.zipFileSize;
        const totalAfter = jsonAfter + zipSize;
        const saved = originalFileSize - totalAfter;
        const savedPct = originalFileSize > 0 ? Math.round(saved / originalFileSize * 100) : 0;
        const cls = saved > 0 ? 'positive' : saved < 0 ? 'negative' : '';

        let html = '<div class="statsInner">';

        // три большие карточки
        html += '<div class="statsGrid">';
        html += `<div class="statBox">
            <div class="statLabel">Было</div>
            <div class="statValue">${formatSize(originalFileSize)}</div>
            <div class="statDetail">JSON + base64</div>
        </div>`;
        html += `<div class="statBox">
            <div class="statLabel">Стало</div>
            <div class="statValue">${formatSize(totalAfter)}</div>
            <div class="statDetail">JSON ${formatSize(jsonAfter)} + ZIP ${formatSize(zipSize)}</div>
        </div>`;
        html += `<div class="statBox ${cls}">
            <div class="statLabel">Сэкономлено</div>
            <div class="statValue">${savedPct}%</div>
            <div class="statDetail">${formatSize(Math.abs(saved))}</div>
        </div>`;
        html += '</div>';

        // тайминг
        const pt = s.phaseTiming;
        // делитель
        const phaseSum = (pt.analysis||0) + (pt.videoEncoding||0) + (pt.imageProcessing||0) + (pt.zip||0) || 1;
        html += '<div class="statsTableTitle">Время работы</div>';
        html += '<div class="timingBar">';
        html += `<div class="timingSegment analysis" style="width:${(pt.analysis||0)/phaseSum*100}%"></div>`;
        html += `<div class="timingSegment video"   style="width:${(pt.videoEncoding||0)/phaseSum*100}%"></div>`;
        html += `<div class="timingSegment images"  style="width:${(pt.imageProcessing||0)/phaseSum*100}%"></div>`;
        html += `<div class="timingSegment zip"     style="width:${(pt.zip||0)/phaseSum*100}%"></div>`;
        html += '</div>';
        html += '<div class="timingLegend">';
        html += `<span class="tAnalysis">Анализ&nbsp;${fmtTime(pt.analysis||0)}</span>`;
        html += `<span class="tVideo">Видео&nbsp;${fmtTime(pt.videoEncoding||0)}</span>`;
        html += `<span class="tImages">Картинки&nbsp;${fmtTime(pt.imageProcessing||0)}</span>`;
        html += `<span class="tZip">ZIP&nbsp;${fmtTime(pt.zip||0)}</span>`;
        html += '</div>';
        html += '<table class="statsTable">';
        html += `<tr><td>Итого</td><td>${fmtTime(s.totalTime)}</td></tr>`;
        if (s.totalImages > 0 && s.totalTime > 0) {
            const ips = (s.totalImages / (s.totalTime / 1000)).toFixed(1);
            html += `<tr><td>Скорость</td><td>${ips} изобр./с</td></tr>`;
        }
        html += '</table>';

        // изображения (только если есть)
        if (s.totalImages > 0) {
            const fmts = Object.entries(s.formats).map(([k, v]) => `${k}: ${v}`).join(', ');
            html += '<div class="statsTableTitle" style="margin-top:12px">Изображения</div>';
            html += '<table class="statsTable">';
            html += `<tr><td>Всего</td><td>${s.totalImages}</td></tr>`;
            html += `<tr><td>Форматы</td><td>${fmts || '—'}</td></tr>`;
            html += `<tr><td>Уникальных</td><td>${s.uniqueImages}</td></tr>`;
            if (s.duplicates > 0) html += `<tr><td>Дубликатов</td><td>${s.duplicates}</td></tr>`;
            html += `<tr><td>Переведено в WebP</td><td>${s.webpConversions}</td></tr>`;
            if (s.keptOriginal > 0) html += `<tr><td>Оставлено оригинал</td><td>${s.keptOriginal}</td></tr>`;
            html += `<tr><td>Размер до</td><td>${formatSize(s.sizeBefore)}</td></tr>`;
            html += `<tr><td>Размер после WebP</td><td>${formatSize(s.sizeAfter)}</td></tr>`;
            if (s.webpSavings > 0) html += `<tr><td>Экономия WebP</td><td>${formatSize(s.webpSavings)}</td></tr>`;
            html += `<tr><td>Степень сжатия</td><td>${s.compressionRatio}%</td></tr>`;
            html += '</table>';
        }
        // видео (показываем даже если все видео были пропущены)
        const totalSeqFound = s.sequences + s.videoSkipped;
        if (totalSeqFound > 0) {
            html += '<div class="statsTableTitle" style="margin-top:12px">Кодирование видео</div>';
            html += '<table class="statsTable">';
            html += `<tr><td>Найдено последовательностей</td><td>${totalSeqFound}</td></tr>`;
            if (s.sequences > 0) {
                html += `<tr><td>Закодировано</td><td>${s.sequences}</td></tr>`;
                html += `<tr><td>Кадров в видео</td><td>${s.framesInVideo}</td></tr>`;
                html += `<tr><td>Размер видео</td><td>${formatSize(s.videoSize)}</td></tr>`;
            }
            if (s.videoSkipped > 0) {
                html += `<tr><td>Пропущено (видео > оригинала)</td><td>${s.videoSkipped}</td></tr>`;
            }
            html += '</table>';

            for (const vd of s.videoDetails) {
                const es = vd.encodingStats || {};
                html += '<div class="videoDetailCard">';
                html += `<div class="videoDetailTitle">${vd.file}</div>`;
                html += '<div class="videoDetailGrid">';
                html += `<span>Разрешение</span><strong>${vd.width}×${vd.height}</strong>`;
                html += `<span>Кадров</span><strong>${vd.frames}</strong>`;
                html += `<span>FPS</span><strong>${vd.fps}</strong>`;
                html += `<span>Длительность</span><strong>${vd.duration.toFixed(2)} с</strong>`;
                html += `<span>Файл</span><strong>${formatSize(vd.fileSize)}</strong>`;
                html += `<span>Было</span><strong>${formatSize(vd.originalSize)}</strong>`;
                html += `<span>Сжатие</span><strong>${vd.compressionRatio}%</strong>`;
                html += `<span>Кодек</span><strong>H.264</strong>`;
                if (es.bitrateTarget) html += `<span>Целевой битрейт</span><strong>${(es.bitrateTarget/1000).toFixed(0)} кбит/с</strong>`;
                if (es.bitrateActual) html += `<span>Реальный битрейт</span><strong>${(es.bitrateActual/1000).toFixed(0)} кбит/с</strong>`;
                if (es.keyFrames !== undefined) {
                    html += `<span>Ключевых кадров</span><strong>${es.keyFrames}</strong>`;
                    html += `<span>Дельта-кадров</span><strong>${es.deltaFrames}</strong>`;
                }
                if (es.avgBitsPerFrame) html += `<span>Среднее бит/кадр</span><strong>${(es.avgBitsPerFrame/1000).toFixed(1)} кбит</strong>`;
                if (es.peakFrameSize) {
                    html += `<span>Макс. кадр</span><strong>${formatSize(es.peakFrameSize)}</strong>`;
                    html += `<span>Мин. кадр</span><strong>${formatSize(es.minFrameSize)}</strong>`;
                }
                if (es.hardwareAcceleration) html += `<span>Ускорение</span><strong>${es.hardwareAcceleration}</strong>`;
                if (es.encodingFps) html += `<span>Скорость</span><strong>${es.encodingFps} fps</strong>`;
                if (es.containerOverhead !== undefined) html += `<span>MP4 overhead</span><strong>${formatSize(es.containerOverhead)}</strong>`;
                if (es.configureTime) {
                    html += `<span>Настройка</span><strong>${fmtTime(es.configureTime)}</strong>`;
                    html += `<span>Кодирование</span><strong>${fmtTime(es.encodeTime)}</strong>`;
                    html += `<span>Мультиплекс</span><strong>${fmtTime(es.muxTime)}</strong>`;
                    html += `<span>Итого видео</span><strong>${fmtTime(es.totalTime)}</strong>`;
                }
                html += '</div></div>';
            }
        }

        html += '</div>';
        container.innerHTML = html;
    }

    // оптимизируем одну демку или пользовательский файл
    async function optimizeSlotByIndex(data, index, fileName) {
        const bar = $(`demo-bar-${index}`);
        const text = $(`demo-text-${index}`);
        const statsEl = $(`demo-stats-${index}`);
        const beforeEl = $(`demo-before-${index}`);
        const afterEl = $(`demo-after-${index}`);

        bar.style.width = '0%';
        bar.className = 'progressBarFill';
        text.textContent = 'Загрузка...';
        statsEl.innerHTML = '';
        statsEl.classList.remove('show');

        try {
            createAnim(beforeEl, data);
        } catch (e) {
            log.err(`[${fileName}] не удалось отрисовать оригинал — ${e.message}`);
        }

        text.textContent = 'Оптимизация..';
        log.phase(`[${fileName}] начинается оптимизация`);

        const fileSize = new Blob([JSON.stringify(data)]).size;
        log.info(`[${fileName}] оригинал: ${formatSize(fileSize)}`);

        try {
            const result = await Optimizer.run(data, {
                quality: 0.8,
                convertToVideo: true,
                videoFps: 24,
                onProgress: (info) => {
                    bar.style.width = info.percent + '%';
                    text.textContent = info.message;
                    if (info.error) log.err(`[${fileName}] ${info.message}`);
                }
            });

            bar.style.width = '100%';
            bar.classList.add('done');
            const totalSec = (result.stats.totalTime / 1000).toFixed(2);
            text.textContent = `Готово за ${totalSec} с`;
            log.ok(`[${fileName}] готово — сэкономлено ${result.stats.totalSavedPct}%`);

            try {
                createAnim(afterEl, result.preview);
            } catch (e) {
                log.err(`[${fileName}] не удалось отрисовать превью — ${e.message}`);
            }

            renderStats(statsEl, result.stats, fileSize);
            statsEl.classList.add('show');

            return result;
        } catch (err) {
            bar.classList.add('error');
            bar.style.width = '100%';
            text.textContent = 'Ошибка: ' + err.message;
            log.err(`[${fileName}] ${err.message}`);
            console.error(err);
            return null;
        }
    }
    // грузим все демки по очереди
    async function loadAllDemos() {
        log.phase('Загрузка анимации...');
        for (let i = 0; i < DEMOS.length; i++) {
            const demo = DEMOS[i];
            const text = $(`demo-text-${i}`);
            text.textContent = 'Качаем...';

            try {
                const resp = await fetch(demo.file);
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const data = await resp.json();
                log.ok(`[${demo.name}] загружен`);
                await optimizeSlotByIndex(data, i, demo.name);
            } catch (err) {
                const bar = $(`demo-bar-${i}`);
                const text2 = $(`demo-text-${i}`);
                bar.classList.add('error');
                bar.style.width = '100%';
                text2.textContent = 'Ошибка: ' + err.message;
                log.err(`[${demo.name}] ${err.message}`);
            }
        }
        log.ok('Все демо-анимации обработаны');
    }

    // загрузка своего файла пользователем
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

    async function handleUserFile(file) {
        const userSlot = $('userSlot');
        const userDl = $('userDownloads');

        userSlot.style.display = '';
        userDl.style.display = 'none';
        $('user-name').textContent = file.name;

        const bar = $('user-bar');
        const text = $('user-text');
        const statsEl = $('user-stats');
        const beforeEl = $('user-before');
        const afterEl = $('user-after');

        bar.style.width = '0%';
        bar.className = 'progressBarFill';
        text.textContent = 'Парсим JSON...';
        statsEl.innerHTML = '';
        statsEl.classList.remove('show');
        afterEl.innerHTML = '';

        try {
            const data = JSON.parse(await file.text());

            createAnim(beforeEl, data);
            text.textContent = 'Оптимизируем...';
            log.phase(`[${file.name}] начинаем оптимизацию`);

            const result = await Optimizer.run(data, {
                quality: 0.8,
                convertToVideo: true,
                videoFps: 24,
                onProgress: (info) => {
                    bar.style.width = info.percent + '%';
                    text.textContent = info.message;
                    if (info.error) log.err(`[${file.name}] ${info.message}`);
                }
            });

            userResult = result;

            bar.style.width = '100%';
            bar.classList.add('done');
            const totalSec = (result.stats.totalTime / 1000).toFixed(2);
            text.textContent = `Готово за ${totalSec} с`;
            log.ok(`[${file.name}] готово — сэкономлено ${result.stats.totalSavedPct}%`);

            try {
                createAnim(afterEl, result.preview);
            } catch (e) {
                log.err(`[${file.name}] не удалось отрисовать превью — ${e.message}`);
            }

            renderStats(statsEl, result.stats, file.size);
            statsEl.classList.add('show');
            userDl.style.display = 'flex';

        } catch (err) {
            bar.classList.add('error');
            bar.style.width = '100%';
            text.textContent = 'Ошибка: ' + err.message;
            log.err(`[${file.name}] ${err.message}`);
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

    function download(blob, name) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        URL.revokeObjectURL(url);
    }

    // запускаем демки сразу при загрузке страницы
    loadAllDemos();
});