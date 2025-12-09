// server.js (ESM)

import express from "express";
import mongoose from "mongoose";
import bodyParser from "body-parser";
import multer from "multer";
import cors from "cors";
import path from "path";
import fs from "fs";
import http from "http";
import { Server as SocketIOServer } from "socket.io";
import { fileURLToPath } from "url";

// ==========================================
// ESM __dirname Setup
// ==========================================
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ==========================================
// Ensure uploads folder exists
// ==========================================
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ==========================================
// Setup Express App
// ==========================================
const app = express();

// CORS – for deployment you can relax to "*" or configure FRONTEND_ORIGIN
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE"],
  })
);

app.use(bodyParser.json());

// Serve uploaded images
app.use("/uploads", express.static(path.join(__dirname, "uploads")));

// Serve frontend static files from /public
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// MongoDB Connect
// ==========================================
const MONGO_URI =
  process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/oceanid_app";

mongoose
  .connect(MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected:", MONGO_URI))
  .catch((err) => console.error("❌ Mongo Error:", err));

// ==========================================
// Multer Image Upload Setup
// ==========================================
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename: function (req, file, cb) {
    cb(null, Date.now() + path.extname(file.originalname)); // e.g. 1711111111111.png
  },
});

const upload = multer({ storage });

// ==========================================
// SCHEMAS & MODELS
// ==========================================

// 1) USER
const userSchema = new mongoose.Schema(
  {
    name: { type: String, required: true }, // user-name
    mobile: { type: String, required: true, unique: true },
    password: { type: String, required: true }, // (plain for demo)
    photo: { type: String }, // /uploads/xxx.png
  },
  { timestamps: true }
);
const User = mongoose.model("User", userSchema);

