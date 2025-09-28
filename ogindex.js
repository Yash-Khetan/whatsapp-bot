import express from "express";
import twilio from "twilio";
import axios from "axios";
import cron from "node-cron";
import { GoogleGenerativeAI } from "@google/generative-ai";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.urlencoded({ extended: false }));

// Configuration
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// Store user subscriptions (use database in production)
const subscribers = new Set();
const userLocations = new Map();
const userPreferences = new Map(); // phone -> { language: 'en' }
const userActivities = new Map(); // phone -> [{activity, date}]

// Weather API function
async function getWeather(city) {
  try {
    const response = await axios.get(
      `https://api.openweathermap.org/data/2.5/weather?q=${encodeURIComponent(
        city
      )}&appid=${WEATHER_API_KEY}&units=metric`
    );
    const weather = response.data;
    const alerts = [];

    if (weather.main.temp > 35) alerts.push(`🌡️ Heat Alert: ${weather.main.temp}°C`);
    if (weather.main.temp < 5) alerts.push(`❄️ Cold Alert: ${weather.main.temp}°C`);
    if (weather.wind && weather.wind.speed > 10)
      alerts.push(`💨 Wind Alert: ${weather.wind.speed} m/s`);
    if (weather.weather && weather.weather[0]) {
      if (weather.weather[0].main === "Rain")
        alerts.push(`🌧️ Rain Alert: ${weather.weather[0].description}`);
      if (weather.weather[0].main === "Thunderstorm")
        alerts.push(`⛈️ Storm Alert: ${weather.weather[0].description}`);
    }

    return {
      city: weather.name,
      temp: weather.main.temp,
      description: weather.weather[0].description,
      alerts,
      wind: weather.wind || { speed: 0 },
    };
  } catch (error) {
    console.error("Weather API error:", error?.response?.data || error.message);
    return null;
  }
}

// Gemini AI for crop advice
const genAI = new GoogleGenerativeAI(process.env.GoogleAPIKey);

async function getCropAdviceAI(weather, langCode = "en") {
  try {
    const prompt = `
You are an expert agricultural advisor. You can suggest crops, pesticides, and fertilizers based on weather conditions. Provide just the response in the specified language without any additional commentary. Provide the answer directly in the requested language without mentioning the language.
Given this weather:
Temperature: ${weather.temp}°C,
Conditions: ${weather.description},
Wind speed: ${weather.wind.speed} m/s.

Suggest 3 suitable crops and pesticides and fertilizers recommendation for farmers.
Keep the advice short and within 1400 characters.

Respond in ${langCode === "en" ? "English" : langCode === "hi" ? "Hindi" : "Marathi"}.
    `;
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) {
    console.error("Gemini error:", err);
    return "Could not fetch AI advice right now.";
  }
}

// Send WhatsApp message
async function sendWhatsAppMessage(to, message) {
  try {
    await client.messages.create({
      body: message,
      from: "whatsapp:+14155238886",
      to: `whatsapp:${to}`,
    });
  } catch (error) {
    console.error("WhatsApp send error:", error?.message || error);
  }
}

