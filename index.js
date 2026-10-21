import { extension_settings } from '../../../extensions.js';
import { saveSettingsDebounced } from '../../../../script.js';

const MODULE = 'voice_ears';
const DEFAULTS = {
    apiKey: '',
    model: 'gemini-2.5-flash',
    autoSend: true,
    maxSec: 90,
};

const TALK_PROMPT = `You are the "ears" for a roleplay chat app. Listen to the audio.
The speaker uses everyday standard Thai (simple spoken Thai). Do not expect advanced slang.
Task: (1) transcribe what the speaker said, in Thai script; (2) judge the speaker's emotional tone from the VOICE itself (pitch, speed, trembling, sighing, laughing, crying), not only from the words.
Reply with ONE line only, exactly in this format, with no extra text:
(น้ำเสียง: <1-3 Thai words, e.g. ร่าเริง / เศร้า / เหนื่อย / ร้องไห้ / โกรธ / ประหม่า / ปกติ>) <transcript>
Rules: if unsure about the emotion use "ปกติ". Never invent words you did not hear. If there is no clear speech, reply exactly: (ไม่ได้ยินเสียงพูดชัดเจน)`;

const SING_PROMPT = `You are the "ears" for a roleplay chat app. Listen to the audio.
The speaker is SINGING to a chat character. Task: transcribe the lyrics as sung (Thai or any other language), describe the mood the singing conveys, and give a short, friendly but honest impression of the singing (steady pitch? rhythm? voice quality?). Do not guess the song title unless you are certain.
Reply with ONE line only, exactly in this format, with no extra text:
(ร้องเพลงให้ฟัง | อารมณ์: <1-3 Thai words> | ความรู้สึกต่อการร้อง: <short Thai phrase>) เนื้อที่ได้ยิน: <lyrics>
If there is no clear singing, reply exactly: (ไม่ได้ยินเสียงร้องชัดเจน)`;

let settings;
let recorder = null;
let stream = null;
let chunks = [];
let mode = null;
let timer = null;
let tick = null;

function loadSettings() {
    extension_settings[MODULE] = Object.assign({}, DEFAULTS, extension_settings[MODULE] || {});
    settings = extension_settings[MODULE];
}

function save() {
    saveSettingsDebounced();
}

function encodeWav(samples, rate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const v = new DataView(buffer);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + samples.length * 2, true);
    w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true);
    v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true);
    w(36, 'data'); v.setUint32(40, samples.length * 2, true);
    let o = 44;
    for (let i = 0; i < samples.length; i++, o += 2) {
        const s = Math.max(-1, Math.min(1, samples[i]));
        v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
    return buffer;
}

function toBase64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    const step = 0x8000;
    for (let i = 0; i < bytes.length; i += step) {
        s += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
    }
    return btoa(s);
}

async function blobToWav16k(blob) {
    const arr = await blob.arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC();
    try {
        const decoded = await ac.decodeAudioData(arr);
        const rate = 16000;
        const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * rate)), rate);
        const src = off.createBufferSource();
        src.buffer = decoded;
        src.connect(off.destination);
        src.start();
        const rendered = await off.startRendering();
        return encodeWav(rendered.getChannelData(0), rate);
    } finally {
        ac.close?.();
    }
}

async function askGemini(wavBuffer, prompt) {
    const model = (settings.model || DEFAULTS.model).trim();
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-goog-api-key': settings.apiKey.trim(),
        },
        body: JSON.stringify({
            contents: [{
                parts: [
                    { text: prompt },
                    { inline_data: { mime_type: 'audio/wav', data: toBase64(wavBuffer) } },
                ],
            }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048 },
        }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
        throw new Error(data?.error?.message || `HTTP ${res.status}`);
    }
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('').replace(/\s*\n+\s*/g, ' ').trim();
    if (!text) throw new Error('โมเดลไม่ได้ตอบกลับข้อความ (อาจถูกบล็อกหรือเสียงสั้นเกินไป)');
    return text;
}

function putInChat(text) {
    const ta = $('#send_textarea');
    const old = String(ta.val() || '').trim();
    ta.val(old ? `${old}\n${text}` : text).trigger('input');
    if (settings.autoSend) {
        $('#send_but').trigger('click');
    }
}

function setButtons(state) {
    const talk = $('#ve_talk'), sing = $('#ve_sing');
    talk.removeClass('ve-recording ve-busy');
    sing.removeClass('ve-recording ve-busy');
    if (state === 'talk') { talk.addClass('ve-recording'); sing.addClass('ve-busy'); }
    else if (state === 'sing') { sing.addClass('ve-recording'); talk.addClass('ve-busy'); }
    else if (state === 'busy') { talk.addClass('ve-busy'); sing.addClass('ve-busy'); }
}

