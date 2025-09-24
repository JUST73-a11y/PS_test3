// server.js (fixed + robust delete by _id|orderId|externalId + logging)
require("dotenv").config();
const express = require("express");
const path = require("path");
const mongoose = require("mongoose");
const fetch = require("node-fetch");
const jwt = require("jsonwebtoken");
const cors = require("cors");
const shortid = require("shortid");

const app = express();
app.use(express.json());
app.use(cors());

// simple request logger (helps debug "route not found")
app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
    res.on("finish", () => {
        console.log(`--> ${res.statusCode} ${req.method} ${req.originalUrl}`);
    });
    next();
});

// static files
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 3000;
const MONGO_URI = process.env.MONGO_URI;
const BOT_TOKEN = process.env.BOT_TOKEN;
const CHAT_ID = process.env.CHAT_ID;
const JWT_SECRET = process.env.JWT_SECRET || "secretjwt";
const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "12345";
const SUPER_KEY = process.env.SUPER_KEY || "supersecret";
const PRICE_PER_HOUR = Number(process.env.PRICE_PER_HOUR) || 15000;

// Mongo connection
mongoose.connect(MONGO_URI, { useNewUrlParser: true, useUnifiedTopology: true })
    .then(() => console.log("MongoDB connected"))
    .catch(err => {
        console.error("MongoDB connection error:", err.message);
        process.exit(1);
    });

// Counter for auto-increment orderId
const counterSchema = new mongoose.Schema({
    _id: String,
    seq: { type: Number, default: 0 }
});
const Counter = mongoose.model("Counter", counterSchema);
async function getNextSequence(name) {
    const ret = await Counter.findByIdAndUpdate(
        name,
        { $inc: { seq: 1 } },
        { new: true, upsert: true }
    );
    return ret.seq;
}

// Order schema (note: externalId for backwards-compat)
const orderSchema = new mongoose.Schema({
    orderId: { type: Number, unique: true, sparse: true }, // sequential
    externalId: { type: String, default: () => shortid.generate() }, // optional unique string id
    ps: { type: String, default: "PS1" },
    type: { type: String, enum: ["cash", "vip"], default: "vip" },
    startTime: { type: Date, default: () => getTashkentDate() },
    endTime: { type: Date, default: null },
    summa: { type: Number, default: 0 },
    status: { type: String, enum: ["process", "completed", "trash"], default: "process" },
    createdAt: { type: Date, default: Date.now },
    completedAt: { type: Date },
    deletedAt: { type: Date }
}, { versionKey: false });

// auto-increment orderId if missing
orderSchema.pre("save", async function (next) {
    if (this.isNew && (this.orderId === undefined || this.orderId === null)) {
        this.orderId = await getNextSequence("orderId");
    }
    next();
});

const Order = mongoose.model("Order", orderSchema);

// helper: find order by _id or orderId (number) or externalId (string)
async function findOrderByAnyId(id) {
    // try ObjectId
    if (mongoose.Types.ObjectId.isValid(id)) {
        const byId = await Order.findById(id);
        if (byId) return byId;
    }
    // try numeric orderId
    const n = Number(id);
    if (!isNaN(n)) {
        const byOrderId = await Order.findOne({ orderId: n });
        if (byOrderId) return byOrderId;
    }
    // try externalId
    const byExternal = await Order.findOne({ externalId: id });
    if (byExternal) return byExternal;

    return null;
}

// Telegram helper
async function sendToTelegram(text) {
    if (!BOT_TOKEN || !CHAT_ID) {
        console.warn("Telegram not configured (BOT_TOKEN or CHAT_ID missing)");
        // Do not throw or block, just log and continue
        return { ok: false, error: "Telegram not configured" };
    }
    try {
        const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" })
        });
        // Even if Telegram returns error (e.g. group not found), log but do not block
        const data = await res.json();
        if (!data.ok) {
            console.warn("Telegram API error:", data.description || data);
        }
        return data;
    } catch (e) {
        console.error("Telegram error:", e.message);
        // Never throw, always allow site to work
        return { ok: false, error: e.message };
    }

}

