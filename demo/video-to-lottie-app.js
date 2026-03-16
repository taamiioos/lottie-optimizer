import {convertVideoToLottie} from '../src/video-to-lottie.js';
import {formatSize} from '../src/optimizer.js';

const $ = id => document.getElementById(id);

const fmtTime = (sec) => {
    const m = Math.floor(sec / 60), s = (sec % 60).toFixed(1);
    return m > 0 ? `${m}м ${s}с` : `${s}с`;
};

// слайдеры настроек
const syncSlider = (rangeId, valId, decimals = 0) => {
    const range = $(rangeId), val = $(valId);
    const update = () => { val.textContent = parseFloat(range.value).toFixed(decimals); updateEstimate(); };
    range.oninput = update;
};
syncSlider('fpsRange', 'fpsVal');
syncSlider('maxFramesRange', 'maxFramesVal');
syncSlider('qualityRange', 'qualityVal', 2);

const updateEstimate = () => {
    if (!currentFile) return;
    const video = document.querySelector('video[data-info]');
    if (!video) return;
    const fps = parseInt($('fpsRange').value);
    const max = parseInt($('maxFramesRange').value);
    $('infoEst').textContent = Math.min(Math.ceil(video.duration * fps), max) + ' кадр(ов)';
};

// загрузка файла
const uploadArea = $('uploadArea');
const fileInput  = $('fileInput');
let resultJson   = null;
let currentFile  = null;

uploadArea.onclick    = () => fileInput.click();
uploadArea.ondragover = (e) => { e.preventDefault(); uploadArea.classList.add('dragover'); };
uploadArea.ondragleave = () => uploadArea.classList.remove('dragover');
uploadArea.ondrop = (e) => {
    e.preventDefault(); e.stopPropagation();
    uploadArea.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) onFile(f);
};
fileInput.onchange = (e) => { if (e.target.files[0]) onFile(e.target.files[0]); e.target.value = ''; };

const onFile = (file) => {
    currentFile = file;
    resultJson  = null;

    let probe = document.querySelector('video[data-info]');
    if (!probe) {
        probe = document.createElement('video');
        probe.setAttribute('data-info', '1');
        probe.muted = true;
        probe.style.display = 'none';
        document.body.appendChild(probe);
    }

    const url = URL.createObjectURL(file);
    probe.src = url;
    probe.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        const fps = parseInt($('fpsRange').value);
        const max = parseInt($('maxFramesRange').value);
        const est = Math.min(Math.ceil(probe.duration * fps), max);

        $('infoName').textContent = file.name;
        $('infoRes').textContent  = `${probe.videoWidth}×${probe.videoHeight}`;
        $('infoDur').textContent  = fmtTime(probe.duration);
        $('infoEst').textContent  = est + ' кадр(ов)';
        $('videoInfo').hidden     = false;
        $('settingsBlock').hidden = false;
        $('progressBlock').hidden = true;
        $('resultBlock').hidden   = true;

        uploadArea.querySelector('.uploadText').innerHTML = `<strong>${file.name}</strong> загружено`;
    };
    probe.onerror = () => {
        URL.revokeObjectURL(url);
        uploadArea.querySelector('.uploadText').textContent = 'Не удалось прочитать видео';
    };

    $('convertBtn').onclick = () => startConvert(file);
};

const startConvert = async (file) => {
    const fps       = parseInt($('fpsRange').value);
    const maxFrames = parseInt($('maxFramesRange').value);
    const quality   = parseFloat($('qualityRange').value);

    $('settingsBlock').hidden = true;
    $('videoInfo').hidden     = true;
    $('progressBlock').hidden = false;
    $('resultBlock').hidden   = true;

    const bar = $('progressFill');
    const txt = $('progressText');
    bar.style.width = '0%';
    bar.className   = 'progressBarFill';

    try {
        const json = await convertVideoToLottie(file, {
            fps, maxFrames, quality,
            onProgress: ({message, percent}) => {
                bar.style.width = percent + '%';
                txt.textContent = message;
            }
        });

        bar.style.width = '100%';
        bar.classList.add('done');
        txt.textContent = 'Готово!';
        resultJson = json;
        showResult(json, json.op, json.fr, json.w, json.h, json.nm);
    } catch (err) {
        bar.className   = 'progressBarFill error';
        txt.textContent = 'Ошибка: ' + err.message;
        console.error(err);
        $('settingsBlock').hidden = false;
    }
};

const showResult = (json, frames, fps, width, height, name) => {
    $('progressBlock').hidden = true;
    $('resultBlock').hidden   = false;

    const jsonStr   = JSON.stringify(json);
    const sizeBytes = new Blob([jsonStr]).size;

    $('resFrames').textContent = frames;
    $('resFps').textContent    = fps + ' fps';
    $('resRes').textContent    = `${width}×${height}`;
    $('resSize').textContent   = formatSize(sizeBytes);

    const warning = $('resWarning');
    if (sizeBytes > 5 * 1024 * 1024) {
        warning.textContent = `⚠ Файл ${formatSize(sizeBytes)} — рекомендуем прогнать через оптимизатор`;
        warning.hidden = false;
    } else {
        warning.hidden = true;
    }

    $('downloadBtn').onclick = () => {
        const blob = new Blob([jsonStr], {type: 'application/json'});
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = name + '.lottie.json'; a.click();
        URL.revokeObjectURL(url);
    };

    const box = $('previewBox');
    box.innerHTML = '';
    try {
        lottie.loadAnimation({container: box, renderer: 'canvas', loop: true, autoplay: true, animationData: json, assetsPath: ''});
    } catch { box.textContent = 'Превью недоступно'; }
};

const resetTool = () => {
    currentFile = null;
    resultJson  = null;
    $('resultBlock').hidden   = true;
    $('progressBlock').hidden = true;
    $('settingsBlock').hidden = true;
    $('videoInfo').hidden     = true;
    uploadArea.querySelector('.uploadText').textContent = 'Перетащите видео или нажмите для загрузки';
};
$('resetBtn').onclick         = resetTool;
$('resetSettingsBtn').onclick = resetTool;