// 2) PHOTO: approved reports for home feed
const photoSchema = new mongoose.Schema(
  {
    user_number: { type: String, required: true },
    user_name: { type: String },
    img: { type: String, required: true }, // /uploads/filename.png
    cause_of_action: { type: String, required: true },
    description: { type: String },
    location: { type: String },
    date: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
const PhotoReport = mongoose.model("PhotoReport", photoSchema);

// 3) AUTH RECORD: pending reports
const authSchema = new mongoose.Schema(
  {
    user_number: { type: String, required: true },
    user_name: { type: String },
    photo: { type: String, required: true }, // /uploads/xxx.png
    cause_of_action: { type: String, required: true },
    description: { type: String },
    location: { type: String },
    date: { type: Date, default: Date.now },
    status: { type: String, default: "pending" }, // pending | approved | rejected
  },
  { timestamps: true }
);
const AuthRecord = mongoose.model("AuthRecord", authSchema);

// 4) CLIMATE ALERTS
const climateSchema = new mongoose.Schema(
  {
    cause_of_action: { type: String, required: true },
    date: { type: Date, default: Date.now },
    description: { type: String },
    location: { type: String, required: true },
  },
  { timestamps: true }
);

// Auto-delete climate alerts 30 days after createdAt
climateSchema.index(
  { createdAt: 1 },
  { expireAfterSeconds: 30 * 24 * 60 * 60 } // 30 days
);
const ClimateAlert = mongoose.model("ClimateAlert", climateSchema);

// 5) MESSAGE: SMS chat messages
const messageSchema = new mongoose.Schema(
  {
    senderMobile: { type: String, required: true },
    receiverMobile: { type: String, required: true },
    content: { type: String, required: true },
    readAt: { type: Date, default: null },
  },
  { timestamps: true }
);
const Message = mongoose.model("Message", messageSchema);

// 6) CALL LOGS
const callLogSchema = new mongoose.Schema(
  {
    callerMobile: { type: String, required: true },
    receiverMobile: { type: String, required: true },
    direction: {
      type: String,
      enum: ["outgoing", "incoming"],
      required: true,
    }, // direction from perspective of callerMobile
    status: {
      type: String,
      enum: ["missed", "completed", "rejected"],
      default: "completed",
    },
    startedAt: { type: Date, default: Date.now },
    endedAt: { type: Date },
    durationSeconds: { type: Number, default: 0 },
  },
  { timestamps: true }
);
const CallLog = mongoose.model("CallLog", callLogSchema);

// ==========================================
// USER ROUTES
// ==========================================

// Register User
app.post("/users", async (req, res) => {
  try {
    const { name, mobile, password } = req.body;

    if (!name || !mobile || !password) {
      return res.status(400).json({ error: "All fields are required" });
    }

    const user = new User({ name, mobile, password });
    await user.save();

    res.json({ message: "User created successfully", user });
  } catch (err) {
    if (err.code === 11000) {
      return res.status(400).json({ error: "Mobile already exists" });
    }
    res.status(500).json({ error: err.message });
  }
});

// Simple Login (mobile + password)
app.post("/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;

    if (!mobile || !password) {
      return res
        .status(400)
        .json({ error: "Mobile and password are required" });
    }

    const user = await User.findOne({ mobile, password });
    if (!user) {
      return res.status(401).json({ error: "Invalid mobile or password" });
    }

    res.json({ message: "Login successful", user });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get all users
app.get("/users", async (req, res) => {
  try {
    const users = await User.find().sort({ createdAt: -1 });
    res.json({ users });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update profile: name + optional photo
app.put("/users/:id/profile", upload.single("photo"), async (req, res) => {
  try {
    const { name } = req.body;
    const updateData = {};

    if (name) updateData.name = name;
    if (req.file) {
      updateData.photo = "/uploads/" + req.file.filename;
    }

    const user = await User.findByIdAndUpdate(req.params.id, updateData, {
      new: true,
    });

    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({ message: "Profile updated", user });
  } catch (err) {
    console.error("Profile update error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// PHOTO ROUTES (for approved feed)
// ==========================================

app.post("/photos", upload.single("img"), async (req, res) => {
  try {
    const {
      user_number,
      user_name,
      cause_of_action,
      description,
      location,
      date,
    } = req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Image file (img) is required" });
    }

    const imgPath = "/uploads/" + req.file.filename;

    const photo = new PhotoReport({
      user_number,
      user_name,
      cause_of_action,
      description,
      location,
      date: date ? new Date(date) : undefined,
      img: imgPath,
    });

    await photo.save();

    res.json({ message: "Photo report created", photo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/photos", async (req, res) => {
  try {
    const photos = await PhotoReport.find().sort({ createdAt: -1 });
    res.json({ photos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/photos/:id", async (req, res) => {
  try {
    const photo = await PhotoReport.findById(req.params.id);
    if (!photo)
      return res.status(404).json({ error: "Photo report not found" });
    res.json({ photo });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// AUTH ROUTES (PENDING REPORTS)
// ==========================================

app.post("/auth", async (req, res) => {
  try {
    const { user_number, cause_of_action, description, location, date } =
      req.body;

    let user_name;
    const user = await User.findOne({ mobile: user_number });
    if (user) user_name = user.name;

    const authRecord = new AuthRecord({
      user_number,
      user_name,
      photo: req.body.photo, // expects path
      cause_of_action,
      description,
      location,
      date: date ? new Date(date) : undefined,
      status: "pending",
    });

    await authRecord.save();
    res.json({ message: "Auth record created", authRecord });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Create auth record WITH image upload
app.post("/auth/upload", upload.single("photo"), async (req, res) => {
  try {
    const { user_number, cause_of_action, description, location, date } =
      req.body;

    if (!req.file) {
      return res.status(400).json({ error: "Image file (photo) is required" });
    }

    const imgPath = "/uploads/" + req.file.filename;

    let user_name;
    const user = await User.findOne({ mobile: user_number });
    if (user) user_name = user.name;

    const authRecord = new AuthRecord({
      user_number,
      user_name,
      photo: imgPath,
      cause_of_action,
      description,
      location,
      date: date ? new Date(date) : undefined,
      status: "pending",
    });

    await authRecord.save();

    res.json({ message: "Auth record created from upload", authRecord });
  } catch (err) {
    console.error("Auth upload error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.get("/auth", async (req, res) => {
  try {
    const records = await AuthRecord.find().sort({ createdAt: -1 });
    res.json({ auth_records: records });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/auth/:id", async (req, res) => {
  try {
    const record = await AuthRecord.findById(req.params.id);
    if (!record)
      return res.status(404).json({ error: "Auth record not found" });
    res.json({ auth_record: record });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Approve auth record -> move to PhotoReport and remove from AuthRecord
app.post("/auth/approve", async (req, res) => {
  try {
    const { auth_id } = req.body;

    const record = await AuthRecord.findById(auth_id);
    if (!record) {
      return res.status(404).json({ error: "Auth record not found" });
    }

    const photo = await PhotoReport.create({
      user_number: record.user_number,
      user_name: record.user_name,
      img: record.photo,
      cause_of_action: record.cause_of_action,
      description: record.description,
      location: record.location,
      date: record.date || new Date(),
    });

    await AuthRecord.deleteOne({ _id: auth_id });

    res.json({
      message:
        "Auth record approved, moved to PhotoReport and removed from AuthRecord",
      photo,
    });
  } catch (err) {
    console.error("Approve error:", err);
    res.status(500).json({ error: err.message });
  }
});

app.post("/auth/reject", async (req, res) => {
  try {
    const { auth_id } = req.body;
    const record = await AuthRecord.findById(auth_id);
    if (!record)
      return res.status(404).json({ error: "Auth record not found" });

    await AuthRecord.deleteOne({ _id: auth_id });
    res.json({ message: "Auth record rejected and deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CLIMATE ROUTES
// ==========================================

app.post("/climate", async (req, res) => {
  try {
    const { cause_of_action, date, description, location } = req.body;

    if (!cause_of_action || !location) {
      return res
        .status(400)
        .json({ error: "cause_of_action and location are required" });
    }

    const alert = new ClimateAlert({
      cause_of_action,
      description,
      location,
      date: date ? new Date(date) : undefined,
    });

    await alert.save();
    res.json({ message: "Climate alert created", alert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/climate", async (req, res) => {
  try {
    const alerts = await ClimateAlert.find().sort({ createdAt: -1 });
    res.json({ alerts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/climate/:id", async (req, res) => {
  try {
    const alert = await ClimateAlert.findById(req.params.id);
    if (!alert)
      return res.status(404).json({ error: "Climate alert not found" });
    res.json({ alert });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// MESSAGE ROUTES (SMS CHAT)
// ==========================================

// POST /messages
app.post("/messages", async (req, res) => {
  try {
    const senderMobile = req.body.senderMobile || req.body.sender_mobile;
    const receiverMobile = req.body.receiverMobile || req.body.receiver_mobile;
    const { content } = req.body;

    if (!senderMobile || !receiverMobile || !content) {
      return res.status(400).json({
        error: "senderMobile, receiverMobile and content are required",
      });
    }

    const msg = new Message({
      senderMobile,
      receiverMobile,
      content,
    });

    await msg.save();
    res.json({ message: "Message stored", data: msg });
  } catch (err) {
    console.error("Message create error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /messages/thread and /messages/conversation
app.get(["/messages/thread", "/messages/conversation"], async (req, res) => {
  try {
    const userMobile = req.query.userMobile || req.query.user1;
    const contactMobile = req.query.contactMobile || req.query.user2;

    if (!userMobile || !contactMobile) {
      return res
        .status(400)
        .json({ error: "userMobile and contactMobile are required" });
    }

    const messages = await Message.find({
      $or: [
        { senderMobile: userMobile, receiverMobile: contactMobile },
        { senderMobile: contactMobile, receiverMobile: userMobile },
      ],
    }).sort({ createdAt: 1 });

    res.json({ messages });
  } catch (err) {
    console.error("Get thread error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /messages/:id (single message)
app.delete("/messages/:id", async (req, res) => {
  try {
    const result = await Message.deleteOne({ _id: req.params.id });
    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "Message not found" });
    }
    res.json({ message: "Message deleted" });
  } catch (err) {
    console.error("Delete message error:", err);
    res.status(500).json({ error: err.message });
  }
});

// DELETE /messages/thread
app.delete("/messages/thread", async (req, res) => {
  try {
    const { userMobile, contactMobile } = req.query;

    if (!userMobile || !contactMobile) {
      return res
        .status(400)
        .json({ error: "userMobile and contactMobile are required" });
    }

    const result = await Message.deleteMany({
      $or: [
        { senderMobile: userMobile, receiverMobile: contactMobile },
        { senderMobile: contactMobile, receiverMobile: userMobile },
      ],
    });

    res.json({
      message: "Messages deleted for this thread",
      deletedCount: result.deletedCount,
    });
  } catch (err) {
    console.error("Delete thread error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /messages/recent/:mobile
app.get("/messages/recent/:mobile", async (req, res) => {
  try {
    const userMobile = req.params.mobile;

    if (!userMobile) {
      return res.status(400).json({ error: "mobile is required" });
    }

    const msgs = await Message.find({
      $or: [{ senderMobile: userMobile }, { receiverMobile: userMobile }],
    }).sort({ createdAt: -1 });

    const latestByContact = new Map();

    for (const m of msgs) {
      const contactMobile =
        m.senderMobile === userMobile ? m.receiverMobile : m.senderMobile;
      if (!latestByContact.has(contactMobile)) {
        latestByContact.set(contactMobile, m);
      }
    }

    const contactMobiles = Array.from(latestByContact.keys());
    if (!contactMobiles.length) {
      return res.json({ threads: [] });
    }

    const users = await User.find({
      mobile: { $in: contactMobiles },
    }).lean();

    const userMap = new Map();
    users.forEach((u) => {
      userMap.set(u.mobile, u);
    });

    const threads = contactMobiles.map((contactMobile) => {
      const lastMessage = latestByContact.get(contactMobile);
      const user = userMap.get(contactMobile);
      return {
        contactMobile,
        contactName: user ? user.name : "Unknown User",
        contactPhoto: user ? user.photo : null,
        lastMessage,
      };
    });

    res.json({ threads });
  } catch (err) {
    console.error("Recent messages error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// CALL LOG ROUTES
// ==========================================

// POST /calls/log  (called from frontend when a call ends)
app.post("/calls/log", async (req, res) => {
  try {
    const {
      callerMobile,
      receiverMobile,
      direction,
      status = "completed",
      startedAt,
      endedAt,
      durationSeconds,
    } = req.body;

    if (!callerMobile || !receiverMobile || !direction) {
      return res.status(400).json({
        error: "callerMobile, receiverMobile and direction are required",
      });
    }

    const log = new CallLog({
      callerMobile,
      receiverMobile,
      direction,
      status,
      startedAt: startedAt ? new Date(startedAt) : new Date(),
      endedAt: endedAt ? new Date(endedAt) : undefined,
      durationSeconds: durationSeconds || 0,
    });

    await log.save();
    res.json({ message: "Call logged", call: log });
  } catch (err) {
    console.error("Call log error:", err);
    res.status(500).json({ error: err.message });
  }
});

// GET /calls/recent/:mobile  (for Recents list in Call page)
app.get("/calls/recent/:mobile", async (req, res) => {
  try {
    const userMobile = req.params.mobile;
    if (!userMobile) {
      return res.status(400).json({ error: "mobile is required" });
    }

    const logs = await CallLog.find({
      $or: [{ callerMobile: userMobile }, { receiverMobile: userMobile }],
    })
      .sort({ startedAt: -1 })
      .limit(50)
      .lean();

    if (!logs.length) return res.json({ recents: [] });

    const latestByContact = new Map();

    for (const log of logs) {
      const contactMobile =
        log.callerMobile === userMobile
          ? log.receiverMobile
          : log.callerMobile;
      if (!latestByContact.has(contactMobile)) {
        latestByContact.set(contactMobile, log);
      }
    }

    const contactMobiles = Array.from(latestByContact.keys());

    const users = await User.find({
      mobile: { $in: contactMobiles },
    }).lean();

    const userMap = new Map();
    users.forEach((u) => userMap.set(u.mobile, u));

    const recents = contactMobiles.map((contactMobile) => {
      const log = latestByContact.get(contactMobile);
      const user = userMap.get(contactMobile);

      const directionFromUser =
        log.callerMobile === userMobile ? "outgoing" : "incoming";

      let statusLabel = "";
      if (log.status === "missed") {
        statusLabel = "Missed";
      } else if (directionFromUser === "outgoing") {
        statusLabel = "Outgoing";
      } else {
        statusLabel = "Incoming";
      }

      return {
        contactMobile,
        contactName: user ? user.name : contactMobile,
        contactPhoto: user ? user.photo : null,
        statusLabel,
        isMissed: log.status === "missed",
        startedAt: log.startedAt,
      };
    });

    res.json({ recents });
  } catch (err) {
    console.error("Recent calls error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================
// ROOT: serve index.html
// ==========================================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ==========================================
// WebRTC Signaling with Socket.IO
// ==========================================
const httpServer = http.createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: {
    origin: "*",
  },
});

const mobileToSocket = new Map();

io.on("connection", (socket) => {
  console.log("🔌 Socket connected", socket.id);

  socket.on("register", (mobile) => {
    if (!mobile) return;
    socket.mobile = mobile;
    mobileToSocket.set(mobile, socket.id);
    console.log(`📱 Registered mobile ${mobile} => socket ${socket.id}`);
  });

  socket.on("disconnect", () => {
    if (socket.mobile) {
      mobileToSocket.delete(socket.mobile);
      console.log(`❌ Mobile ${socket.mobile} disconnected`);
    }
  });

  function forward(eventName, payload, toMobile) {
    const targetId = mobileToSocket.get(toMobile);
    if (!targetId) {
      socket.emit("call:unavailable", { to: toMobile });
      return;
    }
    io.to(targetId).emit(eventName, payload);
  }

  socket.on("call:offer", (payload) => {
    const { to, from, offer } = payload || {};
    if (!to || !from || !offer) return;
    console.log(`📞 Offer from ${from} to ${to}`);
    forward("call:offer", { from, offer }, to);
  });

  socket.on("call:answer", (payload) => {
    const { to, from, answer } = payload || {};
    if (!to || !from || !answer) return;
    console.log(`✅ Answer from ${from} to ${to}`);
    forward("call:answer", { from, answer }, to);
  });

  socket.on("call:ice-candidate", (payload) => {
    const { to, from, candidate } = payload || {};
    if (!to || !from || !candidate) return;
    forward("call:ice-candidate", { from, candidate }, to);
  });

  socket.on("call:hangup", (payload) => {
    const { to, from } = payload || {};
    if (!to || !from) return;
    console.log(`⛔ Hangup from ${from} to ${to}`);
    forward("call:hangup", { from }, to);
  });
});

// ==========================================
// START SERVER
// ==========================================
const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () =>
  console.log(`🚀 Server + Socket.IO running on port ${PORT}`)
);
