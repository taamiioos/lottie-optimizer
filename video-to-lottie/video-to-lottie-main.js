import {$, formatSize} from '../demo/common/common.js';

/**
 * Rewinds the video to the specified time and waits for the rewind to finish
 */
const seekTo = (video, time) => new Promise((res) => {
    if (Math.abs(video.currentTime - time) < 0.001) {
        res();
        return;
    }
    const done = () => {
        video.removeEventListener('seeked', done);
        res();
    };
    video.addEventListener('seeked', done);
    video.currentTime = time;
});

/**
 * Converts canvas to Blob (WebP)
 */
const canvasToBlob = (canvas, quality) => {
    if (canvas.convertToBlob) return canvas.convertToBlob({type: 'image/webp', quality});
    return new Promise((r) => canvas.toBlob(r, 'image/webp', quality));
};

/**
 * Extracts frames from a video using WebCodecs + MP4Box
 */
const extractFramesWebCodecs = async (videoFile, fps, maxFrames, quality, onProgress) => {
    const FEED_CHUNK = 8 * 1024 * 1024;
    const MAX_QUEUE = 24;
    const {samples, trackInfo, description} = await new Promise((resolve, reject) => {
        const mp4file = MP4Box.createFile();
        const collected = [];
        let info = null, desc = null;
        mp4file.onReady = (mp4info) => {
            const track = mp4info.videoTracks[0];
            if (!track) return reject(new Error('No video track'));
            info = track;
            const trak = mp4file.getTrackById(track.id);
            for (const entry of trak.mdia.minf.stbl.stsd.entries) {
                if (entry.avcC) {
                    const s = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                    entry.avcC.write(s);
                    desc = new Uint8Array(s.buffer, 8);
                    break;
                }
            }
            mp4file.setExtractionOptions(track.id, null, {nbSamples: Infinity});
            mp4file.start();
        };
        mp4file.onSamples = (id, user, batch) => {
            for (let i = 0; i < batch.length; i++) collected.push(batch[i]);
        };
        mp4file.onError = (e) => reject(new Error('MP4Box: ' + e));
        (async () => {
            let offset = 0;
            while (offset < videoFile.size) {
                const end = Math.min(offset + FEED_CHUNK, videoFile.size);
                const buf = await videoFile.slice(offset, end).arrayBuffer();
                buf.fileStart = offset;
                offset = end;
                mp4file.appendBuffer(buf);
                await new Promise((r) => setTimeout(r, 0));
            }
            mp4file.flush();
            if (!info) return reject(new Error('No video track found'));
            resolve({samples: collected, trackInfo: info, description: desc});
        })().catch(reject);
    });
    const w = trackInfo.video.width, h = trackInfo.video.height;
    let duration = trackInfo.duration / trackInfo.timescale;
    if (!duration && samples.length > 0) {
        const last = samples[samples.length - 1];
        duration = (last.cts + last.duration) / last.timescale;
    }
    if (!duration) throw new Error('Cannot determine video duration');
    const total = Math.min(Math.ceil(duration * fps), maxFrames);
    if (total <= 0) throw new Error('No frames to extract');
    let hwAccel = 'prefer-software';
    const sup = await VideoDecoder.isConfigSupported({
        codec: trackInfo.codec, codedWidth: w, codedHeight: h,
        hardwareAcceleration: 'prefer-hardware'
    });
    if (sup.supported) hwAccel = 'prefer-hardware';
    const frames = new Array(total);
    let nextTarget = 0;
    let totalFrameSize = 0;
    const pendingBlobs = [];
    await new Promise((resolve, reject) => {
        const decoder = new VideoDecoder({
            output: (frame) => {
                const ts = frame.timestamp / 1_000_000;
                while (nextTarget < total && ts >= nextTarget / fps) {
                    const idx = nextTarget;
                    const fc = new OffscreenCanvas(w, h);
                    fc.getContext('2d').drawImage(frame, 0, 0);
                    const p = canvasToBlob(fc, quality).then((blob) => {
                        frames[idx] = blob;
                        totalFrameSize += blob.size;
                        onProgress(pendingBlobs.length, total, 'extract');
                    });
                    pendingBlobs.push(p);
                    nextTarget++;
                }
                frame.close();
            },
            error: (e) => reject(new Error('VideoDecoder: ' + e.message))
        });
        decoder.configure({
            codec: trackInfo.codec, codedWidth: w, codedHeight: h,
            description: description || undefined,
            hardwareAcceleration: hwAccel
        });
        (async () => {
            for (const sample of samples) {
                while (decoder.decodeQueueSize >= MAX_QUEUE) {
                    await new Promise((r) => setTimeout(r, 4));
                }
                decoder.decode(new EncodedVideoChunk({
                    type: sample.is_sync ? 'key' : 'delta',
                    timestamp: sample.cts * 1_000_000 / sample.timescale,
                    duration: sample.duration * 1_000_000 / sample.timescale,
                    data: sample.data
                }));
            }
            await decoder.flush();
            decoder.close();
            await Promise.all(pendingBlobs);
            resolve();
        })().catch(reject);
    });
    const result = frames.filter(Boolean);
    return {frames: result, width: w, height: h, duration, fps, total: result.length, totalFrameSize};
};