async function startRecording(m) {
    if (!settings.apiKey.trim()) {
        toastr.warning('ใส่ Gemini API Key ในหน้าตั้งค่า Voice Ears ก่อน', 'Voice Ears');
        return;
    }
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        toastr.error('เบราว์เซอร์ใช้ไมค์ไม่ได้ในหน้านี้ ต้องเปิดผ่าน localhost หรือ https เท่านั้น', 'Voice Ears');
        return;
    }
    try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
        toastr.error('ไม่ได้รับอนุญาตใช้ไมโครโฟน (ไปเปิดสิทธิ์ไมค์ให้เบราว์เซอร์ในตั้งค่ามือถือ)', 'Voice Ears');
        return;
    }
    mode = m;
    chunks = [];
    recorder = new MediaRecorder(stream);
    recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
    recorder.onstop = onStopped;
    recorder.start();
    setButtons(m);
    const limit = Math.max(5, Number(settings.maxSec) || 90);
    let left = limit;
    toastr.info(m === 'sing' ? 'กำลังฟัง… ร้องได้เลย แตะ 🎵 อีกครั้งเพื่อหยุด' : 'กำลังฟัง… พูดได้เลย แตะ 🎤 อีกครั้งเพื่อหยุด', 'Voice Ears');
    tick = setInterval(() => { left--; }, 1000);
    timer = setTimeout(stopRecording, limit * 1000);
}

function stopRecording() {
    clearTimeout(timer);
    clearInterval(tick);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
}

async function onStopped() {
    stream?.getTracks().forEach(t => t.stop());
    stream = null;
    const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
    const m = mode;
    recorder = null;
    mode = null;
    if (blob.size < 2000) {
        setButtons(null);
        toastr.warning('เสียงสั้นเกินไป ลองอัดใหม่', 'Voice Ears');
        return;
    }
    setButtons('busy');
    const wait = toastr.info('กำลังให้ AI ฟังเสียง…', 'Voice Ears', { timeOut: 0, extendedTimeOut: 0 });
    try {
        const wav = await blobToWav16k(blob);
        const text = await askGemini(wav, m === 'sing' ? SING_PROMPT : TALK_PROMPT);
        putInChat(text);
    } catch (e) {
        console.error('[VoiceEars]', e);
        toastr.error(String(e?.message || e), 'Voice Ears');
    } finally {
        toastr.clear(wait);
        setButtons(null);
    }
}

function onButton(m) {
    if (recorder && recorder.state === 'recording') {
        if (mode === m) stopRecording();
        return;
    }
    startRecording(m);
}

function buildSettings() {
    const html = `
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b>Voice Ears (หูฟังเสียง)</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <label>Gemini API Key</label>
            <input id="ve_key" class="text_pole" type="password" placeholder="วางคีย์จาก Google AI Studio" />
            <small class="ve-note">คีย์จะถูกเก็บในไฟล์ตั้งค่าของ SillyTavern บนเครื่อง/เซิร์ฟเวอร์ของคุณ</small>
            <label>ชื่อโมเดล</label>
            <input id="ve_model" class="text_pole" type="text" />
            <small class="ve-note">ต้องเป็นโมเดล Gemini ที่รับเสียงได้ ถ้าขึ้น error ลองเปลี่ยนชื่อโมเดล</small>
            <label>อัดได้นานสุด (วินาที)</label>
            <input id="ve_max" class="text_pole" type="number" min="5" max="180" />
            <label class="checkbox_label">
                <input id="ve_auto" type="checkbox" />
                <span>ส่งข้อความเข้าแชตอัตโนมัติหลังฟังเสร็จ</span>
            </label>
            <small class="ve-note">🎤 พูดคุย (จับน้ำเสียง) · 🎵 ร้องเพลงให้ฟัง · ปุ่มอยู่ข้างปุ่มส่งข้อความ</small>
        </div>
    </div>`;
    $('#extensions_settings2').append(html);
    $('#ve_key').val(settings.apiKey).on('input', function () { settings.apiKey = String($(this).val()); save(); });
    $('#ve_model').val(settings.model).on('input', function () { settings.model = String($(this).val()); save(); });
    $('#ve_max').val(settings.maxSec).on('input', function () { settings.maxSec = Number($(this).val()) || 90; save(); });
    $('#ve_auto').prop('checked', !!settings.autoSend).on('change', function () { settings.autoSend = this.checked; save(); });
}

jQuery(() => {
    loadSettings();
    buildSettings();
    const talk = $('<div id="ve_talk" class="fa-solid fa-microphone interactable" tabindex="0" title="พูดให้ AI ฟัง"></div>');
    const sing = $('<div id="ve_sing" class="fa-solid fa-music interactable" tabindex="0" title="ร้องเพลงให้ AI ฟัง"></div>');
    talk.on('click', () => onButton('talk'));
    sing.on('click', () => onButton('sing'));
    $('#rightSendForm').prepend(sing).prepend(talk);
});
