const TIERS = ["S", "A", "B", "C", "D", "F"];
const BLUE = ["#1748b8", "#3168d3", "#5c8be1", "#86aae9", "#aec9f0", "#d8e5f7"];
const RED = ["#d92f28", "#e9554e", "#ee7772", "#f39b97", "#f7bfbd", "#fbe0df"];
const STORAGE_KEY = "priority-tier-matrix.current.v1";
const HISTORY_KEY = "priority-tier-matrix.history.v1";
const DB_NAME = "priority-tier-matrix.v2";
const DB_STORE = "boards";

const matrix = document.querySelector("#matrix");
const freeSpace = document.querySelector("#freeSpace");
const titleInput = document.querySelector("#boardTitle");
const updatedAt = document.querySelector("#updatedAt");
const saveState = document.querySelector("#saveState");
const historyList = document.querySelector("#historyList");
const dialog = document.querySelector("#editorDialog");
const cardText = document.querySelector("#cardText");
const cardDeadline = document.querySelector("#cardDeadline");
const cardImage = document.querySelector("#cardImage");
const editorPreview = document.querySelector("#editorPreview");
const fileName = document.querySelector("#fileName");
const toast = document.querySelector("#toast");

let state = { id: null, title: "오늘의 우선순위", cards: [], updatedAt: null };
let editingId = null;
let editingImage = "";
let editingDeadline = "";
let draggingId = null;
let autosaveTimer = null;
let historyCache = [];
let databasePromise = null;

