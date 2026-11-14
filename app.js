/*
  SCANTY MD BOT dashboard
  Connect your real backend by changing API_BASE below.
  Expected optional endpoints:
    GET  /api/status
    POST /api/pairing-code   body: { phone }
    GET  /api/qr
    GET  /api/sessions
    POST /api/settings
*/
const API_BASE = ""; // Example: "https://your-scanty-api.example.com"
const state = { startedAt: Date.now() - (12*60+34)*1000, qrTimer:null };

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];

function toast(message){
  const el=$("#toast"); el.textContent=message; el.classList.add("show");
  clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove("show"),3000);
}

async function api(path, options={}){
  if(!API_BASE) throw new Error("demo");
  const r=await fetch(API_BASE+path,{...options,headers:{"Content-Type":"application/json",...(options.headers||{})}});
  if(!r.ok) throw new Error(`API ${r.status}`);
  return r.json();
}

function showSection(name){
  $$(".nav-item").forEach(b=>b.classList.toggle("active",b.dataset.section===name));
  $$("[data-section-panel]").forEach(p=>p.classList.toggle("hidden",p.dataset.sectionPanel!==name));
  $("#sidebar").classList.remove("open");
  window.scrollTo({top:0,behavior:"smooth"});
}

$$(".nav-item").forEach(b=>b.addEventListener("click",()=>showSection(b.dataset.section)));
$$("[data-go]").forEach(b=>b.addEventListener("click",()=>showSection(b.dataset.go)));
$("#menuBtn").addEventListener("click",()=>$("#sidebar").classList.toggle("open"));
$("#logoutBtn").addEventListener("click",()=>toast("Logout endpoint is not configured yet."));

function uptime(){
  const seconds=Math.floor((Date.now()-state.startedAt)/1000);
  const h=String(Math.floor(seconds/3600)).padStart(2,"0");
  const m=String(Math.floor(seconds%3600/60)).padStart(2,"0");
  const s=String(seconds%60).padStart(2,"0");
  $("#uptime").textContent=`${h}:${m}:${s}`;
}
setInterval(uptime,1000); uptime();

async function generatePairing(){
  const phone=$("#phoneInput").value.replace(/\D/g,"");
  if(phone.length<8){toast("Enter a valid international phone number.");return;}
  $("#pairBtn").disabled=true; $("#pairStatus").textContent="Requesting code…";
  try{
    const data=await api("/api/pairing-code",{method:"POST",body:JSON.stringify({phone})});
    $("#pairCode").textContent=data.code||"--------";
    $("#pairStatus").textContent=data.message||"Pairing code ready";
  }catch{
    // Safe demo fallback. Replace with your API and this disappears automatically.
    const code = Array.from({length:8},(_,i)=>"ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[(phone.charCodeAt(i%phone.length)+i*11)%32]).join("");
    $("#pairCode").textContent=code.slice(0,4)+"-"+code.slice(4);
    $("#pairStatus").textContent="Demo code — connect your API for real pairing";
    toast("Demo pairing code generated.");
  }finally{$("#pairBtn").disabled=false}
}
$("#pairBtn").addEventListener("click",generatePairing);

async function generateQR(){
  $("#qrState").textContent="Loading…";
  try{
    const data=await api("/api/qr");
    if(data.qr){
      renderQR(data.qr);
      startCountdown(data.expiresIn||60);
      $("#qrState").textContent="Waiting for scan";
      toast("Fresh QR code loaded.");
      return;
    }
  }catch{}
  // Demo QR payload. Real API should return a Baileys QR string in data.qr.
  renderQR("SCANTY-DEMO-QR-"+Date.now());
  startCountdown(60);
  $("#qrState").textContent="Demo QR";
  toast("Demo QR shown — connect your API for WhatsApp pairing.");
}
function renderQR(value){
  const box=$("#qrBox"); box.innerHTML="";
  if(window.QRCode){ QRCode.toCanvas(value,{width:260,margin:1},(err,canvas)=>{if(!err)box.appendChild(canvas)}); }
  else box.innerHTML='<div class="qr-placeholder">QR</div>';
}
function startCountdown(seconds){
  clearInterval(state.qrTimer); let n=seconds; $("#qrCountdown").textContent=`Expires in ${n}s`;
  state.qrTimer=setInterval(()=>{n--;$("#qrCountdown").textContent=n>0?`Expires in ${n}s`:"Expired — refresh";if(n<=0)clearInterval(state.qrTimer)},1000);
}
$("#qrBtn").addEventListener("click",generateQR);

$("#saveSettings").addEventListener("click",async()=>{
  const settings={alwaysOnline:$$(".setting input")[0].checked,autoViewStatus:$$(".setting input")[1].checked,statusReact:$$(".setting input")[2].checked,welcome:$$(".setting input")[3].checked,goodbye:$$(".setting input")[4].checked,autoReact:$$(".setting input")[5].checked};
  try{await api("/api/settings",{method:"POST",body:JSON.stringify(settings)});toast("Settings saved.");}
  catch{toast("Demo mode: settings changed locally. Connect the API to persist them.");}
});

async function loadStatus(){
  try{
    const data=await api("/api/status");
    if(data.totalAccounts!=null)$("#totalAccounts").textContent=data.totalAccounts;
    if(data.normalUsers!=null)$("#normalUsers").textContent=data.normalUsers;
    if(data.admins!=null)$("#admins").textContent=data.admins;
    if(data.status)$("#botStatus").textContent=data.status;
  }catch{}
}
loadStatus();
