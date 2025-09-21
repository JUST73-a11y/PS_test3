// public/app.js
const API_ROOT = "/api";

function getToken() { return localStorage.getItem("ps_token"); }
function setToken(t) { localStorage.setItem("ps_token", t); }
function removeToken() { localStorage.removeItem("ps_token"); }

function authHeaders(extra = {}) {
    const token = getToken();
    const h = { ...extra };
    if (token) h["Authorization"] = "Bearer " + token;
    if (!h["Content-Type"]) h["Content-Type"] = "application/json";
    return h;
}

// helper for fetch -> auto-handle 401
async function fetchJson(url, opts = {}) {
    const res = await fetch(url, opts);
    if (res.status === 401) {
        // invalid token -> remove and redirect to login
        removeToken();
        window.location.href = "/login.html";
        throw new Error("Unauthorized");
    }
    const txt = await res.text();
    try { return JSON.parse(txt); } catch (e) { return txt; }
}

// require logged in (redirect to login if no token)
function requireAuth() {
    if (!getToken()) {
        window.location.href = "/login.html";
        return false;
    }
    return true;
}

// build navbar (call after DOMContentLoaded)
function buildNav() {
    if (document.getElementById("ps-nav")) return;

    const nav = document.createElement("nav");
    nav.id = "ps-nav";
    nav.innerHTML = `
      <span class="psclub-logo" style="    margin: 0 auto;
    width: 80%;
    display: flex;
    justify-content: center;">🎮 <b>PS Club</b></span>

    <div style="display: flex; align-items: center; gap: 30px; font-size: 20px; margin-top: 40px;">
      <a href="/dashboard.html" class="btn">Zakas Qoshish</a>
      <a href="/process.html" class="btn">Jarayonda</a>
      <a href="/completed.html" class="btn">Yakunlangan</a>
      <a href="/trash.html" class="btn">Trash</a>
      <a href="/archive.html" class="btn">Arxiv</a>
    </div>
    <div>
      <button id="dailyBtn" class="btn btn-primary btn_size">📊 Kunlik Hisob</button>
      <button id="archiveBtn" class="btn btn-warning btn_size"> Hsobni yanglash!</button>
      <button id="clearBtn" class="btn danger btn_size">🧹 DB Tozalash</button>
      <button id="logoutBtn" class="btn btn_size" style="    margin-top: 7px;">Logout</button>
    </div>
  `;
    document.body.prepend(nav);

    // Active link
    const path = location.pathname.replace(/\/+$/, "");
    nav.querySelectorAll("a").forEach(a => {
        if (a.getAttribute("href") === path) a.classList.add("active");
    });

    document.getElementById("logoutBtn").onclick = () => {
        removeToken();
        window.location.href = "/login.html";
    };

    document.getElementById("dailyBtn").onclick = async () => {
        if (!(await modalConfirm("Kunlik hisob Telegramga yuborilsinmi?", "Kunlik Hisob"))) return;
        try {
            const j = await fetchJson("/api/daily-report", { method: "POST", headers: authHeaders() });
            if (j.ok) await modalAlert("Kunlik hisobot Telegramga yuborildi", "Kunlik Hisob");
            else await modalAlert("Xato: " + (j.error || JSON.stringify(j)), "Kunlik Hisob");
        } catch (e) { console.error(e); }
    };

    document.getElementById("clearBtn").onclick = async () => {
        if (!(await modalConfirm("Barcha zakazlarni o‘chirishni istaysizmi?", "DB tozalash"))) return;
        const superKey = await modalPrompt("Super admin keyni kiriting:", "Super admin");
        if (!superKey) {
            await modalAlert("Key kerak", "Super admin");
            return;
        }
        const res = await fetch("/api/clear", { method: "POST", headers: authHeaders({ "super-key": superKey }) });
        const j = await res.json();
        if (j.ok) {
            await modalAlert(
                `Barcha zakazlar o‘chirildi!<br>
                <b>Umumiy zakazlar:</b> ${j.totalCount}<br>
                <b>Umumiy tushum:</b> ${j.totalSum} so'm`,
                "DB tozalash"
            );
            location.reload();
        } else {
            await modalAlert("Xato: " + (j.error || JSON.stringify(j)), "DB tozalash");
        }
    };

    document.getElementById("archiveBtn").onclick = async () => {
        if (!(await modalConfirm("Kunlik hisobni arxivga o‘tkazishni tasdiqlaysizmi? Oldingi kun zakazlari arxivga o‘tadi.", "Kunlik hisobni arxivlash"))) return;
        const superKey = await modalPrompt("Super admin keyni kiriting:", "Super admin");
        if (!superKey) {
            await modalAlert("Key kerak", "Super admin");
            return;
        }
        const res = await fetch("/api/archive-day", { method: "POST", headers: authHeaders({ "super-key": superKey }) });
        const j = await res.json();
        if (j.ok) {
            await modalAlert("Kunlik hisob arxivga o‘tkazildi!");
            if (typeof loadStats === "function") loadStats();
        } else {
            await modalAlert("Xato: " + (j.error || JSON.stringify(j)));
        }
    };
}

