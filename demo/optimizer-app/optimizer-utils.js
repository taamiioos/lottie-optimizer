import { $ } from '../common/common.js';

// Создаёт Lottie-анимацию в контейнере
export const createAnim = (container, data) => {
    container.innerHTML = '';
    return lottie.loadAnimation({
        container,
        renderer:      'canvas',
        loop:          true,
        autoplay:      true,
        animationData: data,
        assetsPath:    '',
    });
};
// Создаёт панель настроек для одного слота
export const createSlotSettings = (slotId, onApply) => {
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
    webpEl.addEventListener('input', () => { webpVal.textContent = parseFloat(webpEl.value).toFixed(2); });
    applyBtn.addEventListener('click', async () => {
        applyBtn.disabled = true;
        await onApply({ quality: parseFloat(webpEl.value) });
        applyBtn.disabled = false;
    });
    const readSettings = () => ({ quality: parseFloat(webpEl.value) });
    return { el: container, readSettings };
};

// Инициализирует контролы воспроизведения для пары анимаций
export const setupDemoControls = (slot, animBefore, animAfter) => {
    const p = `dctrl-${slot}`;
    const controls = $(p);
    if (!controls || !animBefore || !animAfter) return;
    const scrubber = $(`${p}-scrub`);
    const frameEl  = $(`${p}-frame`);
    const btnPlay  = $(`${p}-play`);
    const btnStop  = $(`${p}-stop`);
    const speedSel = $(`${p}-speed`);
    const btnLoop  = $(`${p}-loop`);
    controls.style.display = '';
    const totalFrames  = Math.max(0, Math.floor(animAfter.totalFrames)  - 1);
    const beforeFrames = Math.max(0, Math.floor(animBefore.totalFrames) - 1);
    scrubber.max = totalFrames;
    let playing   = true;
    let scrubbing = false;
    let looping   = true;
    const updateLabel = f => { frameEl.textContent = `${Math.floor(f)} / ${totalFrames}`; };
    updateLabel(0);
    animBefore.pause();
    animBefore.goToAndStop(0, true);
    animAfter.goToAndStop(0, true);
    animAfter.play();
    // синхронизируем before с текущим кадром after
    animAfter.addEventListener('enterFrame', (e) => {
        if (scrubbing) return;
        const f = Math.floor(e.currentTime);
        animBefore.goToAndStop(Math.min(f, beforeFrames), true);
        scrubber.value = f;
        updateLabel(e.currentTime);
    });
    animAfter.addEventListener('complete', () => {
        if (!looping) { playing = false; btnPlay.innerHTML = '▶'; }
    });
    scrubber.addEventListener('pointerdown', () => { scrubbing = true; animAfter.pause(); });
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
    btnPlay.addEventListener('click', () => {
        if (playing) { animAfter.pause(); playing = false; btnPlay.innerHTML = '▶'; }
        else         { animAfter.play();  playing = true;  btnPlay.innerHTML = '⏸'; }
    });
    btnStop.addEventListener('click', () => {
        animAfter.stop();
        animBefore.goToAndStop(0, true);
        playing = false;
        scrubber.value = 0;
        updateLabel(0);
        btnPlay.innerHTML = '▶';
    });
    speedSel.addEventListener('change', () => { animAfter.setSpeed(parseFloat(speedSel.value)); });
    btnLoop.addEventListener('click', () => {
        looping = !looping;
        animAfter.setLoop(looping);
        btnLoop.classList.toggle('active', looping);
    });
};
