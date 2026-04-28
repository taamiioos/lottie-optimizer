import {fmtTime, formatSize, statRow} from '../common/common.js';

const rows = (items) => items.map((item, i) =>
    statRow(i === items.length - 1 ? '└' : '├', item[0], item[1], item[2] || '')
).join('');

// Рендерит полный блок статистики оптимизации в переданный контейнер
export const renderStats = (container, stats, originalFileSize, animData) => {
    const lottieSize = stats.zipFileSize;
    const saved = originalFileSize - lottieSize;
    const savedPct = originalFileSize > 0 ? (saved / originalFileSize * 100).toFixed(2) : '0.00';
    const cls = saved > 0 ? 'positive' : saved < 0 ? 'negative' : '';
    let html = '<div class="statsInner">';
    html += `<div class="statsGrid">
        <div class="statBox">
            <div class="statLabel">Before</div>
            <div class="statValue">${formatSize(originalFileSize)}</div>
            <div class="statDetail">JSON + base64</div>
        </div>
        <div class="statBox">
            <div class="statLabel">After</div>
            <div class="statValue">${formatSize(lottieSize)}</div>
            <div class="statDetail">.lottie</div>
        </div>
        <div class="statBox ${cls}">
            <div class="statLabel">Saved</div>
            <div class="statValue">${savedPct} %</div>
            <div class="statDetail">${formatSize(Math.abs(saved))}</div>
        </div>
    </div>`;
    // Тайм-бар по фазам
    const pt = stats.phaseTiming;
    const phaseSum = (pt.analysis || 0) + (pt.videoEncoding || 0) + (pt.imageProcessing || 0) + (pt.zip || 0) || 1;
    const showImgTiming = stats.totalImages > 0 && stats.framesInVideo < stats.totalImages;
    html += '<div class="statsTableTitle">Processing time</div>';
    html += '<div class="timingBar">';
    html += `<div class="timingSegment analysis" style="width:${(pt.analysis || 0) / phaseSum * 100}%"></div>`;
    html += `<div class="timingSegment video"    style="width:${(pt.videoEncoding || 0) / phaseSum * 100}%"></div>`;
    if (showImgTiming) {
        html += `<div class="timingSegment images" style="width:${(pt.imageProcessing || 0) / phaseSum * 100}%"></div>`;
    }
    html += `<div class="timingSegment zip"     style="width:${(pt.zip || 0) / phaseSum * 100}%"></div>`;
    html += '</div>';
    html += '<div class="timingLegend">';
    html += `<span class="tAnalysis">Analysis&nbsp;${fmtTime(pt.analysis || 0)}</span>`;
    html += `<span class="tVideo">Video&nbsp;${fmtTime(pt.videoEncoding || 0)}</span>`;
    if (showImgTiming) html += `<span class="tImages">Images&nbsp;${fmtTime(pt.imageProcessing || 0)}</span>`;
    html += `<span class="tZip">.lottie&nbsp;${fmtTime(pt.zip || 0)}</span>`;
    html += '</div>';
    // Таблица общих метрик
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
    // Детали по ассетам
    html += '<div class="resultBlock">';
    const imgCount = stats.totalImages - stats.framesInVideo;
    // Карточка: все изображения
    if (stats.totalImages > 0) {
        const fmtsAll = Object.entries(stats.formats || {})
            .map(([k, v]) => `${k.toUpperCase()}: ${v}`)
            .join(', ') || '—';
        const assetItems = [
            ['Total images', `${stats.totalImages}`],
            ['File formats', fmtsAll],
        ];
        if (stats.framesInVideo > 0) assetItems.push(['Frames in video sequences', `${stats.framesInVideo}`]);
        if (imgCount > 0) assetItems.push(['Single images', `${imgCount}`]);
        html += `<div class="resultCard" style="border-left-color:#475569">
            <div class="rcHead"><span class="rcTitle">ANIMATION IMAGES</span></div>
            <div class="rtBody">${rows(assetItems)}</div>
        </div>`;
    }
    // Карточка: видео-последовательности
    const totalSeqFound = (stats.sequences || 0) + (stats.videoSkipped || 0);
    if (totalSeqFound > 0) {
        const seqSummary = [['Frame sequences found', `${totalSeqFound}`]];
        if (stats.sequences > 0) seqSummary.push(['Encoded to video', `${stats.sequences}`]);
        if (stats.videoSize > 0) seqSummary.push(['Encoded video size', formatSize(stats.videoSize)]);
        if (stats.videoSkipped > 0) seqSummary.push(['Skipped (no size reduction)', `${stats.videoSkipped}`, 'rtVal--warn']);
        html += `<div class="resultCard" style="border-left-color:#6366f1">
            <div class="rcHead"><span class="rcTitle">VIDEO FROM SEQUENCES</span></div>
            <div class="rtBody">${rows(seqSummary)}</div>`;
        // Подкарточки по каждому видео
        for (const vd of stats.videoDetails || []) {
            const es = vd.encodingStats || {};
            const vItems = [
                ['Resolution', `${vd.width} × ${vd.height} px`],
                ['Frame count', `${vd.frames}`],
                ['Frame rate', `${vd.fps} fps`],
                ['Duration', `${vd.duration.toFixed(2)} s`],
                ['Original sequence size', formatSize(vd.originalSize || vd.fileSize || 0)],
                ['Compression', `${parseFloat(vd.compressionRatio || 0).toFixed(1)} %`],
                ['Codec', 'H.264'],
            ];
            if (es.keyFrames !== undefined) vItems.push(['I-frames', `${es.keyFrames}`]);
            if (es.deltaFrames !== undefined) vItems.push(['Delta frames', `${es.deltaFrames}`]);
            if (es.encodeTime) {
                vItems.push(['Encoding time', fmtTime(es.encodeTime)]);
                if (es.loadTime) {
                    vItems.push(['Frame load time', fmtTime(es.loadTime)]);
                    vItems.push(['Load speed', `${(vd.frames / (es.loadTime / 1000)).toFixed(1)} frames/sec`]);
                }
                vItems.push(['Encoding speed', `${(vd.frames / (es.encodeTime / 1000)).toFixed(1)} frames/sec`]);
                if (es.muxTime) vItems.push(['Mux time', fmtTime(es.muxTime)]);
            }
            html += `<div class="vSubCard">
                <div class="vSubHead"><span>${vd.file}</span></div>
                <div class="rtBody">${rows(vItems)}</div>
            </div>`;
        }
        html += '</div>';
    }
    // Карточка: одиночные изображения
    if (imgCount > 0) {
        const singleBefore = stats.singleImagesSizeBefore || 0;
        const singleAfter = stats.sizeAfter || 0;
        const singleSavedPct = singleBefore > 0
            ? ((singleBefore - singleAfter) / singleBefore * 100).toFixed(1) : '0.0';
        const singleRatio = singleBefore > 0
            ? (singleAfter / singleBefore * 100).toFixed(1) : '100.0';
        const imgItems = [['Unique total', `${stats.uniqueImages || 0}`]];
        if (stats.duplicates > 0) imgItems.push(['Duplicates (merged)', `${stats.duplicates}`, 'rtVal--warn']);
        imgItems.push(['Converted to WebP', `${stats.webpConversions || 0}`, 'rtVal--accent']);
        if (stats.keptOriginal > 0) imgItems.push(['Format unchanged (WebP worse)', `${stats.keptOriginal}`]);
        imgItems.push(
            ['Size before', formatSize(singleBefore)],
            ['Size after', formatSize(singleAfter)],
            ['Compression', `${singleRatio} %`],
            ['Savings', `${singleSavedPct} %`, singleSavedPct > 0 ? 'rtVal--accent' : ''],
        );
        html += `<div class="resultCard" style="border-left-color:var(--accent)">
            <div class="rcHead"><span class="rcTitle">SINGLE IMAGES</span></div>
            <div class="rtBody">${rows(imgItems)}</div>
        </div>`;
    }
    html += '</div></div>';
    container.innerHTML = html;
};