// Modal helpers
function showModal({ title = "", html = "", ok = "OK", cancel = null, input = false, value = "" }) {
    return new Promise(resolve => {
        let modal = document.getElementById("ps-modal");
        if (!modal) {
            modal = document.createElement("div");
            modal.id = "ps-modal";
            modal.innerHTML = `
                <div class="ps-modal-bg"></div>
                <div class="ps-modal-card">
                    <div class="ps-modal-title" style="font-size: 3em; font-weight: bold;"></div>
                    <div class="ps-modal-body " style="font-size: 3em;"></div>
                    <div class="ps-modal-actions"></div>
                </div>
            `;
            document.body.appendChild(modal);
        }
        modal.style.display = "flex";
        modal.querySelector(".ps-modal-title").innerHTML = title;
        modal.querySelector(".ps-modal-body").innerHTML = html + (input ? `<input id="ps-modal-input" style="width:100%;margin-top:12px" value="${value}">` : "");
        const actions = modal.querySelector(".ps-modal-actions");
        actions.innerHTML = "";
        if (cancel) {
            const btnCancel = document.createElement("button");
            btnCancel.className = "btn";
            btnCancel.innerText = cancel;
            btnCancel.onclick = () => { modal.style.display = "none"; resolve(null); };
            actions.appendChild(btnCancel);
        }
        const btnOk = document.createElement("button");
        btnOk.className = "btn btn-primary";
        btnOk.innerText = ok;
        btnOk.onclick = () => {
            modal.style.display = "none";
            if (input) resolve(document.getElementById("ps-modal-input").value);
            else resolve(true);
        };
        actions.appendChild(btnOk);
        if (input) setTimeout(() => document.getElementById("ps-modal-input").focus(), 100);
    });
}
async function modalAlert(msg, title = "Xabar") {
    await showModal({ title, html: msg, ok: "OK" });
}
async function modalConfirm(msg, title = "Tasdiqlang") {
    return await showModal({ title, html: msg, ok: "Ha", cancel: "Yo'q" });
}
async function modalPrompt(msg, title = "Ma'lumot kiriting", value = "") {
    return await showModal({ title, html: msg, ok: "OK", cancel: "Bekor", input: true, value });
}

window.completeOrder = async (id) => {
    const confirm = await modalConfirm("Zakazni yakunlaysizmi?");
    if (!confirm) return;
    const j = await fetch("/api/complete/" + id, { method: "POST", headers: authHeaders() }).then(r => r.json());
    if (j.ok) {
        await modalAlert(`Zakaz yopildi!<br><b>Summa:</b> ${j.order.summa} so'm`, "Zakaz yakunlandi");
        loadProcess();
    } else {
        await modalAlert("Xato: " + (j.error || JSON.stringify(j)));
    }
};

document.addEventListener("DOMContentLoaded", () => {
    buildNav();

    const archiveBtn = document.getElementById("archiveBtn");
    if (archiveBtn) {
        archiveBtn.onclick = async () => {
            if (!(await modalConfirm("Kunlik hisobni arxivga o‘tkazishni tasdiqlaysizmi? Oldingi kun zakazlari arxivga o‘tadi.", "Kunlik hisobni arxivlash"))) return;
            const superKey = await modalPrompt("Super admin keyni kiriting:", "Super admin");
            if (!superKey) {
                await modalAlert("Key kerak", "Super admin");
                return;
            }
            const res = await fetch("/api/archive-day", { method: "POST", headers: authHeaders({ "super-key": superKey }) });
            const j = await res.json();
            if (j.ok) {
                await modalAlert("Kunlik hisob arxivga o‘tkazildi!");
                if (typeof loadStats === "function") loadStats();
            } else {
                await modalAlert("Xato: " + (j.error || JSON.stringify(j)));
            }
        };
    }
});