// Translate text using Gemini
async function translateText(text, langCode) {
  // langCode is 'en'|'hi'|'mr'
  if (langCode === "en") return text;
  const prompt = `Translate the following text to ${langCode}:\n\n${text} do not provide any extra commentary, just the translation. `;
  const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// Helper: translate + send + end response
async function replyAndEnd(phone, text, res) {
  const userLang = userPreferences.get(phone)?.language || "en";
  let out = text;
  if (userLang !== "en") {
    try {
      out = await translateText(text, userLang);
    } catch (e) {
      console.error("Translation failed, sending English fallback", e);
    }
  }
  await sendWhatsAppMessage(phone, out);
  return res.status(200).send("OK");
}

// Send daily activity reminder
async function sendActivityReminder(phone) {
  const lang = userPreferences.get(phone)?.language || "en";
  let message = "⏰ Reminder: Please log today's farm activities (sprays, irrigation, fertilizers) in the PWA.";
  if (lang !== "en") message = await translateText(message, lang);
  await sendWhatsAppMessage(phone, message);
}

// Handle incoming WhatsApp messages
app.post("/webhook", async (req, res) => {
  const incomingRaw = req.body.Body || "";
  const incomingMsg = incomingRaw.toString().trim().toLowerCase();
  const from = (req.body.From || "").replace("whatsapp:", "").trim();

  if (!from) return res.status(400).send("Missing sender");

  // If first time we see this user, send welcome & language selection and stop.
  if (!userPreferences.has(from)) {
    userPreferences.set(from, { language: "en" }); // default
    const welcome = "👋 Welcome! Choose your language by sending:\n1. Hindi\n2. Marathi\n3. English\n\nThen send 'subscribe Mumbai' to start.";
    await sendWhatsAppMessage(from, welcome);
    return res.status(200).send("OK");
  }

  // the get status command 
  if (incomingMsg === 'status' || incomingMsg === '/status' || incomingMsg === 'my status') {
  const city = userLocations.get(from) || 'Not subscribed';
  const langCode = userPreferences.get(from)?.language || 'en';

  const text = `📋 *Your Settings*\n\n` +
               `🌍 City: ${city}\n` +
               `🗣️ Language: ${langCode}\n` +
               `🔔 Subscribed: ${subscribers.has(from) ? 'Yes' : 'No'}\n\n` +
               `You can type "subscribe [city]" to change city or "1/2/3" to change language.`;

  return await replyAndEnd(from, text, res);
}

  // LANGUAGE SELECTION (priority)
  if (incomingMsg === "1" || incomingMsg === "2" || incomingMsg === "3") {
    let code = "en";
    let langName = "English";
    if (incomingMsg === "1") { code = "hi"; langName = "Hindi"; }
    else if (incomingMsg === "2") { code = "mr"; langName = "Marathi"; }
    else if (incomingMsg === "3") { code = "en"; langName = "English"; }

    userPreferences.set(from, { language: code });
    return await replyAndEnd(from, `✅ Language set to ${langName}.`, res);
  }

  // LOGGING FEATURES
  if (incomingMsg.startsWith("log ")) {
    // "log sprayed tomatoes"
    const activity = incomingMsg.slice(4).trim(); // removes "log "
    if (activity.length === 0) {
      return await replyAndEnd(from, "⚠️ Please provide an activity to log. Example: 'log sprayed tomatoes'", res);
    }
    if (!userActivities.has(from)) userActivities.set(from, []);
    userActivities.get(from).push({ activity, date: new Date().toISOString() });
    return await replyAndEnd(from, `✅ Got it! Logged your activity: "${activity}"`, res);
  }

  if (incomingMsg === "view log") {
    const logs = userActivities.get(from) || [];
    if (logs.length === 0) return await replyAndEnd(from, "No activities logged yet.", res);
    // ...existing code...
const text = "📋 Your logged activities:\n" + logs
  .map(l => `🗓️ ${new Date(l.date).toLocaleString()}: ${l.activity}`)
  .join("\n");
// ...existing code...
    return await replyAndEnd(from, text, res);
  }

  if (incomingMsg === "clear log") {
    userActivities.delete(from);
    return await replyAndEnd(from, "✅ Your activity logs have been cleared.", res);
  }

  // SUBSCRIBE / UNSUBSCRIBE
  if (incomingMsg.startsWith("subscribe")) {
    const city = incomingMsg.replace("subscribe", "").trim();
    if (!city) return await replyAndEnd(from, 'Please specify a city. Example: "subscribe Mumbai"', res);
    subscribers.add(from);
    userLocations.set(from, city);
    return await replyAndEnd(
      from,
      `✅ Subscribed to weather alerts for ${city}!\n\nYou'll receive alerts for:\n• Extreme temperatures\n• Heavy rain/storms\n• Strong winds\n\nSend "unsubscribe" to stop alerts.`,
      res
    );
  }

  if (incomingMsg === "unsubscribe") {
    subscribers.delete(from);
    userLocations.delete(from);
    return await replyAndEnd(from, "❌ Unsubscribed from weather alerts.", res);
  }

  // WEATHER / AI ADVICE
  if (incomingMsg.startsWith("weather")) {
    const city = incomingMsg.replace("weather", "").trim() || userLocations.get(from);
    if (!city) return await replyAndEnd(from, 'Please specify a city. Example: "weather Mumbai"', res);

    const weather = await getWeather(city);
    if (!weather) return await replyAndEnd(from, "Sorry, could not fetch weather data. Please check the city name.", res);

    let response = `🌤️ Current weather in ${weather.city}:\n\n🌡️ Temperature: ${weather.temp}°C\n☁️ Conditions: ${weather.description}`;
    if (weather.alerts.length > 0) response += `\n\n⚠️ ALERTS:\n${weather.alerts.join("\n")}`;

    const userLang = userPreferences.get(from)?.language || "en";
    const aiAdvice = await getCropAdviceAI(weather, userLang);
    if (aiAdvice && aiAdvice.length > 0) response += `\n\n🌱 Farming Tips:\n${aiAdvice}`;

    return await replyAndEnd(from, response, res);
  }

  // HELP / DEFAULT
  const helpText = `🤖 Weather Alert Bot Commands:

📍 *subscribe [city]* - Get weather alerts
❌ *unsubscribe* - Stop alerts
🌤️ *weather [city]* - Current weather
📝 *log [activity]* - Log farm activity
📋 *log view* - View logged activities
🗑️ *log clear* - Clear all logged activities
❓ *help* - Show this message

Example: "subscribe Mumbai"`;

  return await replyAndEnd(from, helpText, res);
});

// CRON JOBS

// Weather alerts every 3 hours
cron.schedule("* * * *", async () => {
  console.log("Checking weather alerts...");
  for (const [phone, city] of userLocations) {
    if (subscribers.has(phone)) {
      const weather = await getWeather(city);
      if (weather && weather.alerts.length > 0) {
        const alertMessage = `🚨 WEATHER ALERT - ${weather.city}\n\n${weather.alerts.join("\n")}\n\nStay safe! 🙏`;
        await sendWhatsAppMessage(phone, alertMessage);
        await new Promise(resolve => setTimeout(resolve, 1000)); // rate-limit safety
      }
    }
  }
});

// Daily activity reminders at 8 AM (server timezone)
cron.schedule("0 8 * * *", async () => {
  console.log("Sending daily activity reminders...");
  for (const phone of subscribers) {
    await sendActivityReminder(phone);
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
});

// Health check
app.get("/", (req, res) => {
  res.send("WhatsApp Weather Bot is running!");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
