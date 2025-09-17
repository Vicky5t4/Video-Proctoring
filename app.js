
// ======= CONFIG =======
const OBJECT_DET_INTERVAL_MS = 500;  
const FACE_DET_INTERVAL_MS   = 100;   // BlazeFace ~10 FPS (throttled)
const LOOK_AWAY_MS           = 5000;  // >5s
const NO_FACE_MS             = 10000; // >10s
const SCORE_CAPS = { away: 30, noface: 40, multi: 30 };

// ======= DOM =======
const video = document.getElementById('video');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const startBtn = document.getElementById('startBtn');
const stopBtn  = document.getElementById('stopBtn');
const candidateInput = document.getElementById('candidateName');

const chipFocus = document.getElementById('statusFocus');
const chipAway  = document.getElementById('statusAway');
const chipNoFace= document.getElementById('statusNoFace');
const chipMulti = document.getElementById('statusMulti');
const chipPhone = document.getElementById('statusPhone');
const chipBook  = document.getElementById('statusBook');
const chipDevice= document.getElementById('statusDevice');

const feed = document.getElementById('feed');

const sumName = document.getElementById('sumName');
const sumSid  = document.getElementById('sumSid');
const sumStart= document.getElementById('sumStart');
const sumDur  = document.getElementById('sumDur');

const cntAway   = document.getElementById('cntAway');
const cntNoFace = document.getElementById('cntNoFace');
const cntMulti  = document.getElementById('cntMulti');
const cntPhone  = document.getElementById('cntPhone');
const cntBook   = document.getElementById('cntBook');
const cntDevice = document.getElementById('cntDevice');
const scoreEl   = document.getElementById('score');

const downloadVideoBtn = document.getElementById('downloadVideoBtn');
const downloadCsvBtn   = document.getElementById('downloadCsvBtn');
const downloadJsonBtn  = document.getElementById('downloadJsonBtn');
const openPdfBtn       = document.getElementById('openPdfBtn');

// ======= STATE =======
let sessionId = null;
let startTime = null;
let timerHandle = null;

let mediaRecorder = null;
let recordedChunks = [];

let running = false;
let blazeModel = null;
let cocoModel = null;

let lastFaceDet = 0, lastObjDet = 0;
let awayMs = 0, noFaceMs = 0;

let lastAwayState = false; // for de-bounce
let lastMultiState = false;

const events = []; // {t, type, details}

// Counters for report
const counts = {
  away:0, noface:0, multi:0, phone:0, book:0, device:0
};

// ======= UTIL =======
const nowIso = () => new Date().toISOString();
function addEvent(type, details={}) {
  const e = { t: nowIso(), type, details };
  events.push(e);
  const div = document.createElement('div');
  div.className = 'item';
  div.innerHTML = `<div><b>${type}</b> ${details.label?('— '+details.label):''}</div>
                   <div class="time">${e.t}</div>`;
  feed.prepend(div);
  // counts
  if(type==='LOOKING_AWAY_5S'){ counts.away++; cntAway.textContent=counts.away; pulse(chipAway, 'warn');}
  if(type==='NO_FACE_10S'){ counts.noface++; cntNoFace.textContent=counts.noface; pulse(chipNoFace, 'bad');}
  if(type==='MULTIPLE_FACES'){ counts.multi++; cntMulti.textContent=counts.multi; pulse(chipMulti, 'warn');}
  if(type==='PHONE_DETECTED'){ counts.phone++; cntPhone.textContent=counts.phone; pulse(chipPhone, 'bad');}
  if(type==='BOOK_OR_NOTES_DETECTED'){ counts.book++; cntBook.textContent=counts.book; pulse(chipBook, 'warn');}
  if(type==='EXTRA_DEVICE_DETECTED'){ counts.device++; cntDevice.textContent=counts.device; pulse(chipDevice, 'warn');}
  updateScore();
}
function msToClock(ms){
  const s = Math.floor(ms/1000);
  const mm = String(Math.floor(s/60)).padStart(2,'0');
  const ss = String(s%60).padStart(2,'0');
  return `${mm}:${ss}`;
}
function updateScore(){
  let score = 100;
  score -= Math.min(SCORE_CAPS.away, 5*counts.away);
  score -= Math.min(SCORE_CAPS.noface, 10*counts.noface);
  score -= Math.min(SCORE_CAPS.multi, 10*counts.multi);
  score -= 15*counts.phone + 10*counts.book + 10*counts.device;
  score = Math.max(0, Math.min(100, score));
  scoreEl.textContent = String(score);
}
function pulse(chip, cls){
  chip.classList.add('on'); chip.classList.add(cls);
  setTimeout(()=>chip.classList.remove('on'), 500);
}