// Telegram helper (chunked)
async function sendToTelegramChunks(lines, title = "") {
    const MAX = 4000;
    let chunk = title ? `<b>${title}</b>\n` : "";
    for (const line of lines) {
        if ((chunk + line + "\n").length > MAX) {
            await sendToTelegram(chunk);
            chunk = "";
        }
        chunk += line + "\n";
    }
    if (chunk.trim()) await sendToTelegram(chunk);
}

// Auth middlewares
function authMiddleware(req, res, next) {
    const auth = req.headers.authorization || "";
    const parts = auth.split(" ");
    if (parts.length !== 2 || parts[0] !== "Bearer") return res.status(401).json({ ok: false, error: "No token" });
    const token = parts[1];
    try {
        const payload = jwt.verify(token, JWT_SECRET);
        req.user = payload;
        return next();
    } catch (e) {
        return res.status(401).json({ ok: false, error: "Token invalid or expired" });
    }
}
function superMiddleware(req, res, next) {
    const key = req.headers["super-key"] || req.headers["x-super-key"] || req.body.superKey || req.query.superKey;
    if (key === SUPER_KEY) return next();
    return res.status(403).json({ ok: false, error: "Super admin required" });
}

// Router
const api = express.Router();

// health check
api.get("/ping", (req, res) => res.json({ ok: true, msg: "pong" }));

// login
api.post("/login", (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ ok: false, error: "Missing credentials" });
    if (username === ADMIN_USER && password === ADMIN_PASS) {
        const token = jwt.sign({ role: "admin", username }, JWT_SECRET, { expiresIn: "12h" });
        return res.json({ ok: true, token });
    }
    return res.status(401).json({ ok: false, error: "Invalid username/password" });
});