function uid() { return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`; }
function escapeHTML(value = "") { return value.replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char])); }
function formatDate(iso, detailed = false) {
  if (!iso) return "아직 저장되지 않았습니다";
  return new Intl.DateTimeFormat("ko-KR", { year:"numeric", month:"2-digit", day:"2-digit", hour:"2-digit", minute:"2-digit", ...(detailed ? {second:"2-digit"} : {}) }).format(new Date(iso));
}
function toLocalInput(iso) { if (!iso) return ""; const date = new Date(iso); return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function deadlineInfo(iso) {
  if (!iso) return null;
  const diff = new Date(iso).getTime() - Date.now();
  const days = Math.ceil(diff / 86400000);
  const label = diff <= 0 ? "기한 지남" : diff <= 86400000 ? "24시간 이내" : `D-${days}`;
  return { label, overdue: diff <= 0, row: diff <= 86400000 ? 0 : diff <= 259200000 ? 1 : diff <= 604800000 ? 2 : diff <= 1209600000 ? 3 : diff <= 2592000000 ? 4 : 5 };
}
function applyDeadlineSorting() {
  let changed = false;
  state.cards.forEach(card => {
    if (!card.deadline || card.zone === "free") return;
    const parts = card.zone.split(":"); if (parts.length !== 2) return;
    const nextZone = `${deadlineInfo(card.deadline).row}:${parts[1]}`;
    if (card.zone !== nextZone) { card.zone = nextZone; changed = true; }
  });
  return changed;
}
function showToast(message) { toast.textContent = message; toast.classList.add("show"); clearTimeout(showToast.timer); showToast.timer = setTimeout(() => toast.classList.remove("show"), 2200); }
function openDatabase() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}
async function dbGet(key) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => { const request = db.transaction(DB_STORE, "readonly").objectStore(DB_STORE).get(key); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function dbSet(key, value) {
  const db = await openDatabase();
  return new Promise((resolve, reject) => { const transaction = db.transaction(DB_STORE, "readwrite"); transaction.objectStore(DB_STORE).put(value, key); transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); });
}

function buildMatrix() {
  matrix.innerHTML = `<div class="corner-cell"><small>IMPORTANT →</small><small>DEADLINE ↑</small></div>`;
  TIERS.forEach((tier, index) => {
    const head = document.createElement("div"); head.className = "col-head"; head.style.background = BLUE[index]; head.style.color = index < 3 ? "white" : "#171817";
    head.innerHTML = `${tier}<small>${index === 0 ? "MOST" : index === 5 ? "LEAST" : "TIER"}</small>`; matrix.append(head);
  });
  TIERS.forEach((rowTier, row) => {
    const rowHead = document.createElement("div"); rowHead.className = "row-head"; rowHead.style.background = RED[row]; rowHead.style.color = row < 3 ? "white" : "#171817";
    rowHead.innerHTML = `${rowTier}<small>${row === 0 ? "MOST" : row === 5 ? "LEAST" : "TIER"}</small>`; matrix.append(rowHead);
    TIERS.forEach((colTier, col) => {
      const cell = document.createElement("div"); cell.className = "matrix-cell drop-zone"; cell.dataset.zone = `${row}:${col}`; cell.dataset.coordinate = `${rowTier} × ${colTier}`; cell.setAttribute("aria-label", `급함 ${rowTier}, 중요도 ${colTier}`); matrix.append(cell);
    });
  });
  bindDropZones();
}

function cardElement(card) {
  const el = document.createElement("article"); el.className = `tier-card${card.image && !card.text ? " image-only" : ""}`; el.draggable = true; el.dataset.id = card.id; el.tabIndex = 0;
  el.setAttribute("aria-label", `${card.text || "이미지 카드"}, 더블클릭하여 편집`);
  const deadline = deadlineInfo(card.deadline);
  el.innerHTML = `${deadline ? `<time class="card-deadline${deadline.overdue ? " overdue" : ""}" datetime="${card.deadline}" title="${formatDate(card.deadline, true)}">${deadline.label}</time>` : ""}${card.image ? `<img src="${card.image}" alt="" draggable="false" />` : ""}${card.text ? `<p>${escapeHTML(card.text)}</p>` : ""}<span class="card-grip">•••</span>`;
  el.addEventListener("dragstart", e => { draggingId = card.id; el.classList.add("dragging"); e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", card.id); });
  el.addEventListener("dragend", () => { draggingId = null; el.classList.remove("dragging"); document.querySelectorAll(".drag-over").forEach(x => x.classList.remove("drag-over")); });
  el.addEventListener("dblclick", () => openEditor(card.id));
  el.addEventListener("keydown", e => { if (e.key === "Enter") openEditor(card.id); });
  return el;
}

function render() {
  document.querySelectorAll(".tier-card").forEach(el => el.remove());
  state.cards.forEach(card => {
    const zone = card.zone === "free" ? freeSpace : document.querySelector(`[data-zone="${card.zone}"]`);
    (zone || freeSpace).append(cardElement(card));
  });
  freeSpace.classList.toggle("has-cards", state.cards.some(card => card.zone === "free"));
  titleInput.value = state.title;
  updatedAt.textContent = state.updatedAt ? `마지막 수정 ${formatDate(state.updatedAt)}` : "아직 저장되지 않았습니다";
  renderHistory();
}

function bindDropZones() {
  document.querySelectorAll(".drop-zone").forEach(zone => {
    zone.addEventListener("dragover", e => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; zone.classList.add("drag-over"); });
    zone.addEventListener("dragleave", e => { if (!zone.contains(e.relatedTarget)) zone.classList.remove("drag-over"); });
    zone.addEventListener("drop", e => {
      e.preventDefault(); zone.classList.remove("drag-over");
      const id = draggingId || e.dataTransfer.getData("text/plain"); const card = state.cards.find(item => item.id === id);
      if (card) {
        card.zone = zone.dataset.zone;
        if (card.deadline && card.zone !== "free") card.zone = `${deadlineInfo(card.deadline).row}:${card.zone.split(":")[1]}`;
        markChanged(); render();
      }
    });
  });
}

function markChanged() {
  state.updatedAt = new Date().toISOString();
  updatedAt.textContent = `마지막 수정 ${formatDate(state.updatedAt)}`;
  saveState.textContent = "변경사항 저장 중…";
  clearTimeout(autosaveTimer); autosaveTimer = setTimeout(async () => { if (await persistCurrent()) saveState.textContent = "자동 저장됨"; }, 400);
}
async function persistCurrent() {
  try {
    await dbSet("current", structuredClone(state));
    if (state.id) {
      const history = getHistory(); const index = history.findIndex(item => item.id === state.id);
      if (index >= 0) history.splice(index, 1);
      history.unshift(structuredClone(state));
      historyCache = history.slice(0, 12);
      await dbSet("history", structuredClone(historyCache));
      renderHistory();
    }
    return true;
  } catch { saveState.textContent = "저장 실패"; showToast("브라우저 저장소에 보드를 저장하지 못했습니다"); return false; }
}
function getHistory() { return historyCache; }
function setHistory(items) {
  historyCache = structuredClone(items.slice(0, 12));
  dbSet("history", historyCache).catch(() => { saveState.textContent = "저장 실패"; showToast("저장 기록을 보관하지 못했습니다"); });
  return true;
}

async function saveSnapshot() {
  state.id ||= uid(); state.title = titleInput.value.trim() || "제목 없는 보드"; state.updatedAt = new Date().toISOString();
  const snapshot = structuredClone(state); const history = getHistory(); const index = history.findIndex(item => item.id === state.id);
  if (index >= 0) history.splice(index, 1);
  history.unshift(snapshot);
  if (setHistory(history) && await persistCurrent()) { render(); showToast("현재 보드를 저장했습니다"); }
}
function loadSnapshot(snapshot) { state = { id:snapshot.id, title:snapshot.title, cards:structuredClone(snapshot.cards), updatedAt:snapshot.updatedAt }; persistCurrent(); render(); showToast("저장한 보드를 불러왔습니다"); window.scrollTo({top:260, behavior:"smooth"}); }

function renderHistory() {
  const items = getHistory();
  if (!items.length) { historyList.innerHTML = `<p class="history-empty">아직 저장한 보드가 없습니다. 완성된 보드를 저장하면 여기에 표시됩니다.</p>`; return; }
  historyList.innerHTML = "";
  items.forEach((item, index) => {
    const el = document.createElement("article"); el.className = "history-card";
    const usedZones = new Set(item.cards.filter(c => c.zone !== "free").map(c => c.zone));
    el.innerHTML = `<div class="mini-grid">${Array.from({length:36},(_,i)=>`<i class="${usedZones.has(`${Math.floor(i/6)}:${i%6}`)?"filled":""}"></i>`).join("")}</div><h3>${escapeHTML(item.title)}</h3><p>수정 ${formatDate(item.updatedAt, true)} · 카드 ${item.cards.length}개</p><div class="history-card-actions"><button class="text-button load-history" type="button">열기</button><button class="text-button danger delete-history" type="button">삭제</button></div>`;
    el.querySelector(".load-history").addEventListener("click", () => loadSnapshot(item));
    el.querySelector(".delete-history").addEventListener("click", () => { const next = getHistory(); next.splice(index,1); setHistory(next); renderHistory(); showToast("저장 기록을 삭제했습니다"); });
    historyList.append(el);
  });
}

function openEditor(id = null, initial = {}) {
  editingId = id; const card = id ? state.cards.find(item => item.id === id) : null;
  cardText.value = card?.text ?? initial.text ?? ""; editingImage = card?.image ?? initial.image ?? ""; editingDeadline = card?.deadline ?? initial.deadline ?? ""; cardDeadline.value = toLocalInput(editingDeadline); cardImage.value = ""; fileName.textContent = editingImage ? "현재 이미지" : "PNG, JPG, WEBP";
  document.querySelector("#dialogTitle").textContent = card ? "카드 편집" : "새 카드"; document.querySelector("#deleteCardButton").style.visibility = card ? "visible" : "hidden";
  updateEditorPreview(); dialog.showModal(); setTimeout(() => cardText.focus(), 60);
}
function updateEditorPreview() {
  const text = cardText.value.trim();
  if (!text && !editingImage) { editorPreview.innerHTML = "<span>텍스트를 입력하거나 이미지를 선택하세요</span>"; return; }
  editorPreview.innerHTML = ""; editorPreview.append(cardElement({id:"preview", text, image:editingImage, deadline:editingDeadline})); editorPreview.querySelector(".tier-card").draggable = false;
}
function readImage(file) { return new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); }); }

async function handlePaste(event) {
  if (dialog.open && event.target === cardText) return;
  const items = [...(event.clipboardData?.items || [])]; const imageItem = items.find(item => item.type.startsWith("image/")); const text = event.clipboardData?.getData("text/plain")?.trim() || "";
  if (!imageItem && !text) return; event.preventDefault();
  let image = ""; if (imageItem) image = await readImage(imageItem.getAsFile());
  state.cards.push({ id:uid(), text, image, deadline:"", zone:"free" }); markChanged(); render(); showToast(image && text ? "이미지와 텍스트 카드를 만들었습니다" : image ? "이미지 카드를 만들었습니다" : "텍스트 카드를 만들었습니다");
}

function saveEditor() {
  const text = cardText.value.trim(); if (!text && !editingImage) { showToast("텍스트나 이미지 중 하나를 추가해 주세요"); return; }
  if (editingId) { const card = state.cards.find(item => item.id === editingId); card.text = text; card.image = editingImage; card.deadline = editingDeadline; if (card.deadline && card.zone !== "free") card.zone = `${deadlineInfo(card.deadline).row}:${card.zone.split(":")[1]}`; }
  else state.cards.push({id:uid(), text, image:editingImage, deadline:editingDeadline, zone:"free"});
  dialog.close(); markChanged(); render(); showToast(editingId ? "카드를 수정했습니다" : "카드를 추가했습니다");
}

function roundRect(ctx,x,y,w,h,r=8) { ctx.beginPath(); ctx.roundRect(x,y,w,h,r); }
function wrapLines(ctx,text,maxWidth,maxLines=4) { const chars=[...text]; const lines=[]; let line=""; for(const char of chars){ const test=line+char; if(ctx.measureText(test).width>maxWidth&&line){lines.push(line);line=char;if(lines.length===maxLines-1)break;}else line=test;} if(line)lines.push(line); return lines; }
function loadCanvasImage(src) { return new Promise(resolve => { const img=new Image(); img.onload=()=>resolve(img); img.onerror=()=>resolve(null); img.src=src; }); }
async function exportPNG() {
  const W=1600,pad=72,label=92,head=80,cardsPerRow=3,cardH=118,gap=10,cellW=(W-pad*2-label)/6;
  const rowHeights=TIERS.map((_,r)=>{let max=0;for(let c=0;c<6;c++)max=Math.max(max,state.cards.filter(card=>card.zone===`${r}:${c}`).length);return Math.max(148,Math.ceil(max/cardsPerRow)*(cardH+gap)+20);});
  const boardHeight=rowHeights.reduce((sum,value)=>sum+value,0),H=98+head+boardHeight+110;
  const canvas=document.createElement("canvas"); canvas.width=W; canvas.height=H; const ctx=canvas.getContext("2d");
  ctx.fillStyle="#f4f2ed";ctx.fillRect(0,0,W,H);ctx.fillStyle="#171817";ctx.font="900 48px Arial";ctx.fillText(state.title||"제목 없는 보드",pad,62);ctx.font="16px monospace";ctx.fillStyle="#71746e";const stamp=formatDate(new Date().toISOString(),true);ctx.fillText(`EXPORTED ${stamp}`,W-pad-ctx.measureText(`EXPORTED ${stamp}`).width,58);
  const ox=pad,oy=98;ctx.fillStyle="#171817";ctx.fillRect(ox,oy,label,head);
  TIERS.forEach((t,i)=>{ctx.fillStyle=BLUE[i];ctx.fillRect(ox+label+i*cellW,oy,cellW,head);ctx.fillStyle=i<3?"white":"#171817";ctx.font="900 34px Arial";ctx.textAlign="center";ctx.fillText(t,ox+label+i*cellW+cellW/2,oy+51);});
  let rowY=oy+head;
  for (let r=0;r<6;r++) {
    const t=TIERS[r],cellH=rowHeights[r]; ctx.fillStyle=RED[r];ctx.fillRect(ox,rowY,label,cellH);ctx.fillStyle=r<3?"white":"#171817";ctx.font="900 34px Arial";ctx.textAlign="center";ctx.fillText(t,ox+label/2,rowY+cellH/2+11);
    for(let c=0;c<6;c++){const x=ox+label+c*cellW,y=rowY;ctx.fillStyle="#fffefa";ctx.fillRect(x,y,cellW,cellH);ctx.strokeStyle="#171817";ctx.lineWidth=2;ctx.strokeRect(x,y,cellW,cellH);const cards=state.cards.filter(card=>card.zone===`${r}:${c}`);for(let k=0;k<cards.length;k++)await drawExportCard(ctx,cards[k],x+10+(k%cardsPerRow)*64,y+10+Math.floor(k/cardsPerRow)*(cardH+gap),58,cardH);}
    rowY+=cellH;
  }
  ctx.strokeStyle="#171817";ctx.lineWidth=2;ctx.strokeRect(ox,oy,label+cellW*6,head+boardHeight);ctx.save();ctx.translate(28,oy+head+boardHeight/2);ctx.rotate(-Math.PI/2);ctx.fillStyle="#d92f28";ctx.font="900 16px Arial";ctx.textAlign="center";ctx.fillText("급함 · DEADLINE  →",0,0);ctx.restore();ctx.fillStyle="#1748b8";ctx.font="900 16px Arial";ctx.textAlign="center";ctx.fillText("←  중요도 · IMPORTANT  →",ox+label+cellW*3,H-72);ctx.textAlign="left";
  const link=document.createElement("a"); const safe=(state.title||"tier-matrix").replace(/[\\/:*?\"<>|]/g,"-").slice(0,40); const d=new Date(); const key=`${d.getFullYear()}${String(d.getMonth()+1).padStart(2,"0")}${String(d.getDate()).padStart(2,"0")}-${String(d.getHours()).padStart(2,"0")}${String(d.getMinutes()).padStart(2,"0")}`;link.download=`${safe}-${key}.png`;link.href=canvas.toDataURL("image/png");link.click();showToast("날짜와 시간을 포함한 PNG를 저장했습니다");
}
async function drawExportCard(ctx,card,x,y,w,h){ctx.fillStyle="#fff";ctx.strokeStyle="#171817";ctx.lineWidth=1.5;ctx.fillRect(x,y,w,h);ctx.strokeRect(x,y,w,h);let textY=y+13;if(card.image){const img=await loadCanvasImage(card.image);if(img){const imageH=card.text?72:h-4;const ratio=Math.max(w/img.width,imageH/img.height);const sw=w/ratio,sh=imageH/ratio,sx=(img.width-sw)/2,sy=(img.height-sh)/2;ctx.drawImage(img,sx,sy,sw,sh,x+2,y+2,w-4,imageH-4);textY=y+imageH+14;}}if(card.deadline){ctx.fillStyle="#d92f28";ctx.font="800 7px Arial";ctx.textAlign="left";ctx.fillText(deadlineInfo(card.deadline).label,x+4,y+h-5);}if(card.text){ctx.fillStyle="#171817";ctx.font="700 9px Arial";ctx.textAlign="left";wrapLines(ctx,card.text,w-8,3).forEach((line,i)=>ctx.fillText(line,x+4,textY+i*11));}}

document.addEventListener("paste", handlePaste);
titleInput.addEventListener("input", () => { state.title=titleInput.value; markChanged(); });
document.querySelector("#addCardButton").addEventListener("click", () => openEditor());
document.querySelector("#confirmCardButton").addEventListener("click", saveEditor);
document.querySelector("#removeImageButton").addEventListener("click", () => { editingImage=""; fileName.textContent="PNG, JPG, WEBP"; updateEditorPreview(); });
document.querySelector("#deleteCardButton").addEventListener("click", () => { if(editingId){state.cards=state.cards.filter(c=>c.id!==editingId);dialog.close();markChanged();render();showToast("카드를 삭제했습니다");} });
cardText.addEventListener("input", updateEditorPreview);
cardDeadline.addEventListener("input", () => { editingDeadline = cardDeadline.value ? new Date(cardDeadline.value).toISOString() : ""; updateEditorPreview(); });
cardImage.addEventListener("change", async () => { const file=cardImage.files[0];if(file){editingImage=await readImage(file);fileName.textContent=file.name;updateEditorPreview();} });
document.querySelector("#saveButton").addEventListener("click", saveSnapshot);
document.querySelector("#exportButton").addEventListener("click", exportPNG);
document.querySelector("#loadLatestButton").addEventListener("click", () => { const latest=getHistory()[0];if(latest)loadSnapshot(latest);else showToast("저장한 보드가 아직 없습니다"); });
document.querySelector("#newBoardButton").addEventListener("click", () => { state={id:null,title:"새 우선순위 보드",cards:[],updatedAt:null};persistCurrent();render();showToast("새 보드를 시작했습니다"); });
document.querySelector("#clearHistoryButton").addEventListener("click", () => { setHistory([]);renderHistory();showToast("저장 기록을 비웠습니다"); });

buildMatrix();
render();
async function initializeStorage() {
  let saved = null, savedHistory = null, migrated = false;
  try { [saved, savedHistory] = await Promise.all([dbGet("current"), dbGet("history")]); } catch {}
  if (!saved) { try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null"); migrated ||= Boolean(saved); } catch {} }
  if (!savedHistory?.length) { try { savedHistory = JSON.parse(localStorage.getItem(HISTORY_KEY) || "[]"); migrated ||= savedHistory.length > 0; } catch {} }
  if (saved?.cards) state = saved;
  historyCache = Array.isArray(savedHistory) ? savedHistory : [];
  if (state.cards.length && state.updatedAt) {
    state.id ||= uid();
    const index = historyCache.findIndex(item => item.id === state.id);
    if (index >= 0) historyCache.splice(index, 1);
    historyCache.unshift(structuredClone(state));
    historyCache = historyCache.slice(0, 12);
  }
  applyDeadlineSorting();
  try {
    await Promise.all([dbSet("current", structuredClone(state)), dbSet("history", structuredClone(historyCache))]);
    if (migrated) { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(HISTORY_KEY); }
  } catch { showToast("기존 보드를 새 저장소로 옮기지 못했습니다"); }
  render();
  if (migrated) showToast("기존 보드를 복구해 새 저장소로 옮겼습니다");
}
initializeStorage();
setInterval(() => { if (applyDeadlineSorting()) { markChanged(); render(); } }, 60000);