// ======= CAMERA + RECORDER =======
async function startCamera(){
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video:true, audio:false });
    video.srcObject = stream;

    // 🟢 autoplay + playsinline fix
    video.setAttribute("autoplay", "");
    video.setAttribute("playsinline", "");
    video.setAttribute("muted", "");

    await video.play();

    // Ensure canvas matches video
    canvas.width = video.videoWidth || 1280;
    canvas.height= video.videoHeight || 720;

    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
    mediaRecorder.ondataavailable = (e)=> { if(e.data.size>0) recordedChunks.push(e.data); };
  } catch(err) {
    console.error("❌ Camera error:", err);
    alert("Camera access failed. Please allow permissions and retry.");
  }
}

function stopCamera(){
  const s = video.srcObject;
  if(s){ s.getTracks().forEach(t=>t.stop()); }
  video.srcObject = null;
}

function downloadBlob(blob, filename){
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  setTimeout(()=> URL.revokeObjectURL(url), 1000);
}

// ======= DETECTION HELPERS =======
function lookingAwayHeuristic(pred){
  const lm = pred.landmarks || [];
  if(lm.length < 3) return false;
  const [rightEye, leftEye, nose] = [lm[0], lm[1], lm[2]];
  const dLeft  = Math.hypot(nose[0]-leftEye[0],  nose[1]-leftEye[1]);
  const dRight = Math.hypot(nose[0]-rightEye[0], nose[1]-rightEye[1]);
  const ratio = dLeft / (dRight + 1e-6);
  const eyeMidY = (leftEye[1] + rightEye[1]) / 2;
  const pitch = Math.abs((nose[1] - eyeMidY) / (canvas.height));

  const yawAway = (ratio < 0.75) || (ratio > 1.33);
  const pitchAway = pitch > 0.06;
  return yawAway || pitchAway;
}

// ======= LOOPS =======
async function faceLoop(ts){
  if(!running) return;
  if(ts - lastFaceDet >= FACE_DET_INTERVAL_MS){
    lastFaceDet = ts;
    const preds = await blazeModel.estimateFaces(video, false);

    // 🟢 transparent clear
    ctx.clearRect(0,0,canvas.width, canvas.height);
    ctx.fillStyle = "rgba(0,0,0,0)";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    ctx.lineWidth = 2;

    if(preds.length === 0){
      noFaceMs += FACE_DET_INTERVAL_MS;
      awayMs = 0;
      setChips({focus:false, away:false, noface:true, multi:false});
      if(noFaceMs > NO_FACE_MS){
        addEvent('NO_FACE_10S');
        noFaceMs = 0;
      }
    } else {
      preds.forEach(p=>{
        const [x,y] = p.topLeft;
        const [x2,y2] = p.bottomRight;
        const w = x2-x, h = y2-y;
        ctx.strokeStyle = '#22c55e';
        ctx.strokeRect(x,y,w,h);
      });

      const multi = preds.length >= 2;
      setChips({multi});
      if(multi && !lastMultiState){
        addEvent('MULTIPLE_FACES');
      }
      lastMultiState = multi;

      const awayNow = lookingAwayHeuristic(preds[0]);
      if(awayNow){ awayMs += FACE_DET_INTERVAL_MS; } else { awayMs = 0; }
      noFaceMs = 0;

      setChips({noface:false, away:awayNow, focus:!awayNow && !multi});
      if(awayMs > LOOK_AWAY_MS && !lastAwayState){
        addEvent('LOOKING_AWAY_5S');
      }
      lastAwayState = (awayMs > 0);
    }
  }
  requestAnimationFrame(faceLoop);
}

