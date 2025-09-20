import express from "express";
import twilio from "twilio";
import axios from "axios";
import cron from "node-cron";
import fs from "fs";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { processVoiceRequest } from "./voicePipeline.js";

dotenv.config();
const app = express();
app.use(express.urlencoded({ extended: false }));
app.use('/responses', express.static('responses')); // serve audio files

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const WEATHER_API_KEY = process.env.WEATHER_API_KEY;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const subscribers = new Set();
const userLocations = new Map();
const userPreferences = new Map();
const genAI = new GoogleGenerativeAI(process.env.GoogleAPIKey);

// ---------------- Weather functions -----------------
async function getWeather(city) {
  try {
    const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${WEATHER_API_KEY}&units=metric`);
    const weather = res.data;
    const alerts = [];
    if (weather.main.temp > 35) alerts.push(`🌡️ Heat Alert: ${weather.main.temp}°C`);
    if (weather.main.temp < 5) alerts.push(`❄️ Cold Alert: ${weather.main.temp}°C`);
    if (weather.wind.speed > 10) alerts.push(`💨 Wind Alert: ${weather.wind.speed} m/s`);
    if (weather.weather[0].main === 'Rain') alerts.push(`🌧️ Rain Alert: ${weather.weather[0].description}`);
    if (weather.weather[0].main === 'Thunderstorm') alerts.push(`⛈️ Storm Alert: ${weather.weather[0].description}`);
    return { city: weather.name, temp: weather.main.temp, description: weather.weather[0].description, alerts, wind: weather.wind };
  } catch (err) { console.error(err); return null; }
}

async function getCropAdviceAI(weather) {
  try {
    const prompt = `Weather:
Temp: ${weather.temp}°C
Conditions: ${weather.description}
Wind: ${weather.wind.speed} m/s

Suggest 3 suitable crops, 1 pesticide, 1 fertilizer. Keep under 1400 chars.`;
    const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    return result.response.text();
  } catch (err) { console.error(err); return "Could not fetch AI advice."; }
}

async function sendWhatsAppMessage(to, message) {
  try { await client.messages.create({ body: message, from: 'whatsapp:+14155238886', to: `whatsapp:${to}` }); }
  catch (err) { console.error('WhatsApp send error:', err); }
}

// ----------------- Webhook -----------------------
app.post('/webhook', async (req, res) => {
  const incomingMsg = (req.body.Body || '').toLowerCase().trim();
  const from = req.body.From.replace('whatsapp:', '');

  // ---------- Handle voice ----------
  const numMedia = parseInt(req.body.NumMedia || '0', 10);
  if (numMedia > 0 && req.body.MediaContentType0.startsWith('audio')) {
    const mediaUrl = req.body.MediaUrl0;
    try {
      const audioRes = await axios.get(mediaUrl, {
        responseType: 'arraybuffer',
        auth: { username: TWILIO_ACCOUNT_SID, password: TWILIO_AUTH_TOKEN },
      });
      const incomingAudioBuffer = Buffer.from(audioRes.data);
      const audioResponseBuffer = await processVoiceRequest(incomingAudioBuffer);
      const fileName = `${Date.now()}_response.mp3`;
      fs.writeFileSync(`responses/${fileName}`, audioResponseBuffer);

      await client.messages.create({
        from: 'whatsapp:+14155238886',
        to: `whatsapp:${from}`,
        mediaUrl: `https://YOUR_DOMAIN/responses/${fileName}` // replace with your domain
      });
      return res.status(200).send('OK');
    } catch (err) {
      console.error('Audio handling error:', err);
      await sendWhatsAppMessage(from, 'Sorry, could not process your audio.');
      return res.status(200).send('OK');
    }
  }

  // ---------- Handle text ----------
  let response = '';
  if (!userPreferences.has(from)) {
    userPreferences.set(from, { language: 'en' });
    await sendWhatsAppMessage(from, "👋 Welcome! Send 'subscribe [city]' to start.");
  }

  if (incomingMsg.startsWith('subscribe')) {
    const city = incomingMsg.replace('subscribe', '').trim();
    if (city) { subscribers.add(from); userLocations.set(from, city); response = `✅ Subscribed to ${city}!`; }
    else response = 'Specify city. Example: "subscribe Mumbai"';
  } else if (incomingMsg === 'unsubscribe') {
    subscribers.delete(from); userLocations.delete(from); response = '❌ Unsubscribed.';
  } else if (incomingMsg.startsWith('weather')) {
    const city = incomingMsg.replace('weather', '').trim() || userLocations.get(from);
    if (city) {
      const weather = await getWeather(city);
      if (weather) {
        response = `🌤️ Weather in ${weather.city}:\nTemp: ${weather.temp}°C\nConditions: ${weather.description}`;
        if (weather.alerts.length) response += `\n⚠️ Alerts:\n${weather.alerts.join('\n')}`;
        const aiAdvice = await getCropAdviceAI(weather);
        if (aiAdvice) response += `\n🌱 Farming Tips:\n${aiAdvice}`;
      } else response = 'Could not fetch weather.';
    } else response = 'Specify city. Example: "weather Mumbai"';
  } else response = `Commands:\nsubscribe [city]\nunsubscribe\nweather [city]`;

  await sendWhatsAppMessage(from, response);
  res.status(200).send('OK');
});

// ---------------- Cron ----------------
cron.schedule('0 */3 * * *', async () => {
  for (const [phone, city] of userLocations) {
    if (subscribers.has(phone)) {
      const weather = await getWeather(city);
      if (weather?.alerts?.length) {
        const msg = `🚨 WEATHER ALERT - ${weather.city}\n${weather.alerts.join('\n')}`;
        await sendWhatsAppMessage(phone, msg);
        await new Promise(r => setTimeout(r, 1000));
      }
    }
  }
});

// Health check
app.get('/', (_, res) => res.send('WhatsApp Weather Bot running!'));
app.listen(process.env.PORT || 3000, () => console.log('Server started.'));
