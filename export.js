// 저장: PNG(정지 화면), GIF·WebP(움짤). 배경은 투명
// 프레임 = { x, y, image }: 화면 캡처(ImageData)에서 투명 여백을 잘라 낸 조각과 그 위치. 아무것도 안 그려졌으면 image = null
// 움짤은 녹화한 프레임을 시퀀스 편집기에서 구간·빼기·방향·속도를 정해서 미리 보고 저장
// - GIF: gifenc(필요할 때만 불러옴)로 프레임마다 팔레트 255색 + 투명 1색. GIF 투명은 켜고 끄기뿐이라 알파 128 미만은 투명
// - WebP: 브라우저 인코더(canvas.toBlob)로 프레임마다 WebP를 만든 뒤 애니메이션 WebP(RIFF ANMF)로 묶음. 반투명 가장자리 유지
//   Safari 등 WebP 인코딩이 안 되는 브라우저는 저장 불가 안내

import { t, setText } from './i18n.js';

export const editor = { open: false }; // 편집기가 열려 있는 동안 main.js는 3D 화면을 그리지 않음

// 알파가 0이 아닌 영역만 잘라 냄 (리틀 엔디언에서 Uint32의 최상위 바이트 = 알파)
export function cropFrame(imageData) {
    const { width, height, data } = imageData;
    const px = new Uint32Array(data.buffer, data.byteOffset, width * height);
    let top = 0, bottom = height - 1;
    const rowEmpty = (y) => {
        for (let i = y * width, end = i + width; i < end; i++) if (px[i] >>> 24) return false;
        return true;
    };
    while (top < height && rowEmpty(top)) top++;
    if (top === height) return { x: 0, y: 0, image: null };
    while (rowEmpty(bottom)) bottom--;
    let left = width, right = -1;
    for (let y = top; y <= bottom; y++) {
        const row = y * width;
        for (let x = 0; x < left; x++) if (px[row + x] >>> 24) { left = x; break; }
        for (let x = width - 1; x > right; x--) if (px[row + x] >>> 24) { right = x; break; }
    }
    const w = right - left + 1, h = bottom - top + 1;
    const image = new ImageData(w, h);
    for (let y = 0; y < h; y++) {
        const start = ((top + y) * width + left) * 4;
        image.data.set(data.subarray(start, start + w * 4), y * w * 4);
    }
    return { x: left, y: top, image };
}

export function safeName(name) {
    return name.replace(/[\\/:*?"<>|]/g, '_');
}

function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
}

const toBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

// 정지 화면 PNG. crop이면 투명 여백을 잘라 냄
export async function savePng(imageData, crop, name) {
    const canvas = document.createElement('canvas');
    if (crop) {
        const { image } = cropFrame(imageData);
        if (!image) return alert(t('export.noModel'));
        imageData = image;
    }
    canvas.width = imageData.width;
    canvas.height = imageData.height;
    canvas.getContext('2d').putImageData(imageData, 0, 0);
    saveBlob(await toBlob(canvas, 'image/png'), `${name}.png`);
}

// 프레임 i의 길이를 누적 반올림으로 정해서 전체 길이가 어긋나지 않게 (unit: GIF는 10ms, WebP는 1ms)
function frameDelay(i, fps, unit) {
    const at = (k) => Math.round(k * 1000 / fps / unit);
    return (at(i + 1) - at(i)) * unit;
}

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve));

async function encodeGif(count, getImage, fps, loop, progress) {
    const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
    const gif = GIFEncoder();
    for (let i = 0; i < count; i++) {
        const { data, width, height } = getImage(i);
        const px = new Uint32Array(data.buffer, data.byteOffset, width * height);
        let opaqueCount = 0;
        for (let p = 0; p < px.length; p++) if ((px[p] >>> 24) >= 128) opaqueCount++;
        const opaque = new Uint32Array(opaqueCount);
        for (let p = 0, k = 0; p < px.length; p++) if ((px[p] >>> 24) >= 128) opaque[k++] = px[p];
        const palette = opaqueCount ? quantize(new Uint8Array(opaque.buffer), 255, { format: 'rgb565' }) : [[0, 0, 0]];
        const index = applyPalette(data, palette, 'rgb565');
        const transparentIndex = palette.length;
        palette.push([0, 0, 0]);
        for (let p = 0; p < px.length; p++) if ((px[p] >>> 24) < 128) index[p] = transparentIndex;
        // transparent면 gifenc가 처리 방식을 '배경으로 지움'(2)으로 써서 이전 프레임이 비치지 않음
        gif.writeFrame(index, width, height, { palette, delay: frameDelay(i, fps, 10), transparent: true, transparentIndex, repeat: loop ? 0 : -1 });
        progress(i + 1);
        await yieldToBrowser();
    }
    gif.finish();
    return new Blob([gif.bytes()], { type: 'image/gif' });
}