async function objectLoop(){
  while(running){
    const preds = await cocoModel.detect(video);
    preds.forEach(p=>{
      if(!p.score || p.score < 0.6) return;
      const cls = p.class;
      const [x,y,w,h] = p.bbox;
      if(cls==='cell phone'){
        ctx.strokeStyle = '#ef4444';
        ctx.strokeRect(x,y,w,h);
        ctx.fillStyle = '#ef4444';
        ctx.fillText(`${cls} ${(p.score*100|0)}%`, x, y-4);
        addEvent('PHONE_DETECTED', {score:p.score});
        setChips({phone:true});
      } else if(cls==='book'){
        ctx.strokeStyle = '#f59e0b';
        ctx.strokeRect(x,y,w,h);
        ctx.fillStyle = '#f59e0b';
        ctx.fillText(`${cls} ${(p.score*100|0)}%`, x, y-4);
        addEvent('BOOK_OR_NOTES_DETECTED', {score:p.score});
        setChips({book:true});
      } else if(['laptop','keyboard','mouse','tv'].includes(cls)){
        ctx.strokeStyle = '#f59e0b';
        ctx.strokeRect(x,y,w,h);
        ctx.fillStyle = '#f59e0b';
        ctx.fillText(`${cls} ${(p.score*100|0)}%`, x, y-4);
        addEvent('EXTRA_DEVICE_DETECTED', {label: cls, score:p.score});
        setChips({device:true});
      }
    });

    await new Promise(r => setTimeout(r, OBJECT_DET_INTERVAL_MS));
    setChips({phone:false, book:false, device:false});
  }
}

// ======= UI =======
function setChips(states){
  if(states.focus !== undefined){
    chipFocus.classList.toggle('ok', states.focus);
    chipFocus.classList.toggle('on', states.focus);
  }
  if(states.away !== undefined){
    chipAway.classList.toggle('warn', states.away);
    chipAway.classList.toggle('on', states.away);
  }
  if(states.noface !== undefined){
    chipNoFace.classList.toggle('bad', states.noface);
    chipNoFace.classList.toggle('on', states.noface);
  }
  if(states.multi !== undefined){
    chipMulti.classList.toggle('warn', states.multi);
    chipMulti.classList.toggle('on', states.multi);
  }
  if(states.phone !== undefined){
    chipPhone.classList.toggle('bad', states.phone);
    chipPhone.classList.toggle('on', states.phone);
  }
  if(states.book !== undefined){
    chipBook.classList.toggle('warn', states.book);
    chipBook.classList.toggle('on', states.book);
  }
  if(states.device !== undefined){
    chipDevice.classList.toggle('warn', states.device);
    chipDevice.classList.toggle('on', states.device);
  }
}

function updateTimerUI(){
  if(!startTime) return;
  const ms = Date.now() - startTime.getTime();
  sumDur.textContent = msToClock(ms);
}

