// ============================================================
// ANGEL — ACROSS SPORTS PERÚ
// Servidor WhatsApp + Panel CRM + Cloudinary Image Upload
// ============================================================

const express = require("express");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cloudinary = require("cloudinary").v2;
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ─── CONFIGURACIÓN ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "acrosssports_verify_token";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || "acrosssports2024";

// Cloudinary
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "dkoyl1oz8",
  api_key: process.env.CLOUDINARY_API_KEY || "268934121615558",
  api_secret: process.env.CLOUDINARY_API_SECRET || "jyErA75bPMYHTP_Kz5XQL5Gdxlk",
});

// Multer — memoria (no disco, para subir directo a Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB máx
  fileFilter: (req, file, cb) => {
    const allowed = ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Solo se permiten imágenes (jpg, png, webp, gif)"));
    }
  },
});

const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ─── PERSISTENCIA EN VOLUME /data ───────────────────────────
const DATA_DIR = "/data";
const CONVERSATIONS_FILE = path.join(DATA_DIR, "conversations.json");

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadConversations() {
  try {
    if (fs.existsSync(CONVERSATIONS_FILE)) {
      const data = fs.readFileSync(CONVERSATIONS_FILE, "utf8");
      return JSON.parse(data);
    }
  } catch (e) {
    console.error("Error cargando conversaciones:", e);
  }
  return {};
}

function saveConversations(conversations) {
  try {
    fs.writeFileSync(CONVERSATIONS_FILE, JSON.stringify(conversations, null, 2));
  } catch (e) {
    console.error("Error guardando conversaciones:", e);
  }
}

let conversations = loadConversations();

// ─── SYSTEM PROMPT DE ANGEL ─────────────────────────────────
const ANGEL_SYSTEM_PROMPT = `Eres Angel, el asistente de ventas virtual de Across Sports Perú. 
Eres experto en productos deportivos: trofeos, medallas, implementos de fútbol, basketball, tenis, natación, voleibol, gimnasia, fitness, yoga y deportes de combate.
Tu objetivo es asesorar al cliente, resolver sus dudas y guiarlos hacia una compra.
Tienes acceso a precios mayoristas competitivos porque trabajamos directamente con Neimport Winner S.A.C.
Responde siempre en español, de forma amigable, profesional y orientada a ventas.
Cuando el cliente esté listo para comprar, coordina los detalles del pedido.
Mantén respuestas concisas (máximo 3-4 líneas por mensaje para WhatsApp).`;

// ─── FUNCIÓN: LLAMAR A CLAUDE ────────────────────────────────
async function callAngel(phoneNumber, userMessage) {
  if (!conversations[phoneNumber]) {
    conversations[phoneNumber] = {
      messages: [],
      lastActivity: Date.now(),
      name: null,
    };
  }

  const conv = conversations[phoneNumber];
  conv.lastActivity = Date.now();

  conv.messages.push({ role: "user", content: userMessage });

  // Limitar historial a últimos 20 mensajes
  if (conv.messages.length > 20) {
    conv.messages = conv.messages.slice(-20);
  }

  const response = await anthropic.messages.create({
    model: "claude-opus-4-5",
    max_tokens: 500,
    system: ANGEL_SYSTEM_PROMPT,
    messages: conv.messages,
  });

  const assistantMessage = response.content[0].text;
  conv.messages.push({ role: "assistant", content: assistantMessage });

  saveConversations(conversations);
  return assistantMessage;
}