/**
 * Retrieves frames through HTMLVideoElement rewinding
 */
const extractFramesSeeked = async (videoFile, fps, maxFrames, quality, onProgress) => {
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    const url = URL.createObjectURL(videoFile);
    video.src = url;

    await new Promise((res, rej) => {
        video.onloadedmetadata = res;
        video.onerror = () => rej(new Error('Browser could not load video'));
    });
    const {videoWidth: w, videoHeight: h, duration} = video;
    if (!w || !h) throw new Error('Video has no video track');
    const total = Math.min(Math.ceil(duration * fps), maxFrames);
    const frameCanvases = [];
    for (let i = 0; i < total; i++) {
        await seekTo(video, i / fps);
        if (typeof OffscreenCanvas !== 'undefined') {
            const fc = new OffscreenCanvas(w, h);
            fc.getContext('2d').drawImage(video, 0, 0);
            frameCanvases.push(fc);
        } else {
            const fc = document.createElement('canvas');
            fc.width = w;
            fc.height = h;
            fc.getContext('2d').drawImage(video, 0, 0);
            frameCanvases.push(fc);
        }
        onProgress(i + 1, total, 'extract');
        if (i % 10 === 9) await new Promise((r) => setTimeout(r, 0));
    }
    URL.revokeObjectURL(url);
    let totalFrameSize = 0;
    const frames = await Promise.all(frameCanvases.map(async (fc) => {
        const blob = await canvasToBlob(fc, quality);
        totalFrameSize += blob.size;
        return blob;
    }));
    return {frames, width: w, height: h, duration, fps, total, totalFrameSize};
};

/**
 * Extracts frames from a video
 */
const extractFrames = async (videoFile, fps, maxFrames, quality, onProgress) => {
    if ('VideoDecoder' in window && typeof MP4Box !== 'undefined') {
        try {
            console.log('[VideoToLottie] Using WebCodecs + MP4Box (hardware/software decoding)');
            return await extractFramesWebCodecs(videoFile, fps, maxFrames, quality, onProgress);
        } catch (err) {
            console.warn('[VideoToLottie] WebCodecs path failed, falling back to seeked:', err.message);
        }
    }
    return await extractFramesSeeked(videoFile, fps, maxFrames, quality, onProgress);
};

/**
 * Collects JSON Lottie animations from an array of Blob frames
 */
const buildLottieJson = async (frames, width, height, fps, name, onProgress) => {
    const BATCH = 20;
    const dataUrls = new Array(frames.length);
    for (let i = 0; i < frames.length; i += BATCH) {
        const end = Math.min(i + BATCH, frames.length);
        const batch = frames.slice(i, end);
        const results = await Promise.all(batch.map((blob) => new Promise((r) => {
            const fr = new FileReader();
            fr.onload = () => r(fr.result);
            fr.readAsDataURL(blob);
        })));
        results.forEach((r, j) => {
            dataUrls[i + j] = r;
        });
        onProgress(end, frames.length, 'build');
        await new Promise((r) => setTimeout(r, 0));
    }
    const assets = dataUrls.map((p, i) => ({id: `frame_${i}`, w: width, h: height, p, u: '', e: 1}));
    const layers = dataUrls.map((_, i) => ({
        ty: 2, refId: `frame_${i}`, nm: `frame_${i}`, ind: i + 1,
        ip: i, op: i + 1, st: 0, sr: 1, ao: 0, bm: 0, ddd: 0,
        ks: {
            o: {a: 0, k: 100}, r: {a: 0, k: 0},
            p: {a: 0, k: [width / 2, height / 2, 0]},
            a: {a: 0, k: [width / 2, height / 2, 0]},
            s: {a: 0, k: [100, 100, 100]}
        }
    }));
    return {v: '5.7.4', fr: fps, ip: 0, op: frames.length, w: width, h: height, nm: name, ddd: 0, assets, layers};
};