// WebP 컨테이너: RIFF 청크 = fourcc(4) + 크기(4, LE) + 내용 + 홀수면 0 한 바이트
function chunk(fourcc, ...parts) {
    const size = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(8 + size + (size & 1));
    for (let i = 0; i < 4; i++) out[i] = fourcc.charCodeAt(i);
    new DataView(out.buffer).setUint32(4, size, true);
    let o = 8;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}
const u24 = (v) => new Uint8Array([v & 255, (v >> 8) & 255, (v >> 16) & 255]);
// 정지 WebP에서 그림 데이터 청크(ALPH, VP8, VP8L)만 그대로 꺼냄
function imageChunks(webp) {
    const view = new DataView(webp.buffer, webp.byteOffset, webp.byteLength);
    const out = [];
    for (let o = 12; o + 8 <= webp.length;) {
        const fourcc = String.fromCharCode(...webp.subarray(o, o + 4));
        const size = view.getUint32(o + 4, true);
        const end = o + 8 + size + (size & 1);
        if (fourcc === 'ALPH' || fourcc === 'VP8 ' || fourcc === 'VP8L') out.push(webp.subarray(o, Math.min(end, webp.length)));
        o = end;
    }
    return out;
}
async function encodeWebp(count, getCanvas, fps, loop, progress) {
    const frames = [];
    let width = 0, height = 0;
    for (let i = 0; i < count; i++) {
        const canvas = getCanvas(i);
        width = canvas.width;
        height = canvas.height;
        const blob = await toBlob(canvas, 'image/webp', 0.92);
        if (blob?.type !== 'image/webp') throw new Error('webp');
        const data = imageChunks(new Uint8Array(await blob.arrayBuffer()));
        // ANMF: 위치 x/2, y/2 (0), 폭-1, 높이-1, 길이(ms), 플래그 0b10 = 섞지 않음(프레임이 화면을 통째로 바꿈 → 투명 부분에 이전 프레임이 안 남음)
        frames.push(chunk('ANMF', u24(0), u24(0), u24(width - 1), u24(height - 1), u24(frameDelay(i, fps, 1)), new Uint8Array([0b10]), ...data));
        progress(i + 1);
    }
    // VP8X 플래그: 알파(0x10) + 애니메이션(0x02). ANIM: 배경색 BGRA(투명) + 반복 횟수(0 = 무한)
    const vp8x = chunk('VP8X', new Uint8Array([0x12, 0, 0, 0]), u24(width - 1), u24(height - 1));
    const anim = chunk('ANIM', new Uint8Array([0, 0, 0, 0, loop ? 0 : 1, 0]));
    return new Blob([chunk('RIFF', new TextEncoder().encode('WEBP'), vp8x, anim, ...frames)], { type: 'image/webp' });
}

// 시퀀스 편집기
const $ = (id) => document.getElementById(id);
const ui = {
    root: $('export-editor'),
    preview: $('ed-preview'),
    strip: $('ed-strip'),
    play: $('ed-play'),
    frameText: $('ed-frame'),
    setStart: $('ed-set-start'),
    setEnd: $('ed-set-end'),
    skip: $('ed-skip'),
    reset: $('ed-reset'),
    dir: $('ed-dir'),
    fps: $('ed-fps'),
    loop: $('ed-loop'),
    scale: $('ed-scale'),
    crop: $('ed-crop'),
    format: $('ed-format'),
    save: $('ed-save'),
    png: $('ed-png'),
    close: $('ed-close'),
    info: $('ed-info'),
};
const work = document.createElement('canvas'); // 자를 영역 크기에 프레임을 놓는 곳
const workContext = work.getContext('2d', { willReadFrequently: true });
const out = document.createElement('canvas'); // 저장 크기로 줄인 결과
const outContext = out.getContext('2d', { willReadFrequently: true });
const previewContext = ui.preview.getContext('2d');
let state = null; // { frames, width, height, smooth, name, start, end, skipped:Set, current, playing, pos, box }
let playTimer = 0;

