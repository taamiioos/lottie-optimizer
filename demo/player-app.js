import {Player} from '../src/index.js';

const $ = id => document.getElementById(id);

const fmt = (bytes) => {
    if (bytes === 0) return '0 B';
    const k = 1024, s = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + s[i];
};
const fmtTime = (ms) => ms < 1000 ? ms.toFixed(0) + ' ms' : (ms / 1000).toFixed(2) + ' s';

// глобальное состояние плеера: загруженные файлы и текущая анимация
const state = {json: null, zipBlob: null, anim: null};

// зоны перетаскивания файлов
const markZoneLoaded = (zoneId, hintId, sizeId, filename, size) => {
    $(zoneId).classList.add('loaded');
    const hintEl = $(hintId);
    if (hintEl) { hintEl.className = 'pl-zone-file'; hintEl.textContent = filename; }
    const sizeEl = $(sizeId);
    if (sizeEl) { sizeEl.textContent = fmt(size); sizeEl.style.display = ''; }
};

const setupZone = (zoneId, inputId, onFile) => {
    const zone = $(zoneId), input = $(inputId);
    zone.addEventListener('click', () => input.click());
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', (e) => { if (!zone.contains(e.relatedTarget)) zone.classList.remove('drag'); });
    zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('drag'); if (e.dataTransfer.files[0]) onFile(e.dataTransfer.files[0]); });
};

setupZone('zoneJson', 'jsonInput', async (file) => {
    try { state.json = JSON.parse(await file.text()); markZoneLoaded('zoneJson', 'jsonHint', 'jsonSize', file.name, file.size); }
    catch { showCompatStatus('error', 'Not a valid JSON file'); return; }
    checkReady();
    checkCompatibility();
});

setupZone('zoneZip', 'zipInput', (file) => {
    state.zipBlob = file;
    markZoneLoaded('zoneZip', 'zipHint', 'zipSize', file.name, file.size);
    checkReady();
    checkCompatibility();
});

$('jsonInput').onchange = async (e) => {
    const f = e.target.files[0];
    if (f) {
        try { state.json = JSON.parse(await f.text()); markZoneLoaded('zoneJson', 'jsonHint', 'jsonSize', f.name, f.size); }
        catch { showCompatStatus('error', 'Not a valid JSON file'); e.target.value = ''; return; }
        checkReady();
        checkCompatibility();
    }
    e.target.value = '';
};
$('zipInput').onchange = (e) => {
    const f = e.target.files[0];
    if (f) {
        state.zipBlob = f;
        markZoneLoaded('zoneZip', 'zipHint', 'zipSize', f.name, f.size);
        checkReady();
        checkCompatibility();
    }
    e.target.value = '';
};

// кнопка активна как только загружен JSON
const checkReady = () => { $('btnPlay').disabled = !state.json; };

// статус совместимости файлов
const showCompatStatus = (type, message) => {
    const el = $('compatStatus');
    el.className = `pl-compat-status pl-compat-${type}`;
    const icon = type === 'ok' ? '✓' : type === 'warn' ? '⚠' : '✗';
    el.textContent = `${icon} ${message}`;
};

const checkCompatibility = async () => {
    if (!state.json) { $('compatStatus').className = 'pl-compat-status'; $('compatStatus').textContent = ''; return; }
    const result = await Player.validate(state.json, state.zipBlob);
    if (result.errors.length > 0) {
        // нужен ZIP, но ещё не загружен — это не ошибка совместимости, а подсказка
        if (result.requiresZip && !state.zipBlob) {
            showCompatStatus('warn', 'ZIP archive required');
        } else {
            showCompatStatus('error', 'Files are incompatible');
        }
    } else {
        showCompatStatus('ok', result.requiresZip ? 'Files are compatible' : 'File ready');
    }
};

// сброс
const resetPlayer = () => {
    state.anim?.destroy(); state.anim = null; state.json = null; state.zipBlob = null;
    ['zoneJson', 'zoneZip'].forEach(id => $(id).classList.remove('loaded', 'drag'));
    $('jsonHint').className = 'pl-zone-hint'; $('jsonHint').textContent = 'optimized.json';
    $('zipHint').className  = 'pl-zone-hint'; $('zipHint').textContent  = 'assets.zip';
    $('jsonSize').style.display = 'none';
    $('zipSize').style.display  = 'none';
    $('btnPlay').disabled  = true;
    $('btnPlay').innerHTML = '<span class="pl-play-icon">▶</span><span>Play</span>';
    $('playerWrap').style.display = 'none';
    $('playerWrap').classList.remove('playing');
    $('playerPlaceholder').classList.remove('hidden');
    $('player').innerHTML = '';
    $('playerControls').style.display = 'none';
    $('statsSection').style.display   = 'none';
    $('statsSection').innerHTML = '';
    setProgress(0, '');
    $('progressFill').classList.remove('done', 'error');
    $('compatStatus').className = 'pl-compat-status';
    $('compatStatus').textContent = '';
};
$('btnReset').onclick = resetPlayer;

