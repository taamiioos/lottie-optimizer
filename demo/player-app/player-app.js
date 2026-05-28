import {$, fmtTime, initTheme, statRow, toggleTheme} from '../common/common.js';
import {
    clearCompatStatus,
    markZoneLoaded,
    resetZone,
    setProgress,
    setupZone,
    showCompatStatus,
} from './player-utils.js';

initTheme();
window.__toggleTheme = toggleTheme;

/** Shared player state — one animation at a time */
const state = {
    json: null,
    lottieBlob: null,
    anim: null,
};

/**
 * Handles a file selected or dropped by the user
 */
const handleFile = async (file) => {
    if (file.name.endsWith('.lottie')) {
        state.lottieBlob = file;
        state.json = null;
    } else {
        try {
            state.json = JSON.parse(await file.text());
            state.lottieBlob = null;
        } catch {
            showCompatStatus('error', 'Not a valid JSON file');
            return;
        }
    }
    markZoneLoaded(file.name, file.size);
    showCompatStatus('ok', 'File ready');
    $('btnPlay').disabled = false;
};
setupZone('zoneJson', 'jsonInput', handleFile);

/**
 * Destroys the current animation and resets all UI back to the initial state
 */
const resetPlayer = () => {
    if (state.anim) {
        state.anim.destroy();
        state.anim = null;
    }
    state.json = null;
    state.lottieBlob = null;
    $('playerWrap').style.display = 'none';
    $('playerWrap').classList.remove('playing');
    $('playerPlaceholder').classList.remove('hidden');
    $('player').innerHTML = '';
    $('playerControls').style.display = 'none';
    $('statsSection').style.display = 'none';
    $('statsSection').innerHTML = '';
    setProgress(0, '');
    $('progressFill').classList.remove('done', 'error');
    $('btnPlay').disabled = true;
    $('btnPlay').innerHTML = '<span class="pl-play-icon">▶</span><span>Play</span>';
    resetZone();
    clearCompatStatus();
};

$('btnReset').addEventListener('click', resetPlayer);

/**
 * Play button handler. For .lottie files, unpacks and decodes the archive
 * on click via lottie.preloadAnimation. Plain JSON is passed directly
 */
$('btnPlay').addEventListener('click', async () => {
    $('btnPlay').disabled = true;
    $('btnPlay').innerHTML = '<span>Loading...</span>';
    $('progressFill').classList.remove('done', 'error');
    const t0 = performance.now();
    if (state.anim) {
        state.anim.destroy();
        state.anim = null;
        $('player').innerHTML = '';
    }
    $('playerWrap').style.display = '';
    $('playerWrap').classList.add('playing');
    $('playerPlaceholder').classList.add('hidden');
    $('playerControls').style.display = 'none';
    $('statsSection').style.display = 'none';
    let animationData;
    if (state.lottieBlob) {
        setProgress(20, 'Decoding...');
        animationData = await lottie.preloadAnimation(state.lottieBlob).catch(() => null);
        if (!animationData) {
            showError('Error loading animation');
            return;
        }
        setProgress(90, 'Starting...');
    } else {
        setProgress(50, 'Loading...');
        animationData = state.json;
    }
    state.anim = lottie.loadAnimation({
        container: $('player'),
        renderer: 'canvas',
        loop: true,
        autoplay: true,
        animationData,
    });
    state.anim.addEventListener('DOMLoaded', () => {
        const initialLoadTime = performance.now() - t0;
        $('progressFill').classList.add('done');
        setProgress(100, fmtTime(initialLoadTime));
        renderStats({
            initialLoadTime: initialLoadTime,
            animData: state.anim.animationData,
        });
        setupControls(state.anim);
    });
    state.anim.addEventListener('data_failed', () => {
        showError('Error loading animation');
    });
});

/** Shows an error in the progress bar and re-enables the Play button */
const showError = (message) => {
    $('progressFill').classList.add('error');
    setProgress(100, message);
    $('btnPlay').disabled = false;
    $('btnPlay').innerHTML = '<span class="pl-play-icon">▶</span><span>Play</span>';
};

let _controlsAbort = null;

/**
 * Binds scrubber, play/pause/stop, speed and loop controls to the animation*/