// ─── FUNCIÓN: ENVIAR MENSAJE DE TEXTO POR WHATSAPP ──────────
async function sendWhatsAppMessage(to, message) {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ─── FUNCIÓN: ENVIAR IMAGEN POR WHATSAPP ────────────────────
async function sendWhatsAppImage(to, imageUrl, caption = "") {
  await axios.post(
    `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to,
      type: "image",
      image: {
        link: imageUrl,
        caption: caption,
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

// ─── WEBHOOK: VERIFICACIÓN ───────────────────────────────────
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("✅ Webhook verificado");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// ─── WEBHOOK: MENSAJES ENTRANTES ─────────────────────────────
app.post("/webhook", async (req, res) => {
  res.sendStatus(200); // Responder rápido a Meta

  try {
    const body = req.body;
    if (!body.object || !body.entry?.[0]?.changes?.[0]?.value) return;

    const value = body.entry[0].changes[0].value;
    if (!value.messages?.[0]) return;

    const msg = value.messages[0];
    const from = msg.from;
    const contactName = value.contacts?.[0]?.profile?.name || "Cliente";

    // Guardar nombre si no lo tenemos
    if (!conversations[from]) {
      conversations[from] = { messages: [], lastActivity: Date.now(), name: contactName };
    } else if (!conversations[from].name) {
      conversations[from].name = contactName;
    }

    let userText = "";

    if (msg.type === "text") {
      userText = msg.text.body;
    } else if (msg.type === "image") {
      // Guardar referencia de imagen recibida en historial
      const mediaId = msg.image?.id || "";
      const imageCaption = msg.image?.caption || "";
      userText = imageCaption
        ? `[El cliente envió una imagen con el mensaje: "${imageCaption}"]`
        : "[El cliente envió una imagen]";

      // Registrar en conversación
      if (!conversations[from].receivedImages) {
        conversations[from].receivedImages = [];
      }
      conversations[from].receivedImages.push({
        mediaId,
        caption: imageCaption,
        timestamp: Date.now(),
      });
      saveConversations(conversations);
    } else if (msg.type === "audio") {
      userText = "[El cliente envió un audio]";
    } else {
      userText = `[El cliente envió un mensaje de tipo: ${msg.type}]`;
    }

    console.log(`📩 Mensaje de ${contactName} (${from}): ${userText}`);

    const angelResponse = await callAngel(from, userText);
    await sendWhatsAppMessage(from, angelResponse);

    console.log(`📤 Angel respondió a ${from}`);
  } catch (error) {
    console.error("❌ Error procesando mensaje:", error.message);
  }
});

// ─── API: SUBIR IMAGEN A CLOUDINARY Y ENVIAR POR WHATSAPP ───
// POST /api/send-image
// Form-data: file (imagen), phone (número destino), caption (opcional)
app.post("/api/send-image", upload.single("file"), async (req, res) => {
  const panelAuth = req.headers["x-panel-password"] || req.body?.panelPassword;
  if (panelAuth !== PANEL_PASSWORD) {
    return res.status(401).json({ error: "No autorizado" });
  }

  if (!req.file) {
    return res.status(400).json({ error: "No se recibió ningún archivo" });
  }

  const { phone, caption } = req.body;

  if (!phone) {
    return res.status(400).json({ error: "El número de teléfono es requerido" });
  }

  try {
    // 1. Subir imagen a Cloudinary
    const uploadResult = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: "across-sports",
          resource_type: "image",
          transformation: [{ quality: "auto", fetch_format: "auto" }],
        },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );
      stream.end(req.file.buffer);
    });

    const imageUrl = uploadResult.secure_url;
    console.log(`☁️ Imagen subida a Cloudinary: ${imageUrl}`);

    // 2. Enviar imagen por WhatsApp
    await sendWhatsAppImage(phone, imageUrl, caption || "");

    // 3. Registrar en historial de conversación
    if (!conversations[phone]) {
      conversations[phone] = { messages: [], lastActivity: Date.now(), name: null };
    }
    if (!conversations[phone].sentImages) {
      conversations[phone].sentImages = [];
    }
    conversations[phone].sentImages.push({
      url: imageUrl,
      caption: caption || "",
      timestamp: Date.now(),
      sentByPanel: true,
    });
    conversations[phone].lastActivity = Date.now();
    saveConversations(conversations);

    res.json({
      success: true,
      imageUrl,
      message: `Imagen enviada a ${phone}`,
    });

    console.log(`🖼️ Imagen enviada a ${phone} desde el panel`);
  } catch (error) {
    console.error("❌ Error enviando imagen:", error.message);
    res.status(500).json({ error: "Error al enviar imagen: " + error.message });
  }
});

// ─── API: ENVIAR MENSAJE DESDE PANEL ────────────────────────
app.post("/api/send-message", async (req, res) => {
  const { phone, message, password } = req.body;

  if (password !== PANEL_PASSWORD) {
    return res.status(401).json({ error: "Contraseña incorrecta" });
  }

  try {
    await sendWhatsAppMessage(phone, message);

    // Registrar en historial
    if (!conversations[phone]) {
      conversations[phone] = { messages: [], lastActivity: Date.now(), name: null };
    }
    conversations[phone].messages.push({
      role: "assistant",
      content: `[PANEL] ${message}`,
    });
    conversations[phone].lastActivity = Date.now();
    saveConversations(conversations);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ─── API: OBTENER CONVERSACIONES ─────────────────────────────
app.get("/api/conversations", (req, res) => {
  const password = req.query.password;
  if (password !== PANEL_PASSWORD) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const summary = Object.entries(conversations).map(([phone, data]) => ({
    phone,
    name: data.name || "Desconocido",
    lastActivity: data.lastActivity,
    messageCount: data.messages?.length || 0,
    lastMessage: data.messages?.[data.messages.length - 1]?.content?.substring(0, 80) || "",
    sentImages: data.sentImages?.length || 0,
    receivedImages: data.receivedImages?.length || 0,
  }));

  summary.sort((a, b) => b.lastActivity - a.lastActivity);
  res.json(summary);
});

// ─── API: OBTENER HISTORIAL DE UNA CONVERSACIÓN ──────────────
app.get("/api/conversation/:phone", (req, res) => {
  const password = req.query.password;
  if (password !== PANEL_PASSWORD) {
    return res.status(401).json({ error: "No autorizado" });
  }

  const phone = req.params.phone;
  const conv = conversations[phone];

  if (!conv) {
    return res.json({ messages: [], sentImages: [], receivedImages: [] });
  }

  res.json({
    name: conv.name,
    messages: conv.messages || [],
    sentImages: conv.sentImages || [],
    receivedImages: conv.receivedImages || [],
    lastActivity: conv.lastActivity,
  });
});

// ─── PANEL CRM ───────────────────────────────────────────────
app.get("/panel", (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Angel CRM — Across Sports Perú</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: 'Segoe UI', sans-serif; background: #0a0a0a; color: #e0e0e0; }
  #login-screen { display: flex; align-items: center; justify-content: center; height: 100vh; }
  .login-box { background: #1a1a1a; border: 1px solid #cc0000; padding: 40px; border-radius: 12px; text-align: center; width: 320px; }
  .login-box h2 { color: #cc0000; margin-bottom: 20px; font-size: 1.4rem; }
  .login-box input { width: 100%; padding: 10px; background: #2a2a2a; border: 1px solid #444; border-radius: 6px; color: white; margin-bottom: 12px; }
  .btn { background: #cc0000; color: white; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: bold; transition: background 0.2s; }
  .btn:hover { background: #ff0000; }
  .btn-secondary { background: #333; }
  .btn-secondary:hover { background: #444; }
  #app { display: none; height: 100vh; flex-direction: column; }
  .header { background: #1a1a1a; border-bottom: 2px solid #cc0000; padding: 12px 20px; display: flex; justify-content: space-between; align-items: center; }
  .header h1 { color: #cc0000; font-size: 1.2rem; }
  .main { display: flex; flex: 1; overflow: hidden; }
  .sidebar { width: 300px; background: #111; border-right: 1px solid #2a2a2a; overflow-y: auto; }
  .sidebar h3 { padding: 12px 16px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; font-size: 0.85rem; color: #888; text-transform: uppercase; letter-spacing: 1px; }
  .contact-item { padding: 12px 16px; border-bottom: 1px solid #1a1a1a; cursor: pointer; transition: background 0.15s; }
  .contact-item:hover { background: #1a1a1a; }
  .contact-item.active { background: #1a0000; border-left: 3px solid #cc0000; }
  .contact-name { font-weight: bold; font-size: 0.9rem; }
  .contact-phone { font-size: 0.75rem; color: #888; }
  .contact-preview { font-size: 0.75rem; color: #666; margin-top: 4px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .contact-time { font-size: 0.7rem; color: #555; }
  .chat-area { flex: 1; display: flex; flex-direction: column; }
  .chat-header { padding: 12px 20px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; display: flex; justify-content: space-between; align-items: center; }
  .messages { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 8px; }
  .message { max-width: 70%; padding: 10px 14px; border-radius: 12px; font-size: 0.88rem; line-height: 1.4; }
  .message.user { background: #1a3a1a; align-self: flex-start; border-radius: 12px 12px 12px 2px; }
  .message.assistant { background: #1a1a3a; align-self: flex-end; border-radius: 12px 12px 2px 12px; }
  .message.panel { background: #2a1a1a; align-self: flex-end; border: 1px solid #cc0000; border-radius: 12px 12px 2px 12px; }
  .message-img { max-width: 200px; border-radius: 8px; margin-top: 4px; }
  .send-area { padding: 12px 16px; background: #1a1a1a; border-top: 1px solid #2a2a2a; display: flex; flex-direction: column; gap: 8px; }
  .send-row { display: flex; gap: 8px; align-items: flex-end; }
  .send-area textarea { flex: 1; background: #2a2a2a; border: 1px solid #444; border-radius: 8px; padding: 10px; color: white; resize: none; font-family: inherit; font-size: 0.9rem; min-height: 44px; max-height: 120px; }
  .image-upload-area { background: #2a2a2a; border: 1px dashed #444; border-radius: 8px; padding: 10px 14px; cursor: pointer; transition: border-color 0.2s; }
  .image-upload-area:hover { border-color: #cc0000; }
  .image-upload-area label { cursor: pointer; display: flex; align-items: center; gap: 8px; font-size: 0.85rem; color: #888; }
  .image-upload-area input[type=file] { display: none; }
  #image-preview-container { display: none; align-items: center; gap: 10px; background: #1a1a1a; padding: 8px; border-radius: 8px; }
  #image-preview { width: 60px; height: 60px; object-fit: cover; border-radius: 6px; }
  .caption-input { flex: 1; background: #2a2a2a; border: 1px solid #444; border-radius: 6px; padding: 6px 10px; color: white; font-size: 0.85rem; }
  .badge { background: #cc0000; color: white; font-size: 0.7rem; padding: 2px 6px; border-radius: 10px; margin-left: 6px; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; background: #2ecc71; margin-right: 6px; animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .empty-state { flex: 1; display: flex; align-items: center; justify-content: center; color: #444; font-size: 1rem; }
  #upload-status { font-size: 0.8rem; color: #888; padding: 4px 0; display: none; }
  .img-tag { background: #2a1500; color: #ff9900; font-size: 0.7rem; padding: 2px 6px; border-radius: 4px; margin-left: 4px; }
</style>
</head>
<body>

<div id="login-screen">
  <div class="login-box">
    <h2>🏅 Angel CRM</h2>
    <p style="color:#888;margin-bottom:20px;font-size:0.85rem">Across Sports Perú</p>
    <input type="password" id="pwd-input" placeholder="Contraseña del panel" onkeydown="if(event.key==='Enter')login()">
    <button class="btn" style="width:100%" onclick="login()">Ingresar</button>
    <p id="login-error" style="color:#cc0000;font-size:0.8rem;margin-top:10px;display:none">Contraseña incorrecta</p>
  </div>
</div>

<div id="app">
  <div class="header">
    <h1>🏅 Angel CRM — Across Sports Perú</h1>
    <div style="display:flex;align-items:center;gap:16px">
      <span style="font-size:0.8rem;color:#888"><span class="status-dot"></span>Servidor activo</span>
      <span id="conv-count" style="font-size:0.8rem;color:#888"></span>
      <button class="btn btn-secondary" onclick="logout()" style="padding:6px 12px;font-size:0.8rem">Salir</button>
    </div>
  </div>
  <div class="main">
    <div class="sidebar">
      <h3>Conversaciones</h3>
      <div id="contacts-list"></div>
    </div>
    <div class="chat-area">
      <div id="chat-empty" class="empty-state">Selecciona una conversación</div>
      <div id="chat-content" style="display:none;flex:1;flex-direction:column;overflow:hidden">
        <div class="chat-header">
          <div>
            <strong id="chat-name"></strong>
            <div id="chat-phone" style="font-size:0.8rem;color:#888"></div>
          </div>
          <div id="chat-image-count" style="font-size:0.8rem;color:#888"></div>
        </div>
        <div class="messages" id="messages-container"></div>
        <div class="send-area">
          <!-- ÁREA DE IMAGEN -->
          <div class="image-upload-area">
            <label>
              📷 <span>Adjuntar imagen para enviar</span>
              <input type="file" id="image-file" accept="image/*" onchange="previewImage(this)">
            </label>
          </div>
          <div id="image-preview-container">
            <img id="image-preview" src="" alt="preview">
            <input class="caption-input" id="image-caption" placeholder="Agregar texto (opcional)">
            <button class="btn" onclick="sendImage()" style="padding:8px 14px">Enviar 🖼️</button>
            <button class="btn btn-secondary" onclick="clearImage()" style="padding:8px 10px">✕</button>
          </div>
          <div id="upload-status"></div>
          <!-- MENSAJE DE TEXTO -->
          <div class="send-row">
            <textarea id="msg-input" placeholder="Escribe un mensaje como Angel..." rows="2" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage()}"></textarea>
            <button class="btn" onclick="sendMessage()">Enviar</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
let password = '';
let selectedPhone = null;
let refreshInterval = null;

function login() {
  const pwd = document.getElementById('pwd-input').value;
  fetch('/api/conversations?password=' + encodeURIComponent(pwd))
    .then(r => r.json())
    .then(data => {
      if (data.error) {
        document.getElementById('login-error').style.display = 'block';
      } else {
        password = pwd;
        document.getElementById('login-screen').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        loadConversations();
        refreshInterval = setInterval(loadConversations, 15000);
      }
    });
}

function logout() {
  clearInterval(refreshInterval);
  password = '';
  selectedPhone = null;
  document.getElementById('login-screen').style.display = 'flex';
  document.getElementById('app').style.display = 'none';
  document.getElementById('pwd-input').value = '';
}

function loadConversations() {
  fetch('/api/conversations?password=' + encodeURIComponent(password))
    .then(r => r.json())
    .then(data => {
      if (data.error) return;
      document.getElementById('conv-count').textContent = data.length + ' conversaciones';
      const list = document.getElementById('contacts-list');
      list.innerHTML = '';
      data.forEach(conv => {
        const div = document.createElement('div');
        div.className = 'contact-item' + (conv.phone === selectedPhone ? ' active' : '');
        div.onclick = () => openConversation(conv.phone, conv.name);
        const t = new Date(conv.lastActivity);
        div.innerHTML = \`
          <div class="contact-name">\${conv.name} \${conv.sentImages > 0 ? '<span class="img-tag">🖼️ ' + conv.sentImages + '</span>' : ''}</div>
          <div class="contact-phone">\${conv.phone}</div>
          <div class="contact-preview">\${conv.lastMessage}</div>
          <div class="contact-time">\${t.toLocaleString('es-PE')}</div>
        \`;
        list.appendChild(div);
      });
      // Refrescar chat activo
      if (selectedPhone) loadChat(selectedPhone);
    });
}

function openConversation(phone, name) {
  selectedPhone = phone;
  document.getElementById('chat-empty').style.display = 'none';
  document.getElementById('chat-content').style.display = 'flex';
  document.getElementById('chat-name').textContent = name || 'Desconocido';
  document.getElementById('chat-phone').textContent = phone;
  loadChat(phone);
  // Resaltar contacto activo
  document.querySelectorAll('.contact-item').forEach(el => el.classList.remove('active'));
  event.currentTarget.classList.add('active');
}

function loadChat(phone) {
  fetch(\`/api/conversation/\${phone}?password=\${encodeURIComponent(password)}\`)
    .then(r => r.json())
    .then(data => {
      const container = document.getElementById('messages-container');
      const scrollBottom = container.scrollHeight - container.scrollTop === container.clientHeight;
      container.innerHTML = '';

      (data.messages || []).forEach(msg => {
        const div = document.createElement('div');
        const isPanel = msg.content.startsWith('[PANEL]');
        div.className = 'message ' + (msg.role === 'user' ? 'user' : isPanel ? 'panel' : 'assistant');
        div.textContent = isPanel ? msg.content.replace('[PANEL] ', '') : msg.content;
        container.appendChild(div);
      });

      // Mostrar imágenes enviadas
      (data.sentImages || []).forEach(img => {
        const wrap = document.createElement('div');
        wrap.style.alignSelf = 'flex-end';
        wrap.innerHTML = \`
          <div style="text-align:right;font-size:0.7rem;color:#888;margin-bottom:2px">🖼️ Imagen enviada desde panel</div>
          <img src="\${img.url}" class="message-img" style="display:block;margin-left:auto" alt="imagen">
          \${img.caption ? '<div style="font-size:0.75rem;color:#aaa;text-align:right;margin-top:2px">' + img.caption + '</div>' : ''}
        \`;
        container.appendChild(wrap);
      });

      // Indicador de imágenes
      const imgCount = (data.sentImages?.length || 0) + (data.receivedImages?.length || 0);
      document.getElementById('chat-image-count').textContent = imgCount > 0 ? \`\${imgCount} imágenes\` : '';

      container.scrollTop = container.scrollHeight;
    });
}

function sendMessage() {
  const msg = document.getElementById('msg-input').value.trim();
  if (!msg || !selectedPhone) return;

  fetch('/api/send-message', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ phone: selectedPhone, message: msg, password })
  }).then(r => r.json()).then(data => {
    if (data.success) {
      document.getElementById('msg-input').value = '';
      setTimeout(() => loadChat(selectedPhone), 500);
    } else {
      alert('Error: ' + data.error);
    }
  });
}

function previewImage(input) {
  if (!input.files?.[0]) return;
  const file = input.files[0];
  const reader = new FileReader();
  reader.onload = e => {
    document.getElementById('image-preview').src = e.target.result;
    document.getElementById('image-preview-container').style.display = 'flex';
  };
  reader.readAsDataURL(file);
}

function clearImage() {
  document.getElementById('image-file').value = '';
  document.getElementById('image-preview').src = '';
  document.getElementById('image-preview-container').style.display = 'none';
  document.getElementById('image-caption').value = '';
  document.getElementById('upload-status').style.display = 'none';
}

async function sendImage() {
  if (!selectedPhone) return alert('Selecciona una conversación primero');
  const fileInput = document.getElementById('image-file');
  if (!fileInput.files?.[0]) return alert('Selecciona una imagen');

  const caption = document.getElementById('image-caption').value.trim();
  const status = document.getElementById('upload-status');
  status.style.display = 'block';
  status.textContent = '⏳ Subiendo imagen a Cloudinary...';

  const formData = new FormData();
  formData.append('file', fileInput.files[0]);
  formData.append('phone', selectedPhone);
  formData.append('caption', caption);

  try {
    const res = await fetch('/api/send-image', {
      method: 'POST',
      headers: { 'x-panel-password': password },
      body: formData
    });
    const data = await res.json();

    if (data.success) {
      status.textContent = '✅ Imagen enviada correctamente';
      status.style.color = '#2ecc71';
      clearImage();
      setTimeout(() => {
        status.style.display = 'none';
        status.style.color = '#888';
        loadChat(selectedPhone);
      }, 2000);
    } else {
      status.textContent = '❌ Error: ' + data.error;
      status.style.color = '#cc0000';
    }
  } catch (err) {
    status.textContent = '❌ Error de conexión';
    status.style.color = '#cc0000';
  }
}
</script>
</body>
</html>`);
});

// ─── HEALTH CHECK ────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({
    status: "Angel online 🏅",
    project: "Across Sports Perú",
    conversations: Object.keys(conversations).length,
    uptime: Math.floor(process.uptime()) + "s",
  });
});

// ─── INICIO ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ Angel corriendo en puerto ${PORT}`);
  console.log(`📊 Panel: https://angel-across-sports-production.up.railway.app/panel`);
  console.log(`💬 Conversaciones cargadas: ${Object.keys(conversations).length}`);
});