const setProgress = (pct, text) => {
    $('progressFill').style.width = pct + '%';
    $('progressLabel').textContent = text;
};

// воспроизведение
$('btnPlay').onclick = async () => {
    $('btnPlay').disabled  = true;
    $('btnPlay').innerHTML = '<span>Loading...</span>';
    $('progressFill').classList.remove('done', 'error');
    setProgress(0, 'Validating files...');

    const totalT0 = performance.now();

    try {
        const compat = await Player.validate(state.json, state.zipBlob);
        if (compat.errors.length > 0) {
            showCompatStatus('error', compat.errors[0]);
            $('progressFill').classList.add('error');
            setProgress(100, compat.errors[0]);
            $('btnPlay').disabled = false;
            $('btnPlay').innerHTML = '<span class="pl-play-icon">▶</span><span>Play</span>';
            return;
        }

        const {data, stats} = await Player.restoreInWorker(state.json, state.zipBlob || null, {
            onProgress: (info) => {
                if (info.phase === 'images') {
                    setProgress(5 + Math.round(info.percent * 0.85), `Image ${info.current}/${info.total}`);
                } else if (info.phase === 'video') {
                    setProgress(35 + Math.round(info.percent * 0.50), info.message);
                }
            }
        });

        const lottieT0 = performance.now();
        setProgress(90, 'Initializing Lottie...');

        state.anim?.destroy();
        $('player').innerHTML = '';

        // показываем обёртку ДО loadAnimation — иначе Lottie читает offsetWidth/Height = 0
        $('playerWrap').style.display = '';
        $('playerWrap').classList.add('playing');
        $('playerPlaceholder').classList.add('hidden');

        state.anim = lottie.loadAnimation({
            container: $('player'), renderer: 'canvas', loop: true, autoplay: true, animationData: data
        });

        stats.lottieInitTime = performance.now() - lottieT0;
        stats.totalTime      = performance.now() - totalT0;
        stats.animJson       = state.json;
        $('progressFill').classList.add('done');
        setProgress(100, fmtTime(stats.totalTime));

        renderStats(stats);
        setupControls(state.anim);

    } catch (err) {
        $('progressFill').classList.add('error');
        setProgress(100, 'Error: ' + err.message);
        $('btnPlay').disabled  = false;
        $('btnPlay').innerHTML = '<span class="pl-play-icon">▶</span><span>Play</span>';
        console.error(err);
    }
};

// управление плеером
const setupControls = (anim) => {
    $('playerControls').style.display = '';

    const scrubber  = $('scrubber');
    const frameInfo = $('frameInfo');
    const btnPause  = $('btnPause');
    const btnStop   = $('btnStop');
    const speedSel  = $('speedSelect');
    const btnLoop   = $('btnLoop');

    const totalFrames = Math.max(0, Math.floor(anim.totalFrames) - 1);
    scrubber.max = totalFrames;
    let playing = true, scrubbing = false, looping = true;

    const updateLabel = (f) => { frameInfo.textContent = `${Math.floor(f)} / ${totalFrames}`; };
    updateLabel(0);
    anim.addEventListener('enterFrame', (e) => {
        // во время перемотки мышью не трогаем скраббер из события анимации — иначе они конфликтуют
        if (scrubbing) return;
        scrubber.value = Math.floor(e.currentTime);
        updateLabel(e.currentTime);
    });
    anim.addEventListener('complete', () => { if (!looping) { playing = false; btnPause.innerHTML = '▶'; } });

    scrubber.addEventListener('pointerdown', () => { scrubbing = true; anim.pause(); });
    scrubber.addEventListener('input', () => { const f = parseInt(scrubber.value); anim.goToAndStop(f, true); updateLabel(f); });
    scrubber.addEventListener('pointerup', () => { scrubbing = false; if (playing) anim.play(); });

    btnPause.onclick = () => {
        if (playing) { anim.pause(); playing = false; btnPause.innerHTML = '▶'; }
        else         { anim.play();  playing = true;  btnPause.innerHTML = '⏸'; }
    };
    btnStop.onclick  = () => { anim.stop(); playing = false; scrubber.value = 0; updateLabel(0); btnPause.innerHTML = '▶'; };
    speedSel.onchange = () => { anim.setSpeed(parseFloat(speedSel.value)); };
    btnLoop.onclick  = () => { looping = !looping; anim.setLoop(looping); btnLoop.classList.toggle('active', looping); };
};