const setupControls = (anim) => {
    if (_controlsAbort) _controlsAbort.abort();
    _controlsAbort = new AbortController();
    const {signal} = _controlsAbort;
    $('playerControls').style.display = '';
    const scrubber = $('scrubber');
    const frameInfo = $('frameInfo');
    const speedSel = $('speedSelect');
    const btnPause = $('btnPause');
    const btnStop = $('btnStop');
    const btnLoop = $('btnLoop');
    const totalFrames = Math.max(0, Math.floor(anim.totalFrames) - 1);
    scrubber.max = totalFrames;
    let playing = true;
    let scrubbing = false;
    let looping = true;
    const updateLabel = f => {
        frameInfo.textContent = `${Math.floor(f)} / ${totalFrames}`;
    };
    updateLabel(0);
    anim.addEventListener('enterFrame', (e) => {
        if (!scrubbing) {
            scrubber.value = Math.floor(e.currentTime);
            updateLabel(e.currentTime);
        }
    });
    anim.addEventListener('complete', () => {
        if (!looping) {
            playing = false;
            btnPause.innerHTML = '▶';
        }
    });
    scrubber.addEventListener('pointerdown', () => {
        scrubbing = true;
        anim.pause();
    }, {signal});
    scrubber.addEventListener('input', () => {
        const f = parseInt(scrubber.value);
        anim.goToAndStop(f, true);
        updateLabel(f);
    }, {signal});
    scrubber.addEventListener('pointerup', () => {
        scrubbing = false;
        if (playing) anim.play();
    }, {signal});
    btnPause.addEventListener('click', () => {
        if (playing) {
            anim.pause();
            playing = false;
            btnPause.innerHTML = '▶';
        } else {
            anim.play();
            playing = true;
            btnPause.innerHTML = '⏸';
        }
    }, {signal});
    btnStop.addEventListener('click', () => {
        anim.stop();
        playing = false;
        scrubber.value = 0;
        updateLabel(0);
        btnPause.innerHTML = '▶';
    }, {signal});
    speedSel.addEventListener('change', () => anim.setSpeed(parseFloat(speedSel.value)), {signal});
    btnLoop.addEventListener('click', () => {
        looping = !looping;
        anim.setLoop(looping);
        btnLoop.classList.toggle('active', looping);
    }, {signal});
};

/**
 * Renders the animation stats panel into the statsSection element
 * */
const renderStats = (s) => {
    const el = $('statsSection');
    el.style.display = '';
    const d = s.animData || {};
    const fps = d.fr || 0;
    const frames = d.op || 0;
    const w = d.w || 0;
    const h = d.h || 0;
    const dur = fps > 0 ? (frames / fps).toFixed(2) : '—';
    const assets = (d.assets || []).filter(a => !a.layers);
    const videoAssets = d.videoAssets || [];
    const rows = items => items.map((it, i) =>
        statRow(i === items.length - 1 ? '└' : '├', it[0], it[1], it[2] || '')
    ).join('');
    let html = '<div class="statsInner"><div class="statsGrid">';
    html += `<div class="statBox">
             <div class="statLabel">Initial Load</div>
             <div class="statValue">${fmtTime(s.initialLoadTime || 0)}</div>
           </div>`;
    if (w > 0) {
        html += `<div class="statBox">
               <div class="statLabel">Size</div>
               <div class="statValue">${w}×${h}</div>
             </div>`;
    }
    html += `<div class="statBox">
             <div class="statLabel">Duration</div>
             <div class="statValue">${dur} s</div>
           </div>`;
    html += '</div><div class="resultBlock">';
    if (w > 0) {
        const animItems = [
            ['Size', `${w}&times;${h} px`],
            ['FPS', `${fps}`],
            ['Duration', `${dur} s`],
            ['Frames', `${frames}`],
        ];
        if (assets.length) animItems.push(['Assets', `${assets.length}`]);
        if (videoAssets.length) animItems.push(['Video sequences', `${videoAssets.length}`]);
        html += `<div class="resultCard" style="border-left-color:#475569">
      <div class="rcHead"><span class="rcTitle">ANIMATION</span></div>
      <div class="rtBody">${rows(animItems)}</div>
    </div>`;
    }
    for (const va of videoAssets) {
        html += `<div class="resultCard" style="border-left-color:#6366f1">
      <div class="rcHead"><span class="rcTitle">VIDEO</span></div>
      <div class="rtBody">${rows([
            ['File', va.file],
            ['Resolution', `${va.width}&times;${va.height} px`],
            ['Frames', `${va.frames} @ ${va.fps} fps`],
            ['Codec', va.codec || 'H.264'],
        ])}</div>
    </div>`;
    }
    html += '</div></div>';
    el.innerHTML = html;
};
