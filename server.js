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
    startTime: { type: Date, default: Date.now },
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

        const text = `<b>🎮 Yangi Zakaz</b>\nPS: ${o.ps}\nTuri: ${o.type.toUpperCase()}\nBoshlangan: ${o.startTime.toLocaleString()}\n${o.endTime ? `Yakun: ${o.endTime.toLocaleString()}\n` : ""}Summa: ${o.summa.toLocaleString()} so'm\nID: ${o.orderId}`;
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

        if (o.type === "vip") {
            const start = new Date(o.startTime);
            const end = new Date();
            const diffHours = (end - start) / (3600 * 1000);
            // Yangi: 1000 ga yaxlitlash
            let summa = Math.ceil(diffHours * PRICE_PER_HOUR);
            summa = Math.ceil(summa / 1000) * 1000;
            o.summa = summa;
            o.endTime = end;
        } else {
            if (!o.endTime) {
                const hours = o.summa / PRICE_PER_HOUR;
                o.endTime = new Date(new Date(o.startTime).getTime() + Math.floor(hours * 3600 * 1000));
            }
        }
        o.status = "completed";
        o.completedAt = new Date();
        await o.save();

        const text = `<b>✅ Zakaz yakunlandi</b>\nPS: ${o.ps}\nTuri: ${o.type.toUpperCase()}\nBoshlangan: ${o.startTime.toLocaleString()}\nYakun: ${o.endTime ? o.endTime.toLocaleString() : "-"}\nSumma: ${o.summa.toLocaleString()} so'm`;
        sendToTelegram(text).catch(console.error);

        return res.json({ ok: true, order: o });
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

        let text = `<b>📊 Kunlik Hisobot</b> \n 📅${start.toLocaleDateString()}:\n \n`;
        orders.forEach((o, i) => {
            text += `<u><b>${i + 1}) ${o.ps} | </b></u> ${o.type}${o._calculated ? " (VIP ochiq)" : ""}| ${o.summa.toLocaleString()} so'm | ${o.startTime ? new Date(o.startTime).toLocaleTimeString() : "-"} - ${o.endTime ? new Date(o.endTime).toLocaleTimeString() : "-"}\n\n`;
        });
        text += `\n<b>Jami:</b> ${orders.length} ta zakaz, ${totalSum.toLocaleString()} so'm`;

        await sendToTelegram(text);

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
            sendToTelegram(`<b>✅ Zakaz avtomatik yakunlandi</b>\nPS: ${o.ps}\nSumma: ${o.summa} so'm\nID: ${o.orderId}`).catch(console.error);
        }
        if (expired.length) console.log(`Auto-completed ${expired.length} orders`);
    } catch (e) {
        console.error("Auto-complete error:", e);
    }
}, 60 * 1000); // har 1 daqiqada
