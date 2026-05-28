import JSZip from 'https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm';
import {Optimizer} from './optimizer.js';
self.JSZip = JSZip;

let _mp4boxLoaded = false;

/**
 * Loads MP4Box from CDN into the worker scope via eval
 */
const loadMp4Box = async () => {
    if (_mp4boxLoaded) return;
    const code = await (await fetch('https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js')).text();
    (0, eval)(code);
    _mp4boxLoaded = true;
};

/**
 * Receives an optimization task, runs Optimizer.run(), and posts the result
 * back to the main thread. The ZIP buffer is transferred (not copied) for speed
 */
self.onmessage = async ({data: msg}) => {
    const {id} = msg;
    try {
        await loadMp4Box();
        const result = await Optimizer.run(msg.data, {
            ...msg.options,
            onProgress: (info) => self.postMessage({id, type: 'progress', info}),
        });
        const zipBuffer = await result.zip.arrayBuffer();
        self.postMessage({
            id,
            type: 'result',
            result: {
                json: result.json,
                preview: result.preview,
                stats: result.stats,
                sequences: result.sequences,
                videoAssets: result.videoAssets,
                urls: result.urls,
                zipBuffer,
            },
        }, [zipBuffer]);
    } catch (err) {
        self.postMessage({id, type: 'error', message: err.message});
    }
};