// create order
api.post("/order", authMiddleware, async (req, res) => {
    try {
        const { ps = "PS1", type = "vip", amount = 0, startTime } = req.body || {};

        if (type === "cash" && (!amount || Number(amount) <= 0)) {
            return res.status(400).json({ ok: false, error: "Cash zakaz uchun summa majburiy!" });
        }

        const start = startTime ? new Date(startTime) : new Date();
        let end = null;
        let summa = Number(amount || 0);

        if (type === "cash") {
            const hours = summa / PRICE_PER_HOUR;
            const ms = Math.floor(hours * 3600 * 1000);
            end = new Date(start.getTime() + ms);
        }

        const o = new Order({ ps, type, startTime: start, endTime: end, summa, status: "process" });
        await o.save();

        const text = `<b>🎮 Yangi Zakaz</b>\nPS: ${o.ps}\nTuri: <u>${o.type.toUpperCase()}</u>\nSumma: <b>${o.summa.toLocaleString()} </b>so'm\n Boshlangan: ${formatTashkent(o.startTime)}\n${o.endTime ? `Yakun: ${formatTashkent(o.endTime)}\n` : ""}\n`;
        sendToTelegram(text).catch(console.error);

        return res.json({ ok: true, order: o });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// get all orders
api.get("/orders", authMiddleware, async (req, res) => {
    try {
        const orders = await Order.find().sort({ createdAt: -1 }).lean(); // yangi birinchi
        return res.json(orders);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// edit order
api.put("/order/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const { ps, type, amount, startTime, status } = req.body || {};
        const o = await findOrderByAnyId(id);
        if (!o) return res.status(404).json({ ok: false, error: "Not found" });

        if (ps) o.ps = ps;
        if (type) o.type = type;
        if (startTime) o.startTime = new Date(startTime);

        if (amount !== undefined) {
            const newAmount = Number(amount);

            // VIP: summa oshirilmaydi
            if (o.type === "vip" && newAmount > o.summa) {
                return res.status(400).json({ ok: false, error: "VIP summa oshirilmaydi!" });
            }

            // Cash must be >0
            if (o.type === "cash" && newAmount <= 0) {
                return res.status(400).json({ ok: false, error: "Cash summa > 0 bo‘lishi kerak!" });
            }

            o.summa = newAmount;
            if (o.type === "cash") {
                const hours = o.summa / PRICE_PER_HOUR;
                const ms = Math.floor(hours * 3600 * 1000);
                o.endTime = new Date(new Date(o.startTime).getTime() + ms);
            } else {
                o.endTime = null;
            }
        }

        if (status) o.status = status;
        await o.save();
        return res.json({ ok: true, order: o });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// complete order
api.post("/complete/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const o = await findOrderByAnyId(id);
        if (!o) return res.status(404).json({ ok: false, error: "Not found" });

        let qaytish = 0;
        let oynaganSumma = 0;
        let oynaganMinut = 0;
        let qolganMinut = 0;

        if (o.type === "vip") {
            const start = new Date(o.startTime);
            const end = new Date();
            const diffMs = end - start;
            oynaganMinut = Math.floor(diffMs / 60000);
            const diffHours = diffMs / (3600 * 1000);
            oynaganSumma = Math.ceil(diffHours * PRICE_PER_HOUR);
            oynaganSumma = Math.ceil(oynaganSumma / 1000) * 1000;
            o.summa = oynaganSumma;
            o.endTime = end;
        } else if (o.type === "cash") {
            const now = new Date();
            const start = new Date(o.startTime);
            const end = o.endTime ? new Date(o.endTime) : null;
            const oynaganMs = now - start;
            oynaganMinut = Math.floor(oynaganMs / 60000);
            oynaganSumma = Math.ceil(oynaganMs / (3600 * 1000) * PRICE_PER_HOUR);
            oynaganSumma = Math.ceil(oynaganSumma / 1000) * 1000;
            if (end && now < end) {
                qolganMinut = Math.floor((end - now) / 60000);
                qaytish = o.summa - oynaganSumma;
                o.summa = oynaganSumma;
                o.endTime = now;
            }
        }
        o.status = "completed";
        o.completedAt = new Date();
        await o.save();

        // Telegram xabari
        let text = `<b>✅ Zakaz yakunlandi</b>\n\nPS: ${o.ps}\n<u>Turi: ${o.type.toUpperCase()}</u>\nSumma: ${o.summa.toLocaleString()} so'm \nBoshlangan: ${formatTashkent(o.startTime)}\n${o.endTime ? `Yakun: ${formatTashkent(o.endTime)}\n` : "-"}\nO‘ynalgan vaqt: ${oynaganMinut} minut\nO‘ynalgan summa: ${oynaganSumma.toLocaleString()} so'm\n`;
        if (qaytish > 0) {
            text += `\nQolgan vaqt: ${qolganMinut} minut\nQaytishi kerak: ${qaytish.toLocaleString()} so'm`;
        }
        sendToTelegram(text).catch(console.error);

        return res.json({ ok: true, order: o, qaytish, oynaganSumma, oynaganMinut, qolganMinut });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// generic delete -> move to trash (accepts _id|orderId|externalId)
api.delete("/order/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const permanent = req.query.permanent == "1";
        const o = await findOrderByAnyId(id);
        if (!o) return res.status(404).json({ ok: false, error: "Not found" });

        if (permanent) {
            if (!req.headers["super-key"] && !req.headers["x-super-key"]) {
                return res.status(403).json({ ok: false, error: "Super admin required" });
            }
            await o.deleteOne();
            return res.json({ ok: true });
        }

        // Agar process bo‘lsa, prevStatus ni "process" qilib saqlaymiz
        o.prevStatus = o.status === "process" ? "process" : o.status;
        o.status = "trash";
        o.deletedAt = new Date();
        await o.save();
        return res.json({ ok: true, order: o });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// alias: delete completed (some frontends call /api/completed/:id)
api.delete("/completed/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const o = await findOrderByAnyId(id);
        if (!o) return res.status(404).json({ ok: false, error: "Not found" });
        if (o.status !== "completed") {
            return res.status(400).json({ ok: false, error: "Only completed orders can be deleted here" });
        }
        o.status = "trash";
        o.deletedAt = new Date();
        await o.save();
        return res.json({ ok: true, order: o });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// alias: delete orders/:id (another common pattern)
api.delete("/orders/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const o = await findOrderByAnyId(id);
        if (!o) return res.status(404).json({ ok: false, error: "Not found" });
        o.status = "trash";
        o.deletedAt = new Date();
        await o.save();
        return res.json({ ok: true, order: o });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// restore from trash (super)
api.post("/restore/:id", authMiddleware, async (req, res) => {
    try {
        const id = req.params.id;
        const o = await findOrderByAnyId(id);
        if (!o) return res.status(404).json({ ok: false, error: "Not found" });
        if (o.status !== "trash") {
            return res.status(400).json({ ok: false, error: "Faqat trash holatdagilarni restore qilish mumkin" });
        }
        // Hamma trashdan restore bo‘layotgan zakazlar completed bo‘lib qaytsin:
        o.status = "completed";
        o.completedAt = new Date();
        o.deletedAt = null;
        o.prevStatus = undefined;
        await o.save();
        return res.json({ ok: true, order: o });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// completed list
api.get("/completed", authMiddleware, async (req, res) => {
    try {
        const completed = await Order.find({ status: "completed" }).sort({ completedAt: -1 }).lean();
        return res.json(completed);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// daily report (bugungi zakazlar va umumiy summa)
api.get("/daily-report", authMiddleware, async (req, res) => {
    try {
        const start = getTashkentDate();
        start.setHours(0, 0, 0, 0);
        const end = getTashkentDate();
        end.setHours(23, 59, 59, 999);

        let orders = await Order.find({
            createdAt: { $gte: start, $lte: end },
            status: { $ne: "trash" }
        }).sort({ createdAt: 1 }).lean();

        // VIP process zakazlar uchun hozirgi summa hisoblash
        orders = orders.map(o => {
            if (o.status === "process" && o.type === "vip") {
                const now = new Date();
                const startTime = new Date(o.startTime);
                const diffHours = (now - startTime) / (3600 * 1000);
                let summa = Math.ceil(diffHours * PRICE_PER_HOUR);
                summa = Math.ceil(summa / 1000) * 1000;
                return { ...o, summa, _calculated: true };
            }
            return o;
        });

        const totalSum = orders.reduce((sum, o) => sum + (o.summa || 0), 0);

        return res.json({
            ok: true,
            date: start.toLocaleDateString(),
            count: orders.length,
            totalSum,
            orders
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// kunlik hisobotni Telegramga yuborish (POST)
api.post("/daily-report", authMiddleware, async (req, res) => {
    try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);

        let orders = await Order.find({
            createdAt: { $gte: start, $lte: end },
            status: { $ne: "trash" }
        }).sort({ createdAt: 1 }).lean();

        // VIP process zakazlar uchun hozirgi summa hisoblash
        orders = orders.map(o => {
            if (o.status === "process" && o.type === "vip") {
                const now = new Date();
                const startTime = new Date(o.startTime);
                const diffHours = (now - startTime) / (3600 * 1000);
                let summa = Math.ceil(diffHours * PRICE_PER_HOUR);
                summa = Math.ceil(summa / 1000) * 1000;
                return { ...o, summa, _calculated: true };
            }
            return o;
        });

        const totalSum = orders.reduce((sum, o) => sum + (o.summa || 0), 0);

        // Xabarlarni bo‘lib-bo‘lib yuborish
        const lines = orders.map((o, i) =>
            `<u><b>${i + 1}) ${o.ps} | </b></u>${o.type}${o._calculated ? " (VIP ochiq)" : ""}|💵 ${o.summa.toLocaleString()} so'm \n Boshlangan: ${formatTashkent(o.startTime)} \n ${o.endTime ? `Yakun: ${formatTashkent(o.endTime)}` : "-"} \n`
        );
        if (orders.length > 0) {
            await sendToTelegramChunks(
                lines,
                `📊 Kunlik Hisobot\n📅${start.toLocaleDateString()}\n 💵 Daromad: ${totalSum.toLocaleString()} so'm \n`
            );
        } else {
            await sendToTelegram("📊 Kunlik hisobot: Hech qanday zakaz yo‘q edi.");
        }

        return res.json({ ok: true, count: orders.length, totalSum });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// trash list (super)
api.get("/trash", authMiddleware, superMiddleware, async (req, res) => {
    try {
        const trash = await Order.find({ status: "trash" }).sort({ deletedAt: -1 }).lean();
        return res.json(trash);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Arxiv schema
const archiveSchema = new mongoose.Schema({
    date: { type: String, required: true }, // "YYYY-MM-DD"
    orders: { type: Array, default: [] },
    totalSum: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

const Archive = mongoose.model("Archive", archiveSchema);

// mount api
app.use("/api", api);

// serve login
app.get("/", (req, res) => {
    res.sendFile(path.join(__dirname, "public", "login.html"));
});

// 404
app.use((req, res, next) => {
    if (req.path.startsWith("/api/")) return res.status(404).json({ ok: false, error: "API route not found" });
    return res.status(404).send("Not found");
});

// error handler
app.use((err, req, res, next) => {
    console.error("Unhandled error:", err);
    res.status(500).json({ ok: false, error: "Server error" });
});

// start server
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

setInterval(async () => {
    try {
        const now = new Date();
        const expired = await Order.find({
            status: "process",
            type: "cash",
            endTime: { $lte: now }
        });
        for (const o of expired) {
            o.status = "completed";
            o.completedAt = now;
            await o.save();
            sendToTelegram(`<b>✅ Zakaz avtomatik yakunlandi</b>\nPS: ${o.ps}\n<u>Turi: ${o.type.toUpperCase()}</u> \nSumma: <b>${o.summa} </b> so'm\nBoshlangan: ${formatTashkent(o.startTime)}\n${o.endTime ? `Yakun: ${formatTashkent(o.endTime)}\n` : "-"}`).catch(console.error);
        }
        if (expired.length) console.log(`Auto-completed ${expired.length} orders`);
    } catch (e) {
        console.error("Auto-complete error:", e);
    }
}, 60 * 1000); // har 1 daqiqada

// DB tozalash (zakazlar va arxiv ham tozalanadi, backup Telegramga yuboriladi)
api.post("/clear", authMiddleware, superMiddleware, async (req, res) => {
    try {
        // 1. Zakazlar backup
        const orders = await Order.find();
        const totalSum = orders.reduce((sum, o) => sum + (o.summa || 0), 0);
        const orderLines = orders.map((o, i) =>
            `${i + 1}) PS: ${o.ps} | ${o.type.toUpperCase()} | ${o.summa?.toLocaleString()} so'm | ${formatTashkent(o.startTime)}`
        );
        if (orders.length > 0) {
            await sendToTelegramChunks(orderLines, `🧹 DB Tozalash Backup\nJami: ${orders.length} ta zakaz, ${totalSum.toLocaleString()} so'm\n`);
        } else {
            await sendToTelegram("🧹 DB tozalandi. Hech qanday zakaz yo‘q edi.");
        }

        // 2. Arxiv backup
        const archives = await Archive.find();
        const archiveLines = [];
        archives.forEach(a => {
            archiveLines.push(`📦 ${a.date} — ${a.orders.length} ta zakaz, ${a.totalSum.toLocaleString()} so'm`);
            a.orders.forEach((o, i) => {
                archiveLines.push(
                    `  ${i + 1}) PS: ${o.ps} | ${o.type} | ${o.summa?.toLocaleString()} so'm | ${o.startTime ? new Date(o.startTime).toLocaleString() : "-"}`
                );
            });
        });
        if (archives.length > 0) {
            await sendToTelegramChunks(archiveLines, "📦 Arxiv Backup");
        } else {
            await sendToTelegram("📦 Arxiv ham bo‘sh edi.");
        }

        // 3. Barcha zakazlarni va arxivni o‘chirish
        const orderResult = await Order.deleteMany({});
        const archiveResult = await Archive.deleteMany({});

        return res.json({
            ok: true,
            totalCount: orderResult.deletedCount,
            totalSum,
            archiveCount: archiveResult.deletedCount
        });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Kunlik hisobni boshlash (stats-ni 0 ga tenglash, backup Telegramga yuboriladi)
api.post("/daily-reset", authMiddleware, superMiddleware, async (req, res) => {
    try {
        // 1. Process va completed zakazlarni topamiz
        const orders = await Order.find({ status: { $in: ["process", "completed"] } });
        const totalSum = orders.reduce((sum, o) => sum + (o.summa || 0), 0);

        // 2. Telegram backup (4096 belgidan oshsa bo‘lib yuboriladi)
        let text = `<b>🔄 Kunlik Hisobni Boshlash Backup</b>\nJami: ${orders.length} ta zakaz, ${totalSum.toLocaleString()} so'm\n\n`;
        const lines = orders.map((o, i) =>
            `${i + 1}) PS: ${o.ps} | ${o.type.toUpperCase()} | ${o.summa.toLocaleString()} so'm | ${o.startTime ? new Date(o.startTime).toLocaleString() : "-"}`
        );
        let chunk = text;
        for (const line of lines) {
            if ((chunk + line + "\n").length > 4000) {
                await sendToTelegram(chunk);
                chunk = "";
            }
            chunk += line + "\n";
        }
        if (chunk.trim()) {
            await sendToTelegram(chunk);
        }
        if (!orders.length) {
            await sendToTelegram("🔄 Kunlik hisob boshlandi. Hech qanday zakaz yo‘q edi.");
        }

        // 3. Barcha process va completed zakazlarni trash holatiga o‘tkazamiz
        const updated = await Order.updateMany(
            { status: { $in: ["process", "completed"] } },
            { $set: { status: "trash", deletedAt: new Date() } }
        );

        return res.json({ ok: true, updated: updated.modifiedCount });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Kunlik hisobni arxivga o‘tkazish (super admin)
api.post("/archive-day", authMiddleware, superMiddleware, async (req, res) => {
    try {
        // 1. Bugungi barcha process/completed zakazlarni topamiz
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const end = new Date();
        end.setHours(23, 59, 59, 999);

        const orders = await Order.find({
            createdAt: { $gte: start, $lte: end },
            status: { $in: ["process", "completed"] }
        }).lean();

        if (!orders.length) {
            return res.json({ ok: false, error: "Arxivga o‘tkaziladigan zakaz yo‘q" });
        }

        const totalSum = orders.reduce((sum, o) => sum + (o.summa || 0), 0);

        // 2. Arxivga yozamiz
        const dateStr = start.toISOString().slice(0, 10); // YYYY-MM-DD
        await Archive.create({
            date: dateStr,
            orders,
            totalSum
        });

        // 3. Zakazlarni trash holatiga o‘tkazamiz
        await Order.updateMany(
            { _id: { $in: orders.map(o => o._id) } },
            { $set: { status: "trash", deletedAt: new Date() } }
        );

        return res.json({ ok: true, archived: orders.length, totalSum });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

// Arxiv ro‘yxati
api.get("/archive", authMiddleware, superMiddleware, async (req, res) => {
    try {
        const list = await Archive.find().sort({ date: -1 }).lean();
        return res.json({ ok: true, archive: list });
    } catch (e) {
        console.error(e);
        return res.status(500).json({ ok: false, error: e.message });
    }
});

function getTashkentDate() {
    return new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Tashkent" }));
}

// Misol:
const vaqt = getTashkentDate();
console.log("Toshkent vaqti:", vaqt);

function formatTashkent(dt, withTime = true) {
    if (!dt) return "-";
    const d = new Date(dt);
    return withTime
        ? d.toLocaleString("uz-UZ", { timeZone: "Asia/Tashkent" })
        : d.toLocaleDateString("uz-UZ", { timeZone: "Asia/Tashkent" });
}