// статистика
const renderStats = (s) => {
    const el = $('statsSection');
    el.style.display = '';

    const row  = (pfx, key, val, valCls = '') =>
        `<div class="rtRow"><span class="rtPfx">${pfx}</span><span class="rtKey">${key}</span><span class="rtVal${valCls ? ' ' + valCls : ''}">${val}</span></div>`;
    const rows = (items) => items.map((item, i) =>
        row(i === items.length - 1 ? '└' : '├', item[0], item[1], item[2] || '')
    ).join('');

    const animFps    = s.animJson?.fr || 0;
    const animFrames = s.animJson?.op || 0;
    const animW      = s.animJson?.w  || 0;
    const animH      = s.animJson?.h  || 0;
    const animDur    = animFps > 0 ? (animFrames / animFps).toFixed(2) : '—';

    let html = '<div class="statsInner">';

    html += '<div class="statsGrid">';
    html += `<div class="statBox"><div class="statLabel">Total</div><div class="statValue">${fmtTime(s.totalTime)}</div></div>`;
    if (s.imageCount > 0)
        html += `<div class="statBox"><div class="statLabel">Images</div><div class="statValue">${s.imageCount}</div><div class="statDetail">${fmt(s.imageTotalSize)}</div></div>`;
    if (s.videoTotalFrames > 0)
        html += `<div class="statBox"><div class="statLabel">Video frames</div><div class="statValue">${s.videoTotalFrames}</div><div class="statDetail">${s.videoCount} videos · ${fmt(s.videoTotalSize)}</div></div>`;
    html += '</div>';

    const phaseSum = s.imageDecodeTime + s.videoDecodeTime + (s.lottieInitTime || 0) || 1;
    html += '<div class="statsTableTitle">Processing time</div><div class="timingBar">';
    if (s.imageCount > 0)       html += `<div class="timingSegment images" style="width:${s.imageDecodeTime / phaseSum * 100}%"></div>`;
    if (s.videoTotalFrames > 0) html += `<div class="timingSegment video"  style="width:${s.videoDecodeTime  / phaseSum * 100}%"></div>`;
    if (s.lottieInitTime > 0)   html += `<div class="timingSegment zip"    style="width:${s.lottieInitTime   / phaseSum * 100}%"></div>`;
    html += '</div><div class="timingLegend">';
    if (s.imageCount > 0)       html += `<span class="tImages">Images&nbsp;${fmtTime(s.imageDecodeTime)}</span>`;
    if (s.videoTotalFrames > 0) html += `<span class="tVideo">Video&nbsp;${fmtTime(s.videoDecodeTime)}</span>`;
    html += `<span class="tZip">Init&nbsp;${fmtTime(s.lottieInitTime || 0)}</span></div>`;
    const decodeFps = s.videoTotalFrames > 0 && s.videoDecodeTime > 0
        ? (s.videoTotalFrames / (s.videoDecodeTime / 1000)).toFixed(1)
        : null;
    html += `<table class="statsTable">
        <tr><td>Total</td><td>${fmtTime(s.totalTime)}</td></tr>
        ${decodeFps ? `<tr><td>Decode speed</td><td>${decodeFps} frames/sec</td></tr>` : ''}
    </table>`;

    html += '<div class="resultBlock">';

    if (animW > 0) {
        html += `<div class="resultCard" style="border-left-color:#475569">
            <div class="rcHead"><span class="rcTitle">ANIMATION</span><span class="rcBadge">${animW}×${animH} · ${animFps} fps</span></div>
            <div class="rtBody">${rows([['Size', `${animW}×${animH} px`], ['FPS', `${animFps}`], ['Duration', `${animDur} s`], ['Frames', `${animFrames}`]])}</div>
        </div>`;
    }

    if (s.imageCount > 0) {
        const imgItems = [['Files', `${s.imageCount}`], ['Total size', fmt(s.imageTotalSize)], ['Time', fmtTime(s.imageDecodeTime)]];
        if (s.imageDecodeTime > 0) imgItems.push(['Speed', `${(s.imageCount / (s.imageDecodeTime / 1000)).toFixed(1)} files/s`]);
        html += `<div class="resultCard" style="border-left-color:var(--accent)">
            <div class="rcHead"><span class="rcTitle">IMAGES</span><span class="rcBadge">${s.imageCount} files</span></div>
            <div class="rtBody">${rows(imgItems)}</div>
        </div>`;
    }

    for (const vd of s.videoDetails) {
        const vItems = [
            ['Resolution', `${vd.width}×${vd.height} px`],
            ['Frames', `${vd.frames} @ ${vd.fps} fps`],
            ['Size', fmt(vd.fileSize)],
            ['Time', fmtTime(vd.extractTime)],
            ['Avg per frame', fmtTime(vd.avgFrameExtract)],
            ['Acceleration', vd.hardwareAccel],
            ['Decoder API', vd.decoderApi],
        ];
        if (vd.frames > 0 && vd.extractTime > 0) vItems.push(['Speed', `${(vd.frames / (vd.extractTime / 1000)).toFixed(1)} fps`]);
        html += `<div class="resultCard" style="border-left-color:#6366f1">
            <div class="rcHead"><span class="rcTitle">VIDEO</span><span class="rcBadge">${vd.file}</span></div>
            <div class="rtBody">${rows(vItems)}</div>
        </div>`;
    }

    html += '</div></div>';
    el.innerHTML = html;
};
