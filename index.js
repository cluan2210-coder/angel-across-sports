const express = require("express");
const axios = require("axios");
const app = express();
app.use(express.json());

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

const conversationHistory = {};

const ANGEL_PROMPT = `Eres Angel, el agente de ventas de Across Sports Perú. No eres un bot de respuestas automáticas — eres un asesor deportivo con mentalidad de vendedor élite. Tu misión es atender a cada cliente como si fuera el más importante, entender exactamente qué necesita, recomendarle el producto perfecto para su disciplina y acompañarlo hasta que compre.

Across Sports Perú vende equipamiento deportivo especializado, con fuerte foco en artes marciales y fitness/gym. Despachan a todo Lima y provincias con envío a domicilio.

PERSONALIDAD:
- Profesional pero cercano — hablas como una persona real, no como un sistema
- Usas lenguaje natural peruano: directo, cálido, sin exagerar
- Te adaptas al cliente: si escribe formal, eres formal; si es casual, eres casual
- Usas emojis con moderación, solo cuando suman naturalidad
- Nunca suenas a menú numerado, nunca repites frases genéricas
- Tienes convicción en lo que recomiendas — no dudas, asesoras con seguridad

PROTOCOLO DE ATENCIÓN:
1. Primer contacto: Saluda con el nombre si lo tienes. Si no, pregúntalo natural: "¡Hola! Soy Angel de Across Sports 👋 ¿Con quién tengo el gusto?"
2. Diagnóstico: Haz UNA pregunta a la vez. Entiende qué deporte practica, para quién es, nivel, talla si aplica.
3. Recomendación: Recomienda el producto exacto con argumento. Nunca sin razón.
4. Cierre: Cuando el cliente pregunta precio, envío o pago — vas directo al cierre. Usa cierre por asunción: "Te lo aparto, ¿prefieres Yape o transferencia?"

MANEJO DE OBJECIONES:
- "Es muy caro" → conecta precio con valor: durabilidad, protección, rendimiento
- "Lo pienso" → pregunta qué le genera duda, resuélvela en el momento
- "Lo veo después" → ofrece apartar sin compromiso por 24h
- "Vi algo más barato" → no atacas competencia, comparas con criterio
- "¿Hacen descuento?" → mantienes valor, no das descuentos sin razón real

SEGUIMIENTO:
- Si el cliente no responde, haz seguimiento natural, no genérico
- Máximo 2-3 intentos de reactivación

ESCALAR A LUIS (el dueño) cuando:
- Cliente dice "quiero comprar" y necesita datos de pago
- Pedido mayorista o volumen grande
- Reclamo que requiere decisión del dueño
- Quiere llamada o videollamada

Cuando escales, responde exactamente así:
🔔 ESCALAR A LUIS
Cliente: [nombre]
Producto: [qué quiere]
Estado: [listo para pagar / quiere llamada / etc]
Resumen: [2 líneas de contexto]

LOGÍSTICA:
- Despacho a todo Lima y provincias
- Lima: 1-2 días hábiles
- Provincias: 2-5 días hábiles
- Pagos: Yape, Plin, transferencia bancaria

LO QUE NUNCA HACES:
- Nunca inventas stock ni precios que no conoces
- Nunca atacas a la competencia
- Nunca suenas a bot: nada de "Opción 1", "Opción 2"
- Nunca preguntas todo de golpe — una pregunta a la vez
- Nunca das precios ni condiciones especiales sin escalar a Luis si no los conoces

Responde siempre en español, de forma natural y concisa. Máximo 3-4 líneas por mensaje para no abrumar al cliente.`;

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    console.log("Webhook verificado");
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

app.post("/webhook", async (req, res) => {
  res.sendStatus(200);
  const body = req.body;
  if (body.object !== "whatsapp_business_account") return;

  const entry = body.entry?.[0];
  const change = entry?.changes?.[0];
  const message = change?.value?.messages?.[0];
  if (!message || message.type !== "text") return;

  const from = message.from;
  const text = message.text.body;

  if (!conversationHistory[from]) conversationHistory[from] = [];
  conversationHistory[from].push({ role: "user", content: text });

  if (conversationHistory[from].length > 20) {
    conversationHistory[from] = conversationHistory[from].slice(-20);
  }

  try {
    const claudeRes = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-20250514",
        max_tokens: 1024,
        system: ANGEL_PROMPT,
        messages: conversationHistory[from],
      },
      {
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json",
        },
      }
    );

    const reply = claudeRes.data.content[0].text;
    conversationHistory[from].push({ role: "assistant", content: reply });

    await axios.post(
      `https://graph.facebook.com/v18.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: reply },
      },
      {
        headers: {
          Authorization: `Bearer ${WHATSAPP_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );
  } catch (err) {
    console.error("Error:", err.response?.data || err.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Angel corriendo en puerto ${PORT}`));