/**
 * Converts a video file to Lottie JSON
 */
const convertVideoToLottie = async (videoFile, {
    fps = 24, maxFrames = 150, quality = 0.85, onProgress = () => {}
} = {}) => {
    const name = videoFile.name.replace(/\.[^.]+$/, '');
    const frameData = await extractFrames(videoFile, fps, maxFrames, quality, (cur, total) => {
        onProgress({
            phase: 'extract',
            message: `Extracting frames: ${cur} / ${total}`,
            current: cur,
            total,
            percent: Math.round(cur / total * 50)
        });
    });
    onProgress({
        phase: 'build',
        message: 'Building Lottie JSON...',
        current: 0,
        total: frameData.frames.length,
        percent: 50
    });
    const json = await buildLottieJson(frameData.frames, frameData.width, frameData.height, fps, name, (cur, total) => {
        onProgress({
            phase: 'build',
            message: `Encoding: ${cur} / ${total}`,
            current: cur,
            total,
            percent: 50 + Math.round(cur / total * 50)
        });
    });
    return {
        json,
        frameStats: {
            count: frameData.total,
            totalFrameSize: frameData.totalFrameSize,
            width: frameData.width,
            height: frameData.height,
            duration: frameData.duration,
            fps
        }
    };
};

/**
 * Formats seconds into a readable string
 */
const fmtTimeSec = (sec) => {
    const m = Math.floor(sec / 60), s = (sec % 60).toFixed(1);
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
};

/**
 * Binds the slider to the value display and calls updateEstimate when changed
 */
const syncSlider = (rangeId, valId, decimals = 0) => {
    const range = $(rangeId), val = $(valId);
    range.addEventListener('input', () => {
        val.textContent = parseFloat(range.value).toFixed(decimals);
        updateEstimate();
    });
};

syncSlider('fpsRange', 'fpsVal');
$('fpsVal').textContent = '30';
syncSlider('maxFramesRange', 'maxFramesVal');
syncSlider('qualityRange', 'qualityVal', 2);

const uploadArea = $('uploadArea');
const fileInput = $('fileInput');
let resultJson = null;
let currentFile = null;
let probe = null;

/** Updates the estimated number of frames based on the current settings */
const updateEstimate = () => {
    if (!probe || !currentFile) return;
    const fps = parseInt($('fpsRange').value);
    const maxFrames = parseInt($('maxFramesRange').value);
    const est = Math.min(Math.ceil(probe.duration * fps), maxFrames);
    $('infoEst').textContent = est + ' кадр(ов)';
};

uploadArea.addEventListener('click', () => fileInput.click());
uploadArea.addEventListener('dragover', (e) => {
    e.preventDefault();
    uploadArea.classList.add('dragover');
});
uploadArea.addEventListener('dragleave', () => uploadArea.classList.remove('dragover'));
uploadArea.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    uploadArea.classList.remove('dragover');
    const f = e.dataTransfer.files[0];
    if (f && f.type.startsWith('video/')) onFile(f);
});
fileInput.addEventListener('change', (e) => {
    if (e.target.files[0]) onFile(e.target.files[0]);
    e.target.value = '';
});

/**
 * Processes the selected video file
 */
const onFile = (file) => {
    currentFile = file;
    resultJson = null;
    if (!probe) {
        probe = document.createElement('video');
        probe.muted = true;
        probe.style.display = 'none';
        document.body.appendChild(probe);
    }
    const url = URL.createObjectURL(file);
    probe.src = url;
    probe.onloadedmetadata = () => {
        URL.revokeObjectURL(url);
        const fps = parseInt($('fpsRange').value);
        $('infoName').textContent = file.name;
        $('infoRes').textContent = `${probe.videoWidth}×${probe.videoHeight}`;
        $('infoDur').textContent = fmtTimeSec(probe.duration);
        $('infoEst').textContent = Math.ceil(probe.duration * fps) + ' frame(s)';
        $('mainCard').hidden = false;
        $('resultBlock').hidden = true;
        $('progressFill').style.width = '0%';
        $('progressFill').className = 'progressBarFill';
        $('progressText').textContent = '';
        uploadArea.querySelector('.uploadText').innerHTML = `<strong>${file.name}</strong> loaded`;
    };
    probe.onerror = () => {
        URL.revokeObjectURL(url);
        uploadArea.querySelector('.uploadText').textContent = 'Failed to read video';
    };

    $('convertBtn').onclick = () => startConvert(file);
};