// 저장·미리 보기 순서 (구간 안에서 뺀 프레임 제외, 방향 적용)
function sequence() {
    const base = [];
    for (let i = state.start; i <= state.end; i++) if (!state.skipped.has(i)) base.push(i);
    if (ui.dir.value === 'rev') return base.reverse();
    if (ui.dir.value === 'ping') return [...base, ...base.slice(1, -1).reverse()];
    return base;
}
// 저장할 영역: 여백 자르기면 구간에 든 프레임들의 내용 영역을 합친 것, 아니면 화면 전체. all이면 모든 프레임 기준 (섬네일)
function updateBox(all = false) {
    if (!all && !ui.crop.checked) {
        state.box = { x: 0, y: 0, w: state.width, h: state.height };
        return;
    }
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    state.frames.forEach((f, i) => {
        if (!f.image || (!all && (i < state.start || i > state.end || state.skipped.has(i)))) return;
        x0 = Math.min(x0, f.x);
        y0 = Math.min(y0, f.y);
        x1 = Math.max(x1, f.x + f.image.width);
        y1 = Math.max(y1, f.y + f.image.height);
    });
    state.box = x1 > x0 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : { x: 0, y: 0, w: 1, h: 1 };
}
function outputSize() {
    const s = Number(ui.scale.value) / 100;
    return [Math.max(1, Math.round(state.box.w * s)), Math.max(1, Math.round(state.box.h * s))];
}
// 프레임 i를 저장 크기로 그린 캔버스
function drawFrame(i) {
    const { box } = state;
    const f = state.frames[i];
    if (work.width !== box.w || work.height !== box.h) {
        work.width = box.w;
        work.height = box.h;
    } else {
        workContext.clearRect(0, 0, box.w, box.h);
    }
    if (f.image) workContext.putImageData(f.image, f.x - box.x, f.y - box.y);
    const [w, h] = outputSize();
    if (w === box.w && h === box.h) return work;
    if (out.width !== w || out.height !== h) {
        out.width = w;
        out.height = h;
    } else {
        outContext.clearRect(0, 0, w, h);
    }
    outContext.imageSmoothingEnabled = state.smooth; // 픽셀 셰이더는 도트가 번지지 않게 최근접
    outContext.imageSmoothingQuality = 'high';
    outContext.drawImage(work, 0, 0, w, h);
    return out;
}
function imageOf(canvas) {
    return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

function showFrame(i) {
    state.current = i;
    const canvas = drawFrame(i);
    // 미리 보기 캔버스는 저장 크기 그대로, 화면에는 CSS로 맞춰 줄임
    if (ui.preview.width !== canvas.width || ui.preview.height !== canvas.height) {
        ui.preview.width = canvas.width;
        ui.preview.height = canvas.height;
    } else {
        previewContext.clearRect(0, 0, canvas.width, canvas.height);
    }
    previewContext.drawImage(canvas, 0, 0);
    ui.frameText.textContent = `${i + 1} / ${state.frames.length}`;
    const thumb = ui.strip.children[i];
    ui.strip.querySelector('.current')?.classList.remove('current');
    thumb?.classList.add('current');
    thumb?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    setText(ui.skip, state.skipped.has(i) ? 'ed.unskip' : 'ed.skip');
}
function refreshStrip() {
    for (const [k, thumb] of [...ui.strip.children].entries()) {
        thumb.classList.toggle('out', k < state.start || k > state.end);
        thumb.classList.toggle('skipped', state.skipped.has(k));
    }
}
function refreshInfo() {
    const seq = sequence();
    const [w, h] = outputSize();
    const fps = Number(ui.fps.value);
    ui.info.textContent = t('ed.info', { n: seq.length, sec: (seq.length / fps).toFixed(2), w, h });
    ui.save.disabled = !seq.length;
}
function setPlaying(playing) {
    state.playing = playing;
    setText(ui.play, playing ? 'ed.stop' : 'ed.play');
    clearInterval(playTimer);
    if (!playing) return;
    const seq = sequence();
    if (!seq.length) return;
    state.pos = Math.max(0, seq.indexOf(state.current));
    playTimer = setInterval(() => {
        state.pos = (state.pos + 1) % seq.length;
        showFrame(seq[state.pos]);
    }, 1000 / Number(ui.fps.value));
}
// 설정이 바뀌면 영역·정보를 다시 계산하고 재생 중이면 새 순서로 이어서
function changed() {
    updateBox();
    refreshStrip();
    refreshInfo();
    showFrame(state.current);
    if (state.playing) setPlaying(true);
}

// 섬네일: 전체 프레임의 내용 영역 기준 (구간을 바꿔도 다시 안 그림)
async function buildThumbs() {
    ui.strip.textContent = '';
    const token = state;
    updateBox(true);
    const { box } = state;
    const THUMB_H = 48;
    const tw = Math.max(1, Math.min(160, Math.round(THUMB_H * box.w / box.h)));
    state.frames.forEach((f, i) => {
        const thumb = document.createElement('canvas');
        thumb.width = tw;
        thumb.height = THUMB_H;
        thumb.title = `${i + 1}`;
        thumb.addEventListener('click', () => {
            setPlaying(false);
            showFrame(i);
        });
        ui.strip.appendChild(thumb);
    });
    const scratch = document.createElement('canvas');
    scratch.width = box.w;
    scratch.height = box.h;
    const scratchContext = scratch.getContext('2d');
    for (const [i, f] of state.frames.entries()) {
        if (!f.image) continue;
        scratchContext.clearRect(0, 0, box.w, box.h);
        scratchContext.putImageData(f.image, f.x - box.x, f.y - box.y);
        ui.strip.children[i].getContext('2d').drawImage(scratch, 0, 0, tw, THUMB_H);
        if (i % 20 === 19) {
            await yieldToBrowser();
            if (state !== token) return; // 그리는 중에 닫힘
        }
    }
}

export function openSequenceEditor({ frames, fps, width, height, smooth, name }) {
    state = { frames, width, height, smooth, name, start: 0, end: frames.length - 1, skipped: new Set(), current: 0, playing: false, pos: 0, box: null };
    if (![...ui.fps.options].some((o) => Number(o.value) === fps)) ui.fps.add(new Option(String(fps), String(fps)));
    ui.fps.value = String(fps);
    editor.open = true;
    ui.root.hidden = false;
    buildThumbs();
    changed();
    setPlaying(true);
}
function closeEditor() {
    setPlaying(false);
    state = null;
    ui.strip.textContent = '';
    ui.root.hidden = true;
    editor.open = false;
}

ui.play.addEventListener('click', () => setPlaying(!state.playing));
ui.setStart.addEventListener('click', () => {
    state.start = state.current;
    state.end = Math.max(state.end, state.start);
    changed();
});
ui.setEnd.addEventListener('click', () => {
    state.end = state.current;
    state.start = Math.min(state.start, state.end);
    changed();
});
ui.skip.addEventListener('click', () => {
    const i = state.current;
    if (!state.skipped.delete(i)) state.skipped.add(i);
    changed();
});
ui.reset.addEventListener('click', () => {
    state.start = 0;
    state.end = state.frames.length - 1;
    state.skipped.clear();
    changed();
});
for (const el of [ui.dir, ui.fps, ui.loop, ui.scale, ui.crop]) el.addEventListener('change', changed);
ui.close.addEventListener('click', closeEditor);
ui.png.addEventListener('click', async () => {
    const canvas = drawFrame(state.current);
    saveBlob(await toBlob(canvas, 'image/png'), `${state.name}_${state.current + 1}.png`);
});
ui.save.addEventListener('click', async () => {
    const seq = sequence();
    if (!seq.length) return;
    const format = ui.format.value;
    const fps = Number(ui.fps.value);
    const loop = ui.loop.value === '0';
    setPlaying(false);
    const controls = ui.root.querySelectorAll('button, select, input');
    for (const el of controls) el.disabled = true;
    const progress = (n) => { ui.info.textContent = t('ed.saving', { n, total: seq.length }); };
    try {
        const blob = format === 'gif'
            ? await encodeGif(seq.length, (k) => imageOf(drawFrame(seq[k])), fps, loop, progress)
            : await encodeWebp(seq.length, (k) => drawFrame(seq[k]), fps, loop, progress);
        saveBlob(blob, `${state.name}.${format}`);
    } catch (e) {
        console.error(e);
        alert(e.message === 'webp' ? `This browser doesn't support WebP. Save in GIF or use Chrome·Edge·Firefox.` : `Failed to save: ${e.message}`);
    } finally {
        for (const el of controls) el.disabled = false;
        if (state) {
            refreshInfo();
            showFrame(state.current);
        }
    }
});
window.addEventListener('keydown', (e) => {
    if (!editor.open || e.target.tagName === 'SELECT') return;
    if (e.key === 'Escape') closeEditor();
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        setPlaying(false);
        showFrame((state.current + (e.key === 'ArrowLeft' ? -1 : 1) + state.frames.length) % state.frames.length);
    }
});