// ======= EXPORTS =======
function toCsv(){
  const rows = [['t','type','details']];
  events.forEach(e=> rows.push([e.t, e.type, JSON.stringify(e.details || {})]));
  return rows.map(r=> r.map(x => `"${String(x).replace(/"/g,'""')}"`).join(',')).join('\n');
}
function downloadCsv(){
  const blob = new Blob([toCsv()], {type:'text/csv;charset=utf-8'});
  downloadBlob(blob, `${sessionId}_events.csv`);
}
function downloadJson(){
  const data = {
    candidate: candidateInput.value || 'Unknown',
    sessionId,
    startedAt: startTime?.toISOString(),
    durationSec: Math.floor((Date.now() - startTime.getTime())/1000),
    metrics: {
      focusLost: counts.away, noFace10s: counts.noface, multipleFaces: counts.multi,
      phone: counts.phone, notesOrBook: counts.book, extraDevices: counts.device
    },
    integrityScore: Number(scoreEl.textContent),
    events
  };
  const blob = new Blob([JSON.stringify(data,null,2)], {type:'application/json'});
  downloadBlob(blob, `${sessionId}_report.json`);
}
function openPrintableReport(){
  const html = `
<!doctype html><html><head><meta charset="utf-8">
<title>Proctoring Report</title>
<style>
  body{font-family:Arial;padding:24px}
  h1{margin:0 0 8px}
  .muted{color:#555}
  table{border-collapse:collapse;margin-top:12px}
  td,th{border:1px solid #ccc;padding:6px 8px}
</style></head><body>
<h1>Proctoring Report</h1>
<div class="muted">${new Date().toLocaleString()}</div>
<p><b>Candidate:</b> ${candidateInput.value || 'Unknown'}<br/>
<b>Session ID:</b> ${sessionId}<br/>
<b>Started:</b> ${startTime?.toISOString()}<br/>
<b>Duration:</b> ${sumDur.textContent}</p>
<table>
<tr><th>Metric</th><th>Count</th></tr>
<tr><td>Focus Lost (5s)</td><td>${counts.away}</td></tr>
<tr><td>No Face (10s)</td><td>${counts.noface}</td></tr>
<tr><td>Multiple Faces</td><td>${counts.multi}</td></tr>
<tr><td>Phone</td><td>${counts.phone}</td></tr>
<tr><td>Book/Notes</td><td>${counts.book}</td></tr>
<tr><td>Extra Devices</td><td>${counts.device}</td></tr>
<tr><td><b>Integrity Score</b></td><td><b>${scoreEl.textContent}</b></td></tr>
</table>
<h3>Events</h3>
<table>
<tr><th>Time</th><th>Type</th><th>Details</th></tr>
${events.map(e=>`<tr><td>${e.t}</td><td>${e.type}</td><td>${(e.details && JSON.stringify(e.details))||''}</td></tr>`).join('')}
</table>
<script>window.onload=()=>window.print()</script>
</body></html>`;
  const w = window.open('', '_blank');
  w.document.write(html); w.document.close();
}

// ======= LIFECYCLE =======
async function startInterview(){
  if(running) return;
  Object.keys(counts).forEach(k=> counts[k]=0);
  [cntAway,cntNoFace,cntMulti,cntPhone,cntBook,cntDevice].forEach(el=> el.textContent='0');
  scoreEl.textContent='100';
  events.length = 0; feed.innerHTML = '';

  await startCamera();

  if(!blazeModel){ blazeModel = await blazeface.load(); }
  if(!cocoModel){ cocoModel = await cocoSsd.load(); }

  running = true;
  sessionId = 'sid_' + Math.random().toString(36).slice(2,8);
  startTime = new Date();

  sumName.textContent = candidateInput.value || 'Unknown';
  sumSid.textContent  = sessionId;
  sumStart.textContent= startTime.toISOString();
  sumDur.textContent  = '00:00';
  timerHandle = setInterval(updateTimerUI, 500);

  mediaRecorder.start(1000);

  startBtn.disabled = true;
  stopBtn.disabled = false;
  downloadVideoBtn.disabled = true;
  downloadCsvBtn.disabled = true;
  downloadJsonBtn.disabled = true;
  openPdfBtn.disabled = true;

  requestAnimationFrame(faceLoop);
  objectLoop();
}

async function stopInterview(){
  if(!running) return;
  running = false;
  clearInterval(timerHandle);

  mediaRecorder.stop();
  stopCamera();

  const blob = new Blob(recordedChunks, { type: 'video/webm' });
  downloadVideoBtn.onclick = ()=> downloadBlob(blob, `${sessionId}.webm`);
  downloadCsvBtn.onclick   = downloadCsv;
  downloadJsonBtn.onclick  = downloadJson;
  openPdfBtn.onclick       = openPrintableReport;

  startBtn.disabled = false;
  stopBtn.disabled = true;
  downloadVideoBtn.disabled = false;
  downloadCsvBtn.disabled = false;
  downloadJsonBtn.disabled = false;
  openPdfBtn.disabled = false;

  setChips({focus:false, away:false, noface:false, multi:false, phone:false, book:false, device:false});
}

// ======= HOOK UP =======
startBtn.addEventListener('click', startInterview);
stopBtn.addEventListener('click', stopInterview);