/**
 * Starts converting a video to Lottie JSON
 */
const startConvert = async (file) => {
    const fps = parseInt($('fpsRange').value);
    const maxFrames = parseInt($('maxFramesRange').value);
    const quality = parseFloat($('qualityRange').value);
    $('resultBlock').hidden = true;
    const controls = [$('convertBtn'), $('resetSettingsBtn'), $('fpsRange'), $('maxFramesRange'), $('qualityRange')];
    controls.forEach((el) => { el.disabled = true; });
    const bar = $('progressFill');
    const txt = $('progressText');
    bar.style.width = '0%';
    bar.className = 'progressBarFill';
    txt.textContent = '';
    const t0 = performance.now();
    try {
        const {json, frameStats} = await convertVideoToLottie(file, {
            fps, maxFrames, quality,
            onProgress: ({message, percent}) => {
                bar.style.width = percent + '%';
                txt.textContent = message;
            }
        });
        const elapsed = performance.now() - t0;
        bar.style.width = '100%';
        bar.classList.add('done');
        txt.textContent = 'Done in ' + fmtTimeSec(elapsed / 1000);
        resultJson = json;
        showResult(json, frameStats, elapsed);
    } catch (err) {
        bar.className = 'progressBarFill error';
        txt.textContent = 'Error: ' + err.message;
        console.error(err);
    } finally {
        controls.forEach((el) => { el.disabled = false; });
    }
};

/**
 * Collects JSON in Blob in chunks, so as not to keep the whole string JSON in memory
 */
const buildJsonBlob = (json) => {
    const skeleton = JSON.stringify({...json, assets: undefined, layers: undefined}).slice(0, -1);
    const parts = [skeleton + ',"assets":['];
    for (let i = 0; i < json.assets.length; i++) {
        if (i > 0) parts.push(',');
        parts.push(JSON.stringify(json.assets[i]));
    }
    parts.push('],"layers":[');
    for (let i = 0; i < json.layers.length; i++) {
        if (i > 0) parts.push(',');
        parts.push(JSON.stringify(json.layers[i]));
    }
    parts.push(']}');
    return new Blob(parts, {type: 'application/json'});
};

/**
 * Displays the conversion result
 */
const showResult = (json, frameStats, elapsed = 0) => {
    $('resultBlock').hidden = false;
    const estBytes = (json.assets || []).reduce((s, a) => s + (a.p ? Math.round(a.p.length * 0.75) : 0), 0);
    $('resFrames').textContent = frameStats?.count ?? json.op;
    $('resTime').textContent = fmtTimeSec(elapsed / 1000);
    $('resFps').textContent = (frameStats?.fps ?? json.fr) + ' fps';
    $('resRes').textContent = `${frameStats?.width ?? json.w}×${frameStats?.height ?? json.h}`;
    $('resSize').textContent = formatSize(estBytes || frameStats?.totalFrameSize || 0);
    $('downloadBtn').onclick = () => {
        try {
            const blob = buildJsonBlob(json);
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = (json.nm || 'animation') + '.lottie_test.json';
            a.click();
            URL.revokeObjectURL(url);
        } catch (e) {
            alert('Download failed: ' + e.message);
        }
    };
    const box = $('previewBox');
    box.innerHTML = '';
    try {
        lottie.loadAnimation({
            container: box,
            renderer: 'canvas',
            loop: true,
            autoplay: true,
            animationData: json,
            assetsPath: ''
        });
    } catch {
        box.textContent = 'Preview not available';
    }
};
/** Resets the entire page state */
const resetTool = () => {
    currentFile = null;
    resultJson = null;
    $('resultBlock').hidden = true;
    $('mainCard').hidden = true;
    $('progressFill').style.width = '0%';
    $('progressFill').className = 'progressBarFill';
    $('progressText').textContent = '';
    [$('convertBtn'), $('resetSettingsBtn'), $('fpsRange'), $('maxFramesRange'), $('qualityRange')]
        .forEach((el) => { el.disabled = false; });
    uploadArea.querySelector('.uploadText').textContent = 'Drop video here or click to upload';
};

$('resetBtn').addEventListener('click', resetTool);
$('resetSettingsBtn').addEventListener('click', resetTool);
